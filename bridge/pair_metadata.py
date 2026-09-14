"""Add an explicitly approved metadata pairing without replacing remote credentials."""
import argparse
import asyncio
import getpass
import json
import logging
import os
from pathlib import Path
import stat
import sys

import pyatv
from pyatv.const import Protocol
from pyatv.storage.memory_storage import MemoryStorage
from pair import prepare_destination, save_credentials


def load_source(path):
    path = Path(path).expanduser().absolute()
    parent = path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or parent.st_mode & 0o077:
        raise ValueError("Private credential directory required")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError("Private credential file required")
        value = json.loads(handle.read(8193))
    if not all(isinstance(value.get(key), str) and value[key] for key in ("host", "identifier", "credentials")):
        raise ValueError("Remote credential fields required")
    return value


async def provision(source, output, read_pin):
    secret = load_source(source)
    output = prepare_destination(output)
    storage = MemoryStorage()
    configs = await pyatv.scan(asyncio.get_running_loop(), hosts=[secret['host']],
                              identifier=secret['identifier'], storage=storage)
    if len(configs) != 1 or secret['identifier'] not in configs[0].all_identifiers:
        raise ValueError("Exact target was not uniquely discovered")
    config = configs[0]
    pairing = await pyatv.pair(config, Protocol.AirPlay, asyncio.get_running_loop(),
                               storage=storage, name="Companion Now Playing")
    try:
        await asyncio.wait_for(pairing.begin(), 15)
        pin = await asyncio.to_thread(read_pin)
        if len(pin) != 4 or not pin.isascii() or not pin.isdigit():
            raise ValueError("Four-digit PIN required")
        pairing.pin(int(pin))
        await asyncio.wait_for(pairing.finish(), 15)
        credentials = pairing.service.credentials
        if not pairing.has_paired or not credentials:
            raise ValueError("Pairing not confirmed")
    finally:
        await pairing.close()
    if not config.set_credentials(Protocol.AirPlay, credentials):
        raise ValueError("Metadata credentials unavailable")
    atv = await asyncio.wait_for(pyatv.connect(config, asyncio.get_running_loop(),
                                    protocol=Protocol.AirPlay, storage=storage), 15)
    try:
        await asyncio.wait_for(atv.metadata.playing(), 5)
        save_credentials(output, {**secret, 'airplay_credentials': credentials})
    finally:
        await asyncio.gather(*atv.close(), return_exceptions=True)


def main():
    parser = argparse.ArgumentParser(description="Add metadata pairing for the existing exact Apple TV target")
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('Use an interactive terminal; PIN is never an argument')
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(provision(args.source, args.output, lambda: getpass.getpass('Apple TV metadata PIN: ')))
    except (Exception, KeyboardInterrupt):
        print('Metadata setup did not complete. Existing remote credentials are unchanged.', file=sys.stderr)
        return 1
    print('Metadata pairing verified and saved. Existing remote credentials are unchanged.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
