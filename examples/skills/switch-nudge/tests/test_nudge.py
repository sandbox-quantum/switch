"""Offline tests. Credential values are inert placeholders, never server-issued."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/nudge.py'
spec = importlib.util.spec_from_file_location('nudge', SCRIPT)
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)


class NudgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'state'
        self.creds = Path(self.temp.name) / 'sender.json'
        self.creds.write_text(json.dumps({'env': {
            'SWITCH_AGENT_ID': 'watcher-id', 'SWITCH_API_ENDPOINT': 'https://switch.invalid',
            'SWITCH_API_TOKEN': 'PLACEHOLDER_SENDER_CREDENTIAL'}}))
        self.creds.chmod(0o600)
        self.log = Path(self.temp.name) / 'calls.jsonl'
        self.env = patch.dict(os.environ, {'WATCH_TEST_LOG': str(self.log),
            'SWITCH_AGENT_ID': 'foreman-id', 'SWITCH_API_TOKEN': 'PLACEHOLDER_UNRELATED_CREDENTIAL',
            'SWITCH_SESSION_FILE': '/wrong/session', 'SWITCH_CONNECTION_ID': 'wrong-connection'})
        self.env.start()
        self.call('configure', '--credentials', str(self.creds), '--sender', 'watcher',
                  '--runtime-json', json.dumps([sys.executable, str(Path(__file__).with_name('fake_mcp.py'))]))
        self.processes = []

    def tearDown(self):
        with w.database(self.root) as db:
            for item in db['nudges'].values():
                item['state'] = 'cancelled'
        for proc in self.processes:
            try:
                proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                proc.terminate()
                proc.wait(timeout=6)
            proc.stderr.close()
        self.env.stop()
        self.temp.cleanup()

    def call(self, *argv):
        return w.cli(w.build_parser().parse_args(['--state-dir', str(self.root), *argv]))

    def schedule(self):
        with patch.object(w, 'ensure_worker'):
            return self.call('schedule', '--room', 'room-1', '--target', 'foreman',
                             '--thread', 'thread-1', '--label', 'Batch A', '--in', '15m')['id']

    def due(self, ident):
        with w.database(self.root) as db:
            db['nudges'][ident]['due_at'] = time.time() - 1

    def launch(self):
        proc = subprocess.Popen([sys.executable, str(SCRIPT), '--state-dir', str(self.root), '_run'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.processes.append(proc)
        return proc

    def item(self, ident):
        return self.call('status', ident)['nudges'][ident]

    def calls(self):
        return [json.loads(s) for s in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_one_shot_send_exits_and_does_not_repeat(self):
        ident = self.schedule()
        self.due(ident)
        self.assertEqual(self.launch().wait(timeout=6), 0)
        self.assertEqual(self.item(ident)['state'], 'sent')
        self.assertFalse(w.worker_alive(self.root))
        self.launch().wait(timeout=6)
        sends = [c for c in self.calls() if c['tool'] == 'send_targeted_message']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0]['args']['thread_id'], 'thread-1')
        self.assertEqual(sends[0]['args']['target_names'], ['foreman'])
        body = sends[0]['args']['body']
        self.assertIn('Batch A', body)
        self.assertIn('#1', body)
        self.assertIn('`nudge ', body)
        self.assertIn(f'schedule {ident} --in 15m`', body)
        self.assertNotIn('Use switch-watch', body)
        self.assertTrue(all(c['sender'] == 'watcher-id' and c['selector'] is None and c['connection'] is None for c in self.calls()))
        self.assertNotIn('PLACEHOLDER_SENDER_CREDENTIAL', (self.root / 'state.json').read_text())

    def test_reschedule_same_id_sends_second_sequence(self):
        ident = self.schedule()
        self.due(ident)
        self.launch().wait(timeout=6)
        with patch.object(w, 'ensure_worker'):
            result = self.call('schedule', ident, '--in', '5m')
        self.assertEqual(result['id'], ident)
        self.assertEqual(result['delay'], 300)
        self.due(ident)
        self.launch().wait(timeout=6)
        self.assertEqual(self.item(ident)['sequence'], 2)
        self.assertEqual(len([c for c in self.calls() if c['tool'] == 'send_targeted_message']), 2)

    def test_reschedule_pending_replaces_time_without_duplicate(self):
        ident = self.schedule()
        old = self.item(ident)['due_at']
        with patch.object(w, 'ensure_worker'):
            result = self.call('schedule', ident, '--in', '1h')
        self.assertGreater(result['due_at'], old)
        self.assertEqual(result['sequence'], 0)
        self.assertEqual(len(self.call('status')['nudges']), 1)
        with self.assertRaises(w.NudgeError):
            self.schedule()

    def test_cancel_prevents_send_and_reactivation(self):
        ident = self.schedule()
        self.due(ident)
        self.call('cancel', ident)
        self.launch().wait(timeout=6)
        self.assertEqual(self.calls(), [])
        with self.assertRaises(w.NudgeError):
            self.call('schedule', ident, '--in', '15m')

    def test_unknown_send_is_not_retried(self):
        ident = self.schedule()
        self.due(ident)
        with patch.dict(os.environ, {'WATCH_TEST_FAIL': 'after_send'}):
            self.launch().wait(timeout=6)
        self.assertEqual(self.item(ident)['state'], 'uncertain')
        self.launch().wait(timeout=6)
        with self.assertRaises(w.NudgeError):
            self.call('schedule', ident, '--in', '15m')
        self.assertEqual(len([c for c in self.calls() if c['tool'] == 'send_targeted_message']), 1)
        with patch.object(w, 'ensure_worker'):
            self.call('schedule', ident, '--in', '15m', '--retry-after-check')
        self.assertEqual(self.item(ident)['state'], 'scheduled')

    def test_restart_marks_inflight_uncertain_and_exits(self):
        ident = self.schedule()
        with w.database(self.root) as db:
            db['nudges'][ident].update(state='sending', sequence=1)
        self.launch().wait(timeout=6)
        self.assertEqual(self.item(ident)['state'], 'uncertain')
        self.assertEqual(self.calls(), [])

    def test_delivery_does_not_overwrite_concurrent_reschedule(self):
        ident = self.schedule()
        with w.database(self.root) as db:
            db['nudges'][ident].update(state='sending', sequence=1)
            item = dict(db['nudges'][ident])
        owner = self
        class Client:
            def tool(self, name, args):
                with patch.object(w, 'ensure_worker'):
                    owner.call('schedule', ident, '--in', '30m')
                return {'event_id': 'event', 'target_statuses': {'foreman': 'live'}}
        with patch.object(w, 'connect'):
            w.deliver(self.root, w.read_json(self.root / 'config.json'), Client(), item)
        result = self.item(ident)
        self.assertEqual(result['state'], 'scheduled')
        self.assertEqual(result['delay'], 1800)
        self.assertEqual(result['last_delivery']['event_id'], 'event')

    def test_cancel_inflight_is_not_undone(self):
        ident = self.schedule()
        with w.database(self.root) as db:
            db['nudges'][ident].update(state='sending', sequence=1)
            item = dict(db['nudges'][ident])
        owner = self
        class Client:
            def tool(self, name, args):
                owner.call('cancel', ident)
                return {'event_id': 'event', 'target_statuses': {'foreman': 'live'}}
        with patch.object(w, 'connect'):
            w.deliver(self.root, w.read_json(self.root / 'config.json'), Client(), item)
        self.assertEqual(self.item(ident)['state'], 'cancelled')

    def test_legacy_records_migrate_without_replaying_old_reminders(self):
        old = {'watches': {'old': {'id': 'old', 'state': 'awaiting_ack', 'sequence': 2,
            'room': 'room-1', 'target': 'foreman', 'thread': 'thread-1', 'label': 'Batch A',
            'interval': 600, 'next_check_at': time.time() - 1, 'expires_at': time.time() + 3600}}}
        w.atomic_json(self.root / 'state.json', old)
        self.assertEqual(self.item('old')['state'], 'sent')
        self.assertTrue((self.root / 'watcher-state-backup.json').exists())
        self.launch().wait(timeout=6)
        self.assertEqual(self.calls(), [])
        with patch.object(w, 'ensure_worker'):
            self.call('schedule', 'old', '--in', '15m')
        self.assertEqual(self.item('old')['state'], 'scheduled')
        self.assertNotIn('legacy_expires_at', self.item('old'))

    def test_refused_target_blocks_without_retry(self):
        ident = self.schedule()
        self.due(ident)
        with patch.dict(os.environ, {'WATCH_TEST_STATUS': 'not_permitted'}):
            self.launch().wait(timeout=6)
        self.assertEqual(self.item(ident)['state'], 'blocked')

    def test_cli_detaches_and_worker_lock_excludes_second_worker(self):
        proc = subprocess.run([sys.executable, str(SCRIPT), '--state-dir', str(self.root),
            'schedule', '--room', 'room-1', '--target', 'foreman', '--thread', 'thread-1',
            '--label', 'Detached test', '--in', '60s'], capture_output=True, text=True, timeout=5)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        ident = json.loads(proc.stdout)['id']
        until = time.monotonic() + 4
        while time.monotonic() < until and not w.worker_alive(self.root):
            time.sleep(.04)
        self.assertTrue(w.worker_alive(self.root))
        self.assertEqual(self.launch().wait(timeout=5), 0)
        self.call('cancel', ident)
        until = time.monotonic() + 4
        while time.monotonic() < until and w.worker_alive(self.root):
            time.sleep(.04)
        self.assertFalse(w.worker_alive(self.root))

    def test_membership_check_does_not_post(self):
        self.assertFalse(self.call('check', '--room', 'room-1', '--target', 'foreman')['message_posted'])
        self.assertFalse(any(c['tool'] == 'send_targeted_message' for c in self.calls()))

    def test_command_quotes_custom_state_path(self):
        ident = self.schedule()
        body = w.message(Path('/tmp/a directory'), self.item(ident))
        self.assertIn("`nudge --state-dir '/tmp/a directory' schedule", body)


if __name__ == '__main__':
    unittest.main()
