"""Adapted from MIT-licensed Media Control Relay; see LICENSE-MCR."""
from __future__ import annotations
import asyncio
import math
import time
from typing import Any
from collections.abc import Callable, Awaitable
import pyatv
from pyatv.const import FeatureName, FeatureState, InputAction, PowerState, Protocol as PyATVProtocol
from pyatv.storage.memory_storage import MemoryStorage
from pyatv.interface import AudioListener, DeviceListener


class MuteListener(AudioListener):
    def __init__(self, forget):
        self.forget = forget

    def volume_update(self, old_level, new_level):
        if old_level != new_level and new_level > 0:
            self.forget()

    def volume_device_update(self, output_device, old_level, new_level):
        if old_level != new_level and new_level > 0:
            self.forget()

    def outputdevices_update(self, old_devices, new_devices):
        if {device.identifier for device in old_devices} != {device.identifier for device in new_devices}:
            self.forget()

class SessionListener(DeviceListener):
    def __init__(self, lost):
        self.lost = lost

    def connection_lost(self, exception):
        self.lost()

    def connection_closed(self):
        self.lost()


CAPABILITY_FEATURES = {
    "navigation": (FeatureName.Up, FeatureName.Down, FeatureName.Left, FeatureName.Right),
    "select": (FeatureName.Select,),
    "back": (FeatureName.Menu,),
    "home": (FeatureName.Home,),
    "playPause": (FeatureName.PlayPause,),
    "previous": (FeatureName.Previous,),
    "next": (FeatureName.Next,),
    "relativeSeek": (FeatureName.SkipForward, FeatureName.SkipBackward),
    "relativeVolume": (FeatureName.VolumeUp, FeatureName.VolumeDown),
    "toggleMute": (FeatureName.Volume, FeatureName.SetVolume),
    "controlCenter": (FeatureName.ControlCenter,),
    "appSwitcher": (FeatureName.Home,),
    "screensaver": (FeatureName.Screensaver,),
    "power": (FeatureName.TurnOn, FeatureName.TurnOff, FeatureName.PowerState),
    "launchApp": (FeatureName.LaunchApp,),
    "swipe": (FeatureName.Swipe,),
}

SWIPE_COORDINATES = {
    "up": (500, 900, 500, 100),
    "down": (500, 100, 500, 900),
    "left": (900, 500, 100, 500),
    "right": (100, 500, 900, 500),
}
SWIPE_DURATION_MS = 100

class HelperError(Exception):
    """A bounded, client-visible helper error category."""

    def __init__(self, code: str, state: str = "offline") -> None:
        super().__init__(code)
        self.code = code
        self.state = state

def result(
    state: str,
    *,
    capabilities: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "state": state,
        "capabilities": capabilities or [],
    }

