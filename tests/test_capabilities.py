import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bridge"))
from controller import HelperError, PyATVController
from pyatv.const import FeatureState


class CapabilityTests(unittest.IsolatedAsyncioTestCase):
    async def test_seek_checks_current_playback_before_each_dispatch(self):
        for delta in (10, -10, 30, -30):
            with self.subTest(delta=delta):
                controller = PyATVController()
                state = FeatureState.Unavailable
                remote = SimpleNamespace(skip_forward=AsyncMock(), skip_backward=AsyncMock())
                controller.atv = SimpleNamespace(
                    features=SimpleNamespace(get_feature=lambda feature: SimpleNamespace(state=state)),
                    remote_control=remote,
                )
                controller.connected = True
                action = {"action": "relativeSeek", "delta": delta}
                with self.assertRaises(HelperError) as error:
                    await controller._action(action)
                self.assertEqual(error.exception.code, "unsupportedAction")
                remote.skip_forward.assert_not_awaited()
                remote.skip_backward.assert_not_awaited()
                state = FeatureState.Available
                await controller._action(action)
                target = remote.skip_forward if delta > 0 else remote.skip_backward
                target.assert_awaited_once_with(abs(delta))
                state = FeatureState.Unavailable
                with self.assertRaises(HelperError):
                    await controller._action(action)
                target.assert_awaited_once_with(abs(delta))
