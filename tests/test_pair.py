import asyncio
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from pair import save_credentials, provision
from controller import PyATVController, HelperError

class ProvisionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / 'credentials.json'
        os.chmod(self.temp.name, 0o700)
        self.config = SimpleNamespace(identifier='test-device', address='192.0.2.1', set_credentials=Mock(return_value=True))
        self.pairing = SimpleNamespace(begin=AsyncMock(), finish=AsyncMock(), close=AsyncMock(), pin=Mock(), has_paired=True, service=SimpleNamespace(credentials='test-secret'))
        self.atv = SimpleNamespace(apps=SimpleNamespace(app_list=AsyncMock(return_value=[])), close=Mock(return_value=set()))

    async def run_pair(self, pin='1234'):
        with patch('pair.pyatv.scan', AsyncMock(return_value=[self.config])), patch('pair.pyatv.pair', AsyncMock(return_value=self.pairing)), patch('pair.pyatv.connect', AsyncMock(return_value=self.atv)):
            await provision('192.0.2.1', 'test-device', self.output, lambda: pin)

    async def test_verified_credentials_mode_and_no_overwrite(self):
        old = os.umask(0)
        try: await self.run_pair()
        finally: os.umask(old)
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o600)
        self.assertEqual(self.output.stat().st_uid, os.getuid())
        self.assertEqual(json.loads(self.output.read_text())['identifier'], 'test-device')
        with self.assertRaises(ValueError): save_credentials(self.output, {'replacement': True})
        self.pairing.close.assert_awaited_once()
        self.atv.close.assert_called_once()

    async def test_invalid_pin_closes_pairing_no_file(self):
        with self.assertRaises(ValueError): await self.run_pair('bad')
        self.pairing.close.assert_awaited_once()
        self.assertFalse(self.output.exists())

    async def test_verification_failure_does_not_persist(self):
        self.atv.apps.app_list.side_effect = RuntimeError('secret must not persist')
        with self.assertRaises(RuntimeError): await self.run_pair()
        self.atv.close.assert_called_once()
        self.assertFalse(self.output.exists())

    async def test_wrong_identifier_never_starts_pairing(self):
        self.config.identifier = 'other'
        with self.assertRaises(ValueError): await self.run_pair()
        self.pairing.begin.assert_not_awaited()

    def test_publish_race_preserves_existing_and_cleans_temp(self):
        original_link = os.link
        def race(src, dst):
            Path(dst).write_text('existing')
            return original_link(src, dst)
        with patch('pair.os.link', side_effect=race):
            with self.assertRaises(FileExistsError): save_credentials(self.output, {'credentials':'secret'})
        self.assertEqual(self.output.read_text(), 'existing')
        self.assertEqual(list(Path(self.temp.name).glob('.pair-*')), [])

    def test_symlink_destination_and_public_directory_rejected(self):
        self.output.symlink_to(Path(self.temp.name) / 'absent')
        with self.assertRaises(ValueError): save_credentials(self.output, {})
        self.output.unlink()
        os.chmod(self.temp.name, 0o755)
        with self.assertRaises(ValueError): save_credentials(self.output, {})

class HealthTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_callback_and_old_callback_is_ignored(self):
        controller = PyATVController()
        def atv(): return SimpleNamespace(listener=None, audio=SimpleNamespace(listener=None), close=Mock(return_value=set()), apps=SimpleNamespace(app_list=AsyncMock(return_value=[])))
        first, second = atv(), atv()
        lost = Mock(); controller.on_lost = lost
        with patch('controller.pyatv.connect', AsyncMock(side_effect=[first, second])):
            await controller._connect_config(None)
            old_listener = first.listener
            await controller._connect_config(None)
        old_listener.connection_closed()
        self.assertTrue(controller.connected)
        second.listener.connection_lost(RuntimeError('private'))
        self.assertFalse(controller.connected)
        lost.assert_called_once()
        with self.assertRaises(HelperError): await controller._health()
        await controller.close()
        lost.assert_called_once()

    async def test_health_is_roundtrip_and_cannot_return_ready_after_loss(self):
        c = PyATVController(); c.connected = True
        async def response(): c.connected = False; return []
        c.atv = SimpleNamespace(apps=SimpleNamespace(app_list=AsyncMock(side_effect=response)))
        with self.assertRaises(HelperError): await c._health()
        c.atv.apps.app_list.assert_awaited_once()