class PyATVController:
    def __init__(self) -> None:
        self.storage = MemoryStorage()
        self.atv: Any = None
        self.listener = None
        self.connected = False
        self.on_lost = lambda: None
        self.saved_volume = None
        self.saved_outputs = None
        self.metadata_enabled = False
        self.playback = {}
        self.playback_at = 0.0
        self.audio_listener = None

    async def handle(self, operation: dict[str, Any]) -> dict[str, Any]:
        operation_name = operation.get("operation")
        if operation_name == "connect":
            return await self._connect(operation)
        if operation_name == "status":
            return await self._health()
        if operation_name == "action":
            return await self._action(operation.get("action"))
        if operation_name == "snapshot":
            return await self._snapshot()
        if operation_name == "disconnect":
            await self._disconnect()
            return result("dormant")
        raise HelperError("malformedRequest")

    async def close(self) -> None:
        await self._disconnect()

    async def _connect(self, operation: dict[str, Any]) -> dict[str, Any]:
        secret_value = operation.get("secret")
        if not isinstance(secret_value, dict):
            raise HelperError("malformedRequest")
        host = secret_value.get("host")
        identifier = secret_value.get("identifier")
        credentials = secret_value.get("credentials")
        metadata_credentials = secret_value.get("airplay_credentials")
        if (
            not isinstance(host, str)
            or not 1 <= len(host) <= 255
            or (not isinstance(identifier, str) or not 1 <= len(identifier) <= 255)
            or not isinstance(credentials, str)
            or not 1 <= len(credentials) <= 4096
            or (metadata_credentials is not None and
                (not isinstance(metadata_credentials, str) or not 1 <= len(metadata_credentials) <= 4096))
        ):
            raise HelperError("malformedRequest")

        configs = await pyatv.scan(
            asyncio.get_running_loop(),
            hosts=[host],
            identifier=identifier or None,
            protocol={PyATVProtocol.Companion, PyATVProtocol.AirPlay} if metadata_credentials else PyATVProtocol.Companion,
            storage=self.storage,
        )
        if not configs and identifier:
            configs = await pyatv.scan(
                asyncio.get_running_loop(),
                identifier=identifier,
                protocol={PyATVProtocol.Companion, PyATVProtocol.AirPlay} if metadata_credentials else PyATVProtocol.Companion,
                storage=self.storage,
            )
        if len(configs) != 1 or identifier not in configs[0].all_identifiers:
            raise HelperError("offline")
        config = configs[0]
        if not config.set_credentials(PyATVProtocol.Companion, credentials):
            raise HelperError("pairingRequired", "pairingRequired")
        if metadata_credentials and not config.set_credentials(PyATVProtocol.AirPlay, metadata_credentials):
            raise HelperError("metadataPairingRequired", "pairingRequired")
        try:
            await self._connect_config(config, bool(metadata_credentials))
        except Exception as error:
            raise HelperError("offline") from error
        return result("ready", capabilities=self._capabilities())

    async def _connect_config(self, config: Any, metadata_enabled: bool = False) -> None:
        await self._disconnect()
        self.atv = await pyatv.connect(
            config,
            asyncio.get_running_loop(),
            protocol=None if metadata_enabled else PyATVProtocol.Companion,
            storage=self.storage,
        )

        session = self.atv
        def lost():
            if self.atv is session and self.connected:
                self.connected = False
                self.on_lost()
        self.listener = SessionListener(lost)
        self.atv.listener = self.listener
        self.connected = True
        self.metadata_enabled = metadata_enabled
        self.audio_listener = MuteListener(self._forget_mute)
        self.atv.audio.listener = self.audio_listener


    async def _health(self):
        if not self.connected or self.atv is None:
            raise HelperError("offline")
        try:
            await self.atv.apps.app_list()
        except pyatv.exceptions.NotSupportedError as error:
            raise HelperError("healthUnsupported", "unknown") from error
        if not self.connected:
            raise HelperError("offline")
        return result("ready", capabilities=self._capabilities())

    def _capabilities(self) -> list[str]:
        if self.atv is None or not self.connected:
            return []
        features = self.atv.features
        return [
            capability
            for capability, feature_names in CAPABILITY_FEATURES.items()
            if all(
                features.get_feature(feature_name).state == FeatureState.Available
                for feature_name in feature_names
            )
        ]

    async def _action(self, action: Any) -> dict[str, Any]:
        if self.atv is None or not self.connected:
            raise HelperError("offline")
        if not isinstance(action, dict) or not isinstance(action.get("action"), str):
            raise HelperError("malformedRequest")
        action_name = action["action"]
        required_capability = {
            "navigate": "navigation",
            "select": "select",
            "back": "back",
            "home": "home",
            "playPause": "playPause",
            "previous": "previous",
            "next": "next",
            "relativeSeek": "relativeSeek",
            "relativeVolume": "relativeVolume",
            "toggleMute": "toggleMute",
            "controlCenter": "controlCenter",
            "appSwitcher": "appSwitcher",
            "screensaver": "screensaver",
            "power": "power",
            "launchApp": "launchApp",
            "swipe": "swipe",
        }.get(action_name)
        if required_capability and required_capability not in self._capabilities():
            raise HelperError("unsupportedAction", "ready")

        remote = self.atv.remote_control
        if action_name == "navigate":
            commands: dict[str, Callable[[], Awaitable[None]]] = {
                "up": remote.up,
                "down": remote.down,
                "left": remote.left,
                "right": remote.right,
            }
            direction = action.get("direction")
            command = commands.get(direction) if isinstance(direction, str) else None
            if command is None:
                raise HelperError("unsupportedAction", "ready")
            await command()
        elif action_name == "select":
            await remote.select()
        elif action_name == "back":
            await remote.menu()
        elif action_name == "home":
            await remote.home()
        elif action_name == "playPause":
            await remote.play_pause()
        elif action_name == "previous":
            await remote.previous()
        elif action_name == "next":
            await remote.next()
        elif action_name == "relativeSeek":
            await self._skip(remote, action.get("delta"))
        elif action_name == "relativeVolume":
            self._forget_mute()
            await self._volume(remote, action.get("delta"))
        elif action_name == "toggleMute":
            await self._toggle_mute()
        elif action_name == "controlCenter":
            await remote.control_center()
        elif action_name == "appSwitcher":
            await remote.home(action=InputAction.DoubleTap)
        elif action_name == "screensaver":
            await remote.screensaver()
        elif action_name == "power":
            power = self.atv.power
            if power.power_state == PowerState.On:
                await power.turn_off()
            elif power.power_state == PowerState.Off:
                await power.turn_on()
            else:
                raise HelperError("unknownPower", "ready")
        elif action_name == "launchApp":
            app_id = action.get("appId")
            if not isinstance(app_id, str) or not 1 <= len(app_id) <= 255:
                raise HelperError("unsupportedAction", "ready")
            await self.atv.apps.launch_app(app_id)
        elif action_name == "swipe":
            direction = action.get("direction")
            coordinates = SWIPE_COORDINATES.get(direction) if isinstance(direction, str) else None
            if coordinates is None:
                raise HelperError("unsupportedAction", "ready")
            await self.atv.touch.swipe(*coordinates, SWIPE_DURATION_MS)
        else:
            raise HelperError("unsupportedAction", "ready")
        return result("ready", capabilities=self._capabilities())

    def _forget_mute(self):
        self.saved_volume = None
        self.saved_outputs = None

    def _volume_state(self):
        if "toggleMute" not in self._capabilities():
            self._forget_mute()
            return None, None
        volume = self.atv.audio.volume
        if not isinstance(volume, (int, float)) or not math.isfinite(volume) or not 0 <= volume <= 100:
            self._forget_mute()
            return None, None
        outputs = None
        if self.atv.features.get_feature(FeatureName.OutputDevices).state == FeatureState.Available:
            outputs = tuple(sorted(device.identifier for device in self.atv.audio.output_devices))
        if self.saved_volume is not None and (volume > 0 or outputs != self.saved_outputs):
            self._forget_mute()
        return volume, outputs

    async def _toggle_mute(self):
        volume, outputs = self._volume_state()
        if volume is None:
            raise HelperError("unsupportedAction", "ready")
        if self.saved_volume is not None:
            restore = self.saved_volume
            self._forget_mute()
            await self.atv.audio.set_volume(restore)
        elif volume > 0:
            await self.atv.audio.set_volume(0.0)
            self.saved_volume, self.saved_outputs = volume, outputs
        else:
            # Never invent a restore level for a device already at zero.
            raise HelperError("noSavedVolume", "ready")

    async def _snapshot(self):
        if not self.connected or self.atv is None:
            raise HelperError("offline")
        volume, _ = self._volume_state()
        values = {
            "volume": "" if volume is None else str(round(volume)),
            "mute_state": "Muted" if self.saved_volume is not None else "Unmuted" if volume is not None else "Unavailable",
            "power": self.atv.power.power_state.name,
            "metadata_state": "Pairing Required" if not self.metadata_enabled else "Ready",
        }
        if self.metadata_enabled:
            try:
                playing = await asyncio.wait_for(self.atv.metadata.playing(), 1.5)
                app = self.atv.metadata.app
                self.playback = {
                    "title": (playing.title or "Nothing Playing")[:240],
                    "artist": (playing.artist or playing.series_name or "")[:120],
                    "app": (app.name if app else "")[:80],
                    "playback_state": playing.device_state.name,
                    "position": str(max(0, int(playing.position or 0))),
                    "duration": str(max(0, int(playing.total_time or 0))),
                }
                self.playback_at = time.monotonic()
            except Exception:
                # Retain the last good display on a transient metadata failure.
                values["metadata_state"] = "Stale" if self.playback else "Unavailable"
        values.update(self.playback)
        if self.playback_at and time.monotonic() - self.playback_at > 15:
            values["metadata_state"] = "Stale"
        return {**result("ready", capabilities=self._capabilities()), "values": values}

    async def _skip(self, remote: Any, delta: Any) -> None:
        if not isinstance(delta, int) or delta == 0 or abs(delta) > 60:
            raise HelperError("unsupportedAction", "ready")
        if delta > 0:
            await remote.skip_forward(delta)
        else:
            await remote.skip_backward(abs(delta))

    async def _volume(self, remote: Any, delta: Any) -> None:
        if not isinstance(delta, int) or delta == 0 or abs(delta) > 24:
            raise HelperError("unsupportedAction", "ready")
        command = remote.volume_up if delta > 0 else remote.volume_down
        for _ in range(abs(delta)):
            await command()

    async def _disconnect(self) -> None:
        self._forget_mute()
        self.playback = {}
        self.playback_at = 0.0
        self.metadata_enabled = False
        atv, self.atv = self.atv, None
        self.connected = False
        self.listener = None
        if atv is not None:
            atv.listener = None
            if self.audio_listener is not None:
                atv.audio.listener = None
            self.audio_listener = None
            tasks = atv.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        self.atv = None
