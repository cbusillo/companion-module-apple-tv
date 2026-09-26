"""Independent pyatv wire peer for the Node harness; synthetic keys, loopback only."""

import asyncio
import logging
from pathlib import Path
import sys
from typing import Any, TypedDict

from pyatv.auth.server_auth import PIN_CODE
from pyatv.protocols.companion.connection import FrameType
from pyatv.protocols.companion.server_auth import CompanionServerAuth
from pyatv.support import chacha20, opack


class PeerState(TypedDict):
    right_down: int
    drop_next_right: bool
    swipes: int


class Peer(CompanionServerAuth, asyncio.Protocol):
    def __init__(self, failures: list[Exception], state: PeerState) -> None:
        super().__init__("Synthetic Node Test Peer")
        self.failures = failures
        self.buffer = b""
        self.cipher = None
        self.transport = None
        self.session_id = None
        self.state = state
        self.volume = 0.4
        self.power = 3
        self.buttons = set()
        self.touch_started = False
        self.touch_active = False
        self.touch_time = -1

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        assert isinstance(transport, asyncio.Transport)
        self.transport = transport

    def enable_encryption(self, output_key: bytes, input_key: bytes) -> None:
        self.cipher = chacha20.Chacha20Cipher(output_key, input_key, nonce_length=12)

    def send_to_client(self, frame_type: FrameType, data: object) -> None:
        payload = opack.pack(data)
        size = len(payload) + (16 if self.cipher else 0)
        header = bytes([frame_type.value]) + size.to_bytes(3, "big")
        if self.cipher:
            payload = self.cipher.encrypt(payload, aad=header)
        self.transport.write(header + payload)

    def data_received(self, data: bytes) -> None:
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
                assert not remaining and isinstance(message, dict)
                if frame in (FrameType.PS_Start, FrameType.PS_Next, FrameType.PV_Start, FrameType.PV_Next):
                    self.handle_auth_frame(frame, message)
                else:
                    assert self.cipher is not None
                    self.command(message)
        except Exception as error:
            self.failures.append(error)
            print(f"Synthetic peer: {type(error).__name__}: {error}", file=sys.stderr)
            self.transport.abort()

    def command(self, message: dict[str, Any]) -> None:
        # The live TV never acknowledges transaction zero.
        assert isinstance(message.get("_x"), int) and message["_x"] > 0
        identifier = message["_i"]
        args = message["_c"]
        if message["_t"] == 1:
            if identifier == "_interest":
                for topic in args.get("_regEvents", []):
                    content = {"_mcF": 0x70F} if topic == "_iMC" else {"state": self.power}
                    self.send_to_client(FrameType.E_OPACK, {"_i": topic, "_x": message["_x"], "_t": 1, "_c": content})
            elif identifier == "_hidT":
                assert self.touch_started
                assert 0 <= args["_cx"] <= 1000 and 0 <= args["_cy"] <= 1000
                assert args["_ns"] > self.touch_time
                self.touch_time = args["_ns"]
                if args["_tPh"] == 1:
                    assert not self.touch_active
                    self.touch_active = True
                elif args["_tPh"] == 4:
                    assert self.touch_active
                    self.touch_active = False
                    self.state["swipes"] += 1
                else:
                    assert args["_tPh"] == 3 and self.touch_active
            else:
                raise AssertionError("Unexpected event")
            return
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
            content = {"state": self.power}
        elif identifier == "_hidC":
            button, phase = args["_hidC"], args["_hBtS"]
            if phase == 1:
                if button == 4:
                    self.state["right_down"] += 1
                    if self.state["drop_next_right"]:
                        self.state["drop_next_right"] = False
                        self.transport.abort()
                        return
                assert button not in self.buttons
                self.buttons.add(button)
            elif button in (12, 13):
                assert phase == 2
                self.power = 1 if button == 12 else 3
            else:
                assert phase == 2 and button in self.buttons
                self.buttons.remove(button)
        elif identifier == "_touchStart":
            assert isinstance(args["_width"], float) and args["_width"] == 1000
            assert isinstance(args["_height"], float) and args["_height"] == 1000
            self.touch_started = True
        elif identifier == "_touchStop":
            assert not self.touch_active
            self.touch_started = False
        elif identifier == "_mcc":
            command = args["_mcc"]
            if command == 5:
                # An event may share the pending request ID without being its reply.
                self.send_to_client(FrameType.E_OPACK, {"_i": "_iMC", "_x": message["_x"], "_t": 1, "_c": {"_mcF": 0x70F}})
                content = {"_vol": self.volume}
            elif command == 6:
                assert isinstance(args["_vol"], float) and 0 <= args["_vol"] <= 1
                self.volume = args["_vol"]
            elif command == 7:
                assert isinstance(args["_skpS"], float) and 0 < abs(args["_skpS"]) <= 60
            else:
                assert command in (1, 2, 3, 4)
        elif identifier == "_launchApp":
            assert args["_bundleID"] in ("com.example.one", "com.example.two")
        elif identifier not in ("_systemInfo", "TVRCSessionStart"):
            raise AssertionError("Unexpected command")
        self.send_to_client(FrameType.E_OPACK, {
            "_i": identifier, "_x": message["_x"], "_t": 3, "_c": content,
        })


async def main() -> None:
    failures: list[Exception] = []
    state: PeerState = {"right_down": 0, "drop_next_right": False, "swipes": 0}
    server = await asyncio.get_running_loop().create_server(lambda: Peer(failures, state), "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    root = Path(__file__).resolve().parents[2]
    process = None
    try:
        for fixture in ("node-peer-client.mjs", "node-reconnect-peer-client.mjs"):
            state["drop_next_right"] = fixture == "node-reconnect-peer-client.mjs"
            process = await asyncio.create_subprocess_exec("node", str(root / "tests/fixtures" / fixture), str(port), str(PIN_CODE))
            await asyncio.wait_for(process.wait(), 30)
            if process.returncode or failures:
                raise RuntimeError("Independent loopback protocol test failed")
        assert state["right_down"] == 1, "A failed action was replayed"
        assert state["swipes"] == 4, "Missing complete swipe gestures"
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        server.close()
        await server.wait_closed()


if __name__ == "__main__":
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(main())
    except Exception as failure:
        print(type(failure).__name__, "in independent synthetic peer", file=sys.stderr)
        sys.exit(1)
