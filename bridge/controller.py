"""Adapted from MIT-licensed Media Control Relay; see LICENSE-MCR."""
from __future__ import annotations
import asyncio
from typing import Any
from collections.abc import Callable, Awaitable
import pyatv
from pyatv.const import FeatureName, FeatureState, Protocol as PyATVProtocol
from pyatv.storage.memory_storage import MemoryStorage
from pyatv.interface import DeviceListener

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
}

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

    async def handle(self, operation: dict[str, Any]) -> dict[str, Any]:
        operation_name = operation.get("operation")
        if operation_name == "connect":
            return await self._connect(operation)
        if operation_name == "status":
            return await self._health()
        if operation_name == "action":
            return await self._action(operation.get("action"))
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
        if (
            not isinstance(host, str)
            or not 1 <= len(host) <= 255
            or (not isinstance(identifier, str) or not 1 <= len(identifier) <= 255)
            or not isinstance(credentials, str)
            or not 1 <= len(credentials) <= 4096
        ):
            raise HelperError("malformedRequest")

        configs = await pyatv.scan(
            asyncio.get_running_loop(),
            hosts=[host],
            identifier=identifier or None,
            protocol=PyATVProtocol.Companion,
            storage=self.storage,
        )
        if not configs and identifier:
            configs = await pyatv.scan(
                asyncio.get_running_loop(),
                identifier=identifier,
                protocol=PyATVProtocol.Companion,
                storage=self.storage,
            )
        if len(configs) != 1 or configs[0].identifier != identifier:
            raise HelperError("offline")
        config = configs[0]
        if not config.set_credentials(PyATVProtocol.Companion, credentials):
            raise HelperError("pairingRequired", "pairingRequired")
        try:
            await self._connect_config(config)
        except Exception as error:
            raise HelperError("offline") from error
        return result("ready", capabilities=self._capabilities())

    async def _connect_config(self, config: Any) -> None:
        await self._disconnect()
        self.atv = await pyatv.connect(
            config,
            asyncio.get_running_loop(),
            protocol=PyATVProtocol.Companion,
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
            await self._volume(remote, action.get("delta"))
        else:
            raise HelperError("unsupportedAction", "ready")
        return result("ready", capabilities=self._capabilities())

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
        atv, self.atv = self.atv, None
        self.connected = False
        self.listener = None
        if atv is not None:
            atv.listener = None
            tasks = atv.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        self.atv = None
