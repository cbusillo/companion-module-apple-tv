"""Prepared pyatv close-app reference; separate Node test pairing, never installed credentials."""

import argparse
import asyncio
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import stat
import sys
from collections.abc import Awaitable, Callable, Sequence
from typing import Any

import pyatv
from pyatv.auth.hap_pairing import HapCredentials
from pyatv.const import Protocol

# This diagnostic invokes the existing worker's action mapping unchanged.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from bridge.controller import PyATVController


def load_pairing(path: Path) -> tuple[str, str]:
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "r") as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 8192:
            raise ValueError("Expected a private separate test pairing")
        data = json.load(source)
    if data.get("version") != 1 or not isinstance(data.get("deviceId"), str) or not data["deviceId"]:
        raise ValueError("Invalid test pairing")
    keys = data["credentials"]
    for name in ("serverId", "clientId"):
        if not isinstance(keys.get(name), str) or not keys[name]:
            raise ValueError("Invalid test pairing")
    public_key = bytes.fromhex(keys["serverLTPK"])
    private_key = bytes.fromhex(keys["clientLTSK"])
    if len(public_key) != 32 or len(private_key) != 32:
        raise ValueError("Invalid test pairing")
    return data["deviceId"], str(HapCredentials(
        public_key, private_key, keys["serverId"].encode(), keys["clientId"].encode()
    ))


def companion_target(devices: Sequence[Any], identifier: str) -> tuple[str, str]:
    matches = [device for device in devices if identifier in device.all_identifiers]
    if len(matches) != 1:
        raise RuntimeError("No unique target discovered")
    service = matches[0].get_service(Protocol.Companion)
    if service is None or not service.identifier:
        raise RuntimeError("Target has no identified Companion service")
    return str(matches[0].address), service.identifier


async def close_sequence(
    controller: Any, app_name: str, record: Callable[[dict[str, Any]], None],
    pause: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> None:
    apps = [app for app in await controller.atv.apps.app_list() if app.name == app_name]
    if len(apps) != 1:
        raise RuntimeError("App name must match exactly one app")
    snapshot = await controller.handle({"operation": "snapshot"})
    if snapshot["values"]["power"] != "On":
        raise RuntimeError("Start with the TV awake")
    for stage, action in (
        ("open selected app", {"action": "launchApp", "appId": apps[0].identifier}),
        ("App Switcher", {"action": "appSwitcher"}),
        ("close focused app", {"action": "swipe", "direction": "up"}),
    ):
        if not controller.connected:
            raise RuntimeError("Connection lost")
        record({"stage": stage, "result": "sending"})
        await controller.handle({"operation": "action", "action": action})
        record({"stage": stage, "result": "dispatched; physical result unverified"})
        await pause(5)
        if not controller.connected:
            raise RuntimeError("Connection lost")


async def run(args: argparse.Namespace) -> None:
    controller = PyATVController()
    events: list[dict[str, Any]] = []
    completed = False

    def record(event: dict[str, Any]) -> None:
        event = {**event, "at": datetime.now(timezone.utc).isoformat()}
        events.append(event)
        print(json.dumps(event), flush=True)

    with os.fdopen(os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as report:
        try:
            async with asyncio.timeout(60):
                identifier, credentials = load_pairing(args.credentials)
                # Node records the AirPlay device ID; the worker scans by the
                # Companion rpMRtID. Resolve both advertisements on the same TV.
                devices = await pyatv.scan(asyncio.get_running_loop(), identifier=identifier,
                                           protocol={Protocol.AirPlay, Protocol.Companion})
                host, companion_id = companion_target(devices, identifier)
                await controller.handle({"operation": "connect", "secret": {
                    "host": host, "identifier": companion_id, "credentials": credentials,
                }})
                await close_sequence(controller, args.app, record)
                completed = True
        finally:
            try:
                await asyncio.wait_for(controller.close(), 5)
            finally:
                json.dump({"client": "pyatv reference", "completed": completed,
                           "physicalResult": "unverified; requires owner observation", "events": events}, report, indent=2)
                report.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", default="YouTube")
    parser.add_argument("--credentials", type=Path)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--run", action="store_true")
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({"mode": "offline preview", "client": "pyatv reference", "plan": [
            f"Open {args.app}", "Wait five seconds", "Open App Switcher", "Wait five seconds",
            "Swipe up to close the focused app", "Wait five seconds, then stop",
        ]}))
        return
    if not args.credentials or not args.report or not args.credentials.is_absolute() or not args.report.is_absolute():
        parser.error("--run requires absolute separate --credentials and new --report paths")
    logging.disable(logging.CRITICAL)
    try:
        asyncio.run(run(args))
    except (Exception, KeyboardInterrupt):
        # Never print provider errors, pairing identifiers, or credential values.
        print("Reference test stopped; no action was retried. Check the private report if created.", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
