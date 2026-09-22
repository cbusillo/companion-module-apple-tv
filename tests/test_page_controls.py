import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from controller import PyATVController, HelperError, MuteListener
from pyatv.const import FeatureName, FeatureState, PowerState


def fixture(volume=35):
    controller = PyATVController()
    supported = {FeatureName.Volume, FeatureName.SetVolume, FeatureName.VolumeUp,
                 FeatureName.VolumeDown, FeatureName.OutputDevices, FeatureName.PowerState,
                 FeatureName.TurnOn, FeatureName.TurnOff, FeatureName.LaunchApp}
    audio = SimpleNamespace(volume=volume, output_devices=[SimpleNamespace(identifier='route-a')])
    async def set_volume(level):
        audio.volume = level
    audio.set_volume = AsyncMock(side_effect=set_volume)
    controller.atv = SimpleNamespace(
        audio=audio,
        features=SimpleNamespace(get_feature=lambda feature: SimpleNamespace(
            state=FeatureState.Available if feature in supported else FeatureState.Unsupported)),
        remote_control=SimpleNamespace(volume_up=AsyncMock(), volume_down=AsyncMock()),
        power=SimpleNamespace(power_state=PowerState.On, turn_on=AsyncMock(), turn_off=AsyncMock()),
        apps=SimpleNamespace(launch_app=AsyncMock()),
    )
    controller.connected = True
    return controller, audio, supported


class PageControlsTests(unittest.IsolatedAsyncioTestCase):
    async def test_reported_output_change_clears_mute_between_polls(self):
        c, _, _ = fixture()
        await c._action({'action': 'toggleMute'})
        listener = MuteListener(c._forget_mute)
        listener.outputdevices_update([SimpleNamespace(identifier='route-a')], [SimpleNamespace(identifier='route-b')])
        self.assertIsNone(c.saved_volume)

    async def test_zero_and_restore_remembers_exact_level(self):
        c, audio, _ = fixture(37.5)
        await c._action({'action': 'toggleMute'})
        self.assertEqual(audio.volume, 0)
        self.assertEqual((await c._snapshot())['values']['mute_state'], 'Muted')
        await c._action({'action': 'toggleMute'})
        self.assertEqual(audio.volume, 37.5)
        self.assertIsNone(c.saved_volume)
        self.assertEqual([call.args[0] for call in audio.set_volume.await_args_list], [0, 37.5])

    async def test_initial_zero_does_not_invent_restore_volume(self):
        c, audio, _ = fixture(0)
        with self.assertRaises(HelperError) as error:
            await c._action({'action': 'toggleMute'})
        self.assertEqual(error.exception.code, 'noSavedVolume')
        audio.set_volume.assert_not_awaited()

    async def test_relative_support_does_not_imply_absolute_support(self):
        c, audio, features = fixture()
        features.remove(FeatureName.SetVolume)
        with self.assertRaises(HelperError):
            await c._action({'action': 'toggleMute'})
        audio.set_volume.assert_not_awaited()

    async def test_output_change_at_zero_discards_saved_level(self):
        c, audio, _ = fixture()
        await c._action({'action': 'toggleMute'})
        audio.output_devices = [SimpleNamespace(identifier='route-b')]
        with self.assertRaises(HelperError) as error:
            await c._action({'action': 'toggleMute'})
        self.assertEqual(error.exception.code, 'noSavedVolume')
        audio.set_volume.assert_awaited_once_with(0)

    async def test_external_volume_change_supersedes_saved_level(self):
        c, audio, _ = fixture()
        await c._action({'action': 'toggleMute'})
        audio.volume = 12
        await c._action({'action': 'toggleMute'})
        await c._action({'action': 'toggleMute'})
        self.assertEqual(audio.volume, 12)

    async def test_dial_clears_saved_mute_level(self):
        c, _, _ = fixture()
        await c._action({'action': 'toggleMute'})
        await c._action({'action': 'relativeVolume', 'delta': 1})
        self.assertIsNone(c.saved_volume)

    async def test_failed_zero_is_not_recorded_as_muted(self):
        c, audio, _ = fixture()
        audio.set_volume.side_effect = TimeoutError()
        with self.assertRaises(TimeoutError):
            await c._action({'action': 'toggleMute'})
        self.assertIsNone(c.saved_volume)

    async def test_unknown_power_does_not_guess_or_send(self):
        c, _, _ = fixture()
        c.atv.power.power_state = PowerState.Unknown
        with self.assertRaises(HelperError) as error:
            await c._action({'action': 'power'})
        self.assertEqual(error.exception.code, 'unknownPower')
        c.atv.power.turn_off.assert_not_awaited()
        c.atv.power.turn_on.assert_not_awaited()

    async def test_power_toggles_from_observed_state(self):
        c, _, _ = fixture()
        await c._action({'action': 'power'})
        c.atv.power.turn_off.assert_awaited_once()
        c.atv.power.power_state = PowerState.Off
        await c._action({'action': 'power'})
        c.atv.power.turn_on.assert_awaited_once()

    async def test_transient_metadata_failure_retains_title_and_marks_stale(self):
        c, _, _ = fixture()
        c.metadata_enabled = True
        c.playback = {'title': 'Last Good Title'}
        c.atv.metadata = SimpleNamespace(playing=AsyncMock(side_effect=TimeoutError()))
        values = (await c._snapshot())['values']
        self.assertEqual(values['title'], 'Last Good Title')
        self.assertEqual(values['metadata_state'], 'Stale')

    async def test_app_identifier_is_passed_once(self):
        c, _, _ = fixture()
        await c._action({'action': 'launchApp', 'appId': 'com.plexapp.plex'})
        c.atv.apps.launch_app.assert_awaited_once_with('com.plexapp.plex')
