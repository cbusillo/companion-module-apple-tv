"""Interactive, explicit-target provisioning. Never used by the module worker."""
import argparse
import asyncio
import getpass
import json
import logging
import os
from pathlib import Path
import stat
import sys
import tempfile

import pyatv
from pyatv.const import Protocol
from pyatv.storage.memory_storage import MemoryStorage


def prepare_destination(output):
    output = Path(output).expanduser().absolute()
    output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = output.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("Use a private directory owned by your account (mode 0700)")
    if os.path.lexists(output):
        raise ValueError("Destination already exists; choose a new filename")
    return output


def save_credentials(output, value):
    output = prepare_destination(output)
    fd, temporary = tempfile.mkstemp(prefix=".pair-", dir=output.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            os.fchmod(handle.fileno(), 0o600)
            json.dump(value, handle)
            handle.flush()
            os.fsync(handle.fileno())
        # Publish a complete file without ever replacing an existing destination.
        os.link(temporary, output)
        directory = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        os.unlink(temporary)


async def provision(host, identifier, output, read_pin):
    output = prepare_destination(output)  # Fail before initiating pairing.
    storage = MemoryStorage()
    configs = await pyatv.scan(asyncio.get_running_loop(), hosts=[host],
                              identifier=identifier, protocol=Protocol.Companion, storage=storage)
    if len(configs) != 1 or configs[0].identifier != identifier:
        raise ValueError("Exact target was not uniquely discovered")
    config = configs[0]
    pairing = await pyatv.pair(config, Protocol.Companion, asyncio.get_running_loop(),
                               storage=storage, name="Companion Apple TV")
    try:
        await asyncio.wait_for(pairing.begin(), 15)
        pin = await asyncio.to_thread(read_pin)
        if len(pin) != 4 or not pin.isascii() or not pin.isdigit():
            raise ValueError("Enter the four-digit PIN shown on the selected Apple TV")
        pairing.pin(int(pin))
        await asyncio.wait_for(pairing.finish(), 15)
        credentials = pairing.service.credentials
        if not pairing.has_paired or not credentials:
            raise ValueError("Pairing was not confirmed")
    finally:
        await pairing.close()
    if not config.set_credentials(Protocol.Companion, credentials):
        raise ValueError("Credentials could not be applied")
    atv = await asyncio.wait_for(pyatv.connect(config, asyncio.get_running_loop(),
                                    protocol=Protocol.Companion, storage=storage), 15)
    try:
        # A genuine read-only protocol round trip before publishing credentials.
        await asyncio.wait_for(atv.apps.app_list(), 5)
        save_credentials(output, {"host": str(config.address), "identifier": identifier,
                                  "credentials": credentials})
    finally:
        tasks = atv.close()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description="Pair one explicitly selected Apple TV; no controls are sent")
    parser.add_argument("--host", required=True)
    parser.add_argument("--identifier", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error("Run in an interactive terminal; PINs are never accepted as arguments or piped input")
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(provision(args.host, args.identifier, args.output,
                              lambda: getpass.getpass("Apple TV pairing PIN: ")))
    except (Exception, KeyboardInterrupt):
        print("Setup did not complete. No credentials are printed. Check the target and destination; retry with a new filename if one was saved.", file=sys.stderr)
        return 1
    print("Credentials verified and saved. The Companion connection remains disabled until you enable it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
