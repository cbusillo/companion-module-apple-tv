import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from typing import Any
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "experiments/node-library/close_baseline.py"
spec = importlib.util.spec_from_file_location("close_baseline", SCRIPT)
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


class BaselineTests(unittest.IsolatedAsyncioTestCase):
    def test_target_maps_the_saved_airplay_identity_to_its_companion_service(self) -> None:
        device = SimpleNamespace(
            all_identifiers=["saved-airplay-id", "companion-id"], address="127.0.0.1",
            get_service=lambda _protocol: SimpleNamespace(identifier="companion-id"),
        )
        self.assertEqual(baseline.companion_target([device], "saved-airplay-id"), ("127.0.0.1", "companion-id"))
        for candidates in ([], [device, device]):
            with self.assertRaises(RuntimeError):
                baseline.companion_target(candidates, "saved-airplay-id")
        with self.assertRaises(RuntimeError):
            baseline.companion_target([device], "unrelated-id")

    def test_target_without_companion_identity_is_rejected(self) -> None:
        device = SimpleNamespace(all_identifiers=["saved-airplay-id"], get_service=lambda _protocol: None)
        with self.assertRaises(RuntimeError):
            baseline.companion_target([device], "saved-airplay-id")

    def fixture(self) -> tuple[Any, list[dict[str, Any]], list[float], Any]:
        actions = []
        gaps = []

        async def apps() -> list[SimpleNamespace]:
            return [SimpleNamespace(name="Player", identifier="com.example.player")]

        async def handle(operation: dict[str, Any]) -> dict[str, Any] | None:
            if operation["operation"] == "snapshot":
                return {"values": {"power": "On"}}
            actions.append(operation["action"])

        async def pause(seconds: float) -> None:
            gaps.append(seconds)

        controller = SimpleNamespace(connected=True, atv=SimpleNamespace(apps=SimpleNamespace(app_list=apps)), handle=handle)
        return controller, actions, gaps, pause

    async def test_sequence_uses_existing_worker_actions_and_five_second_gaps(self) -> None:
        controller, actions, gaps, pause = self.fixture()
        await baseline.close_sequence(controller, "Player", lambda _event: None, pause)
        self.assertEqual(actions, [
            {"action": "launchApp", "appId": "com.example.player"},
            {"action": "appSwitcher"}, {"action": "swipe", "direction": "up"},
        ])
        self.assertEqual(gaps, [5, 5, 5])

    async def test_missing_app_stops_before_controls(self) -> None:
        controller, actions, _, pause = self.fixture()
        with self.assertRaises(RuntimeError):
            await baseline.close_sequence(controller, "Missing", lambda _event: None, pause)
        self.assertEqual(actions, [])

    async def test_unknown_power_stops_before_controls(self) -> None:
        controller, actions, _, pause = self.fixture()

        async def unknown(_operation: dict[str, Any]) -> dict[str, Any]:
            return {"values": {"power": "Unknown"}}

        controller.handle = unknown
        with self.assertRaises(RuntimeError):
            await baseline.close_sequence(controller, "Player", lambda _event: None, pause)
        self.assertEqual(actions, [])

    async def test_failed_dispatch_is_not_retried(self) -> None:
        controller, actions, _, pause = self.fixture()
        original = controller.handle

        async def fail(operation: dict[str, Any]) -> dict[str, Any] | None:
            result = await original(operation)
            if operation["operation"] == "action":
                raise RuntimeError("Synthetic delivery uncertainty")
            return result

        controller.handle = fail
        with self.assertRaises(RuntimeError):
            await baseline.close_sequence(controller, "Player", lambda _event: None, pause)
        self.assertEqual(len(actions), 1)

    async def test_connection_loss_during_gap_stops_remaining_controls(self) -> None:
        controller, actions, _, _ = self.fixture()

        async def disconnect(_seconds: float) -> None:
            controller.connected = False

        with self.assertRaises(RuntimeError):
            await baseline.close_sequence(controller, "Player", lambda _event: None, disconnect)
        self.assertEqual(len(actions), 1)

    def test_preview_never_reads_pairing_or_opens_a_device(self) -> None:
        result = subprocess.run([sys.executable, str(SCRIPT), "--credentials", "/nonexistent/test.json"], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["mode"], "offline preview")


if __name__ == "__main__":
    unittest.main()
