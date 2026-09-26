"""Independent pyatv wire peer for the Node harness; synthetic keys, loopback only."""

import asyncio
import logging
from pathlib import Path
import sys

from pyatv.auth.server_auth import PIN_CODE
from pyatv.protocols.companion.connection import FrameType
from pyatv.protocols.companion.server_auth import CompanionServerAuth
from pyatv.support import chacha20, opack


class Peer(CompanionServerAuth, asyncio.Protocol):
    def __init__(self, failures):
        super().__init__("Synthetic Node Test Peer")
        self.failures = failures
        self.buffer = b""
        self.cipher = None
        self.transport = None
        self.session_id = None

    def connection_made(self, transport):
        self.transport = transport

    def enable_encryption(self, output_key, input_key):
        self.cipher = chacha20.Chacha20Cipher(output_key, input_key, nonce_length=12)

    def send_to_client(self, frame_type, data):
        payload = opack.pack(data)
        size = len(payload) + (16 if self.cipher else 0)
        header = bytes([frame_type.value]) + size.to_bytes(3, "big")
        if self.cipher:
            payload = self.cipher.encrypt(payload, aad=header)
        self.transport.write(header + payload)

    def data_received(self, data):
        self.buffer += data
        try:
            while len(self.buffer) >= 4:
                size = 4 + int.from_bytes(self.buffer[1:4], "big")
                if len(self.buffer) < size:
                    break
                header, payload = self.buffer[:4], self.buffer[4:size]
                self.buffer = self.buffer[size:]
                frame = FrameType(header[0])
                if self.cipher:
                    payload = self.cipher.decrypt(payload, aad=header)
                message, remaining = opack.unpack(payload)
                assert not remaining
                if frame in (FrameType.PS_Start, FrameType.PS_Next, FrameType.PV_Start, FrameType.PV_Next):
                    self.handle_auth_frame(frame, message)
                else:
                    assert self.cipher is not None
                    self.command(message)
        except Exception as error:
            self.failures.append(error)
            print(f"Synthetic peer: {type(error).__name__}: {error}", file=sys.stderr)
            self.transport.abort()

    def command(self, message):
        # The live TV never acknowledges transaction zero.
        assert isinstance(message.get("_x"), int) and message["_x"] > 0
        identifier = message["_i"]
        content = {}
        if identifier == "_sessionStart":
            self.session_id = (0xFEDCBA98 << 32) | message["_c"]["_sid"]
            content = {"_sid": 0xFEDCBA98}
        elif identifier == "_sessionStop":
            assert message["_c"]["_sid"] == self.session_id
            self.session_id = None
        elif identifier == "FetchLaunchableApplicationsEvent":
            content = {"com.example.one": "Player", "com.example.two": "Player"}
        elif identifier == "FetchAttentionState":
            content = {"state": 3}
        elif identifier not in ("_systemInfo", "TVRCSessionStart"):
            raise AssertionError("Read-only test sent an unexpected command")
        self.send_to_client(FrameType.E_OPACK, {
            "_i": identifier, "_x": message["_x"], "_t": 3, "_c": content,
        })


async def main():
    failures = []
    server = await asyncio.get_running_loop().create_server(lambda: Peer(failures), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    root = Path(__file__).resolve().parents[2]
    process = await asyncio.create_subprocess_exec(
        "node", str(root / "tests/fixtures/node-peer-client.mjs"), str(port), str(PIN_CODE),
    )
    try:
        await asyncio.wait_for(process.wait(), 30)
        if process.returncode or failures:
            raise RuntimeError("Independent loopback handshake failed")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(main())
    except Exception as error:
        print(type(error).__name__, "in independent synthetic peer", file=sys.stderr)
        sys.exit(1)
