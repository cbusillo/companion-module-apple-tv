"""Adapted from MIT-licensed Media Control Relay; see LICENSE-MCR."""
from __future__ import annotations
import asyncio
import secrets
from typing import Any
from collections.abc import Callable, Awaitable
import pyatv
from pyatv.const import FeatureName, FeatureState, Protocol as PyATVProtocol
from pyatv.storage.memory_storage import MemoryStorage

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
    targets: list[dict[str, str]] | None = None,
    secret: dict[str, str | None] | None = None,
) -> dict[str, Any]:
    return {
        "state": state,
        "capabilities": capabilities or [],
        "targets": targets or [],
        "secret": secret,
    }

class PyATVController:
    def __init__(self) -> None:
        self.storage = MemoryStorage()
        self.targets: dict[str, Any] = {}
        self.pairing: Any = None
        self.pairing_config: Any = None
        self.atv: Any = None

    async def handle(self, operation: dict[str, Any]) -> dict[str, Any]:
        operation_name = operation.get("operation")
        if operation_name == "discover":
            return await self._discover()
        if operation_name == "beginPairing":
            return await self._begin_pairing(operation)
        if operation_name == "finishPairing":
            return await self._finish_pairing(operation)
        if operation_name == "connect":
            return await self._connect(operation)
        if operation_name == "status":
            return self._status()
        if operation_name == "action":
            return await self._action(operation.get("action"))
        if operation_name == "disconnect":
            await self._disconnect()
            return result("dormant")
        raise HelperError("malformedRequest")

    async def close(self) -> None:
        await self._close_pairing()
        await self._disconnect()

    async def _discover(self) -> dict[str, Any]:
        configs = await pyatv.scan(
            asyncio.get_running_loop(),
            protocol=PyATVProtocol.Companion,
            storage=self.storage,
        )
        self.targets.clear()
        targets: list[dict[str, str]] = []
        for config in configs:
            target_id = secrets.token_urlsafe(18)
            self.targets[target_id] = config
            targets.append({"id": target_id, "name": config.name or "Apple TV"})
        targets.sort(key=lambda target: target["name"].casefold())
        return result("dormant", targets=targets)

    async def _begin_pairing(self, operation: dict[str, Any]) -> dict[str, Any]:
        target_id = operation.get("targetID")
        if not isinstance(target_id, str) or not 1 <= len(target_id) <= 128:
            raise HelperError("malformedRequest")
        config = self.targets.get(target_id)
        if config is None:
            raise HelperError("unavailable")

        await self._close_pairing()
        pairing = await pyatv.pair(
            config,
            PyATVProtocol.Companion,
            asyncio.get_running_loop(),
            storage=self.storage,
            name="Media Control Relay",
        )
        try:
            await pairing.begin()
        except Exception as error:
            await pairing.close()
            raise HelperError("pairingFailed") from error
        self.pairing = pairing
        self.pairing_config = config
        return result("pairingRequired")

    async def _finish_pairing(self, operation: dict[str, Any]) -> dict[str, Any]:
        pin = operation.get("pin")
        if not isinstance(pin, int) or not 0 <= pin <= 9999:
            raise HelperError("malformedRequest")
        if self.pairing is None or self.pairing_config is None:
            raise HelperError("pairingRequired", "pairingRequired")

        pairing = self.pairing
        config = self.pairing_config
        try:
            pairing.pin(pin)
            await pairing.finish()
            credential = pairing.service.credentials
        except Exception as error:
            raise HelperError("pairingFailed") from error
        finally:
            await pairing.close()
            self.pairing = None
            self.pairing_config = None

        if not credential or not config.set_credentials(PyATVProtocol.Companion, str(credential)):
            raise HelperError("pairingFailed")
        connection_secret = {
            "host": str(config.address),
            "identifier": config.identifier,
            "credentials": str(credential),
        }
        try:
            await self._connect_config(config)
        except Exception:
            return result("offline", secret=connection_secret)
        return result("ready", capabilities=self._capabilities(), secret=connection_secret)

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
            or (identifier is not None and not isinstance(identifier, str))
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
        if not configs:
            raise HelperError("offline")
        config = configs[0]
        if not config.set_credentials(PyATVProtocol.Companion, credentials):
            raise HelperError("pairingRequired", "pairingRequired")
        try:
            await self._connect_config(config)
        except Exception as error:
            raise HelperError("offline") from error
        refreshed_secret = {
            "host": str(config.address),
            "identifier": config.identifier,
            "credentials": credentials,
        }
        return result(
            "ready",
            capabilities=self._capabilities(),
            secret=refreshed_secret,
        )

    async def _connect_config(self, config: Any) -> None:
        await self._disconnect()
        self.atv = await pyatv.connect(
            config,
            asyncio.get_running_loop(),
            protocol=PyATVProtocol.Companion,
            storage=self.storage,
        )

    def _status(self) -> dict[str, Any]:
        if self.atv is not None:
            return result("ready", capabilities=self._capabilities())
        if self.pairing is not None:
            return result("pairingRequired")
        return result("dormant")

    def _capabilities(self) -> list[str]:
        if self.atv is None:
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
        if self.atv is None:
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

    async def _close_pairing(self) -> None:
        if self.pairing is not None:
            await self.pairing.close()
        self.pairing = None
        self.pairing_config = None

    async def _disconnect(self) -> None:
        if self.atv is not None:
            tasks = self.atv.close()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
        self.atv = None
