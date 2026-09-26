"""Compare Node gestures with the locked pyatv implementation, without a TV."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping
from unittest.mock import patch

from pyatv.protocols.companion import api


async def check_gestures(root: Path) -> None:
    cases = []
    paths = {
        "up": (500, 900, 500, 100),
        "down": (500, 100, 500, 900),
        "left": (900, 500, 100, 500),
        "right": (100, 500, 900, 500),
    }
    for direction, coordinates in paths.items():
        for schedule in ([16], [18, 22, 17, 30, 21], [120]):
            clock = 0
            sleeps = []
            events = []

            def now() -> int:
                nonlocal clock
                value = clock
                clock += 1000
                return value

            async def pause(seconds: float) -> None:
                nonlocal clock
                clock += schedule[len(sleeps) % len(schedule)] * 1_000_000
                sleeps.append(seconds * 1000)

            async def command(_identifier: str, _content: Mapping[str, Any]) -> dict[str, Any]:
                nonlocal clock
                clock += 3_000_000  # Simulated touch-start acknowledgement latency.
                return {}

            async def event(identifier: str, content: Mapping[str, Any]) -> None:
                events.append({"id": identifier, "content": content})

            # Only transport and clock are replaced; pyatv generates every point.
            reference = object.__new__(api.CompanionAPI)
            reference._send_command = command
            reference._send_event = event
            with patch.object(api, "time", SimpleNamespace(time_ns=now)), patch.object(
                api, "asyncio", SimpleNamespace(sleep=pause)
            ):
                await reference._touch_start()
                await reference.swipe(*coordinates, 100)
            cases.append({"direction": direction, "schedule": schedule, "events": events, "sleeps": sleeps})

    process = await asyncio.create_subprocess_exec(
        "node", str(root / "tests/fixtures/node-gesture-parity.mjs"), stdin=asyncio.subprocess.PIPE
    )
    try:
        await asyncio.wait_for(process.communicate(json.dumps(cases).encode()), 10)
        if process.returncode:
            raise RuntimeError("Node swipe differs from the independent pyatv gesture trace")
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


if __name__ == "__main__":
    asyncio.run(check_gestures(Path(__file__).resolve().parents[2]))
