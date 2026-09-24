#!/usr/bin/env python3
"""Explicit, one-time creation of a dedicated nudge sender identity. Never auto-retries."""
import argparse
import getpass
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def register(endpoint, name, output, token):
    url = urlsplit(endpoint)
    if (url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('localhost', '127.0.0.1', '::1'))) or not url.hostname:
        raise ValueError('Use HTTPS for a remote server or HTTP on loopback.')
    if url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise ValueError('Use the bare Switch API URL, without path or credentials.')
    if not re.fullmatch(r'[a-z0-9][a-z0-9._-]*', name):
        raise ValueError('Use a lowercase agent name containing letters, numbers, dots, underscores or hyphens.')
    if not token.strip():
        raise ValueError('A registration token is required.')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Reserve the destination before creating anything remotely. Never overwrite.
    fd = os.open(output, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        payload = json.dumps({'agent_type': 'codex', 'name': name,
            'description': 'Scheduled nudges. No LLM session.',
            'options': {'auto_session': False}, 'overwrite': False}).encode()
        request = Request(endpoint.rstrip('/') + '/agents/register-known', data=payload,
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            raw = response.read()
        # Preserve the one-time response privately before parsing or transforming it.
        with os.fdopen(fd, 'wb') as stream:
            fd = None
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        data = json.loads(raw)
        if not isinstance(data.get('id'), str) or not isinstance(data.get('api_key'), str):
            raise ValueError('Unexpected registration response. Private response saved; do not register again.')
        formatted = {'name': name, 'env': {'SWITCH_API_ENDPOINT': endpoint.rstrip('/'),
            'SWITCH_AGENT_ID': data['id'], 'SWITCH_API_TOKEN': data['api_key']}}
        temp = output.with_name(output.name + '.formatted')
        with os.fdopen(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
            json.dump(formatted, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, output)
        return {'registered': name, 'agent_id': data['id'], 'credentials_file': str(output)}
    finally:
        if fd is not None:
            os.close(fd)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--endpoint', required=True, help='Switch API URL, not the gateway UI')
    parser.add_argument('--name', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        token = os.environ.get('SWITCH_REGISTRATION_TOKEN') or getpass.getpass('Switch registration token: ')
        print(json.dumps(register(args.endpoint, args.name, args.output.expanduser().resolve(), token), indent=2))
        return 0
    except FileExistsError:
        print('Destination already exists. Inspect it; registration was not retried.', file=sys.stderr)
    except HTTPError as exc:
        print(f'Registration returned HTTP {exc.code}. Destination was reserved. Inspect server state before retrying.', file=sys.stderr)
    except (URLError, TimeoutError, OSError):
        print('Registration could not be confirmed. Do not retry blindly; inspect server state and the private output file.', file=sys.stderr)
    except (ValueError, EOFError) as exc:
        # JSONDecodeError can include response details; keep it out of logs.
        print('Invalid registration response; inspect the private output file.' if isinstance(exc, json.JSONDecodeError) else str(exc), file=sys.stderr)
    return 1


if __name__ == '__main__':
    sys.exit(main())
