"""Offline tests. Credential values are inert placeholders, never server-issued."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/register.py'
spec = importlib.util.spec_from_file_location('registration', SCRIPT)
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class Reply:
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def read(self):
        return b'{"id":"new-nudge-id","api_key":"PLACEHOLDER_RETURNED_CREDENTIAL"}'


class RegistrationTests(unittest.TestCase):
    def test_private_save_no_overwrite_and_no_auto_session(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'nudge.json'
            with patch.object(r, 'build_opener') as build:
                build.return_value.open.return_value = Reply()
                result = r.register('https://switch.invalid', 'nudge.example', output, 'PLACEHOLDER_REGISTRATION_CREDENTIAL')
                request = build.return_value.open.call_args.args[0]
                self.assertFalse(json.loads(request.data)['options']['auto_session'])
                self.assertFalse(json.loads(request.data)['overwrite'])
                self.assertNotIn('PLACEHOLDER_RETURNED_CREDENTIAL', json.dumps(result))
                saved = json.loads(output.read_text())
                self.assertEqual(saved['env']['SWITCH_API_TOKEN'], 'PLACEHOLDER_RETURNED_CREDENTIAL')
                self.assertEqual(output.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    r.register('https://switch.invalid', 'nudge.example', output, 'PLACEHOLDER_REGISTRATION_CREDENTIAL')
                self.assertEqual(build.return_value.open.call_count, 1)

    def test_non_loopback_http_rejected_before_network(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(r, 'build_opener') as build:
            with self.assertRaises(ValueError):
                r.register('http://remote.invalid', 'nudge', Path(temp) / 'nudge.json', 'PLACEHOLDER_UNUSED_CREDENTIAL')
            build.assert_not_called()


if __name__ == '__main__':
    unittest.main()
