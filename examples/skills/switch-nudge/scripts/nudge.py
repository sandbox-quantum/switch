#!/usr/bin/env python3
"""One-shot, reschedulable Switch nudges over an isolated stdio MCP runtime.

Python 3.10+, macOS/Linux. No third-party Python packages. No shell execution.
"""
import argparse
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import queue
import re
import signal
import shlex
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlsplit

NAME = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
ACTIVE = {"scheduled", "sending"}
DEFAULT_RUNTIME = ["npx", "--yes", "@sandboxaq/switch-agent-runtime@0.4.3"]


class NudgeError(Exception):
    pass


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise NudgeError("State directory must be owned by you and have mode 700.")


def atomic_json(path, data):
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise NudgeError("Cannot read a required JSON file; check paths and format.") from None


@contextmanager
def database(root):
    private_dir(root)
    with open(root / "state.lock", "a+") as lock:
        os.chmod(root / "state.lock", 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX)
        path = root / "state.json"
        data = read_json(path) if path.exists() else {"version": 2, "nudges": {}}
        if "watches" in data:
            if worker_alive(root):
                raise NudgeError("Stop the legacy watcher worker before migrating this state directory.")
            atomic_json(root / "watcher-state-backup.json", data)
            records = {}
            states = {"waiting": "scheduled", "awaiting_ack": "sent", "stopped": "cancelled",
                      "sending": "uncertain"}
            for key, old in data["watches"].items():
                item = dict(old)
                item.update(state=states.get(old["state"], old["state"]),
                            due_at=old.get("next_check_at"), delay=old.get("interval", 600),
                            revision=1, legacy_expires_at=old.get("expires_at"))
                for field in ("next_check_at", "interval", "expires_at"):
                    item.pop(field, None)
                if item["state"] == "scheduled" and (item.get("legacy_expires_at") or float("inf")) <= time.time():
                    item["state"] = "expired"
                records[key] = item
            data = {"version": 2, "nudges": records}
        if data.get("version") != 2:
            raise NudgeError("Unsupported state version.")
        yield data
        atomic_json(path, data)


def credentials(config):
    path = Path(config["credentials"])
    try:
        info = path.stat()
    except OSError:
        raise NudgeError("Nudge sender credential file is unavailable.") from None
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise NudgeError("Nudge sender credential file must be owned by you with mode 600.")
    data = read_json(path)
    env = data.get("env", {})
    values = {
        "SWITCH_AGENT_ID": data.get("agent_id") or env.get("SWITCH_AGENT_ID"),
        "SWITCH_API_ENDPOINT": data.get("endpoint") or env.get("SWITCH_API_ENDPOINT"),
        "SWITCH_API_TOKEN": data.get("token") or env.get("SWITCH_API_TOKEN"),
    }
    if not all(isinstance(v, str) and v.strip() for v in values.values()):
        raise NudgeError("Credential file needs agent ID, API endpoint and token.")
    endpoint = urlsplit(values["SWITCH_API_ENDPOINT"])
    if endpoint.username or endpoint.password or endpoint.query or endpoint.fragment:
        raise NudgeError("API endpoint must not contain credentials, query or fragment.")
    if not endpoint.hostname or endpoint.path not in ("", "/"):
        raise NudgeError("API endpoint must be a bare server URL.")
    if endpoint.scheme != "https" and not (
        endpoint.scheme == "http" and endpoint.hostname in ("localhost", "127.0.0.1", "::1")
    ):
        raise NudgeError("Use HTTPS for a remote server, or HTTP on loopback.")
    return values


class MCP:
    """Sequential JSON-RPC client. Notifications are drained, never interpreted."""
    def __init__(self, config):
        # Never inherit the caller's Switch identity, connection or session selector.
        env = {k: v for k, v in os.environ.items() if not k.startswith("SWITCH_")}
        env.update(credentials(config))
        env["SWITCH_CHANNEL_DISABLE_POLL"] = "1"
        self.messages = queue.Queue()
        self.number = 0
        self.room = None
        self.proc = subprocess.Popen(
            config["runtime"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
            start_new_session=True,
        )
        threading.Thread(target=self._read, daemon=True).start()
        try:
            self.request("initialize", {
                "protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "switch-nudge", "version": "2.0.0"},
            }, timeout=90)
            self._write({"jsonrpc": "2.0", "method": "notifications/initialized"})
        except Exception:
            self.close()
            raise

    def _read(self):
        try:
            for line in self.proc.stdout:
                try:
                    item = json.loads(line)
                except ValueError:
                    continue
                # Reply to unsolicited server requests; do not execute them.
                if "method" in item:
                    if "id" in item:
                        self.messages.put({"server_request": item["id"]})
                    continue
                self.messages.put(item)
        finally:
            self.messages.put({"closed": True})

    def _write(self, item):
        try:
            self.proc.stdin.write(json.dumps(item) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError):
            raise NudgeError("MCP runtime pipe closed.") from None

    def request(self, method, params, timeout=45):
        self.number += 1
        request_id = self.number
        self._write({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        end = time.monotonic() + timeout
        while True:
            try:
                msg = self.messages.get(timeout=max(0.001, end - time.monotonic()))
            except queue.Empty:
                raise NudgeError("MCP request timed out; outcome may be unknown.") from None
            if "closed" in msg:
                raise NudgeError("MCP runtime exited.")
            if "server_request" in msg:
                self._write({"jsonrpc": "2.0", "id": msg["server_request"],
                             "error": {"code": -32601, "message": "Unsupported request"}})
            elif msg.get("id") == request_id:
                if "error" in msg:
                    raise NudgeError("MCP request refused; check runtime and configuration.")
                return msg.get("result", {})
            if time.monotonic() >= end:
                raise NudgeError("MCP request timed out; outcome may be unknown.")

    def tool(self, name, args):
        result = self.request("tools/call", {"name": name, "arguments": args})
        if result.get("isError"):
            raise NudgeError("Switch tool failed: " + name)
        structured = result.get("structuredContent")
        if structured is not None:
            return structured
        blocks = result.get("content", [])
        for block in blocks:
            if block.get("type") == "text":
                try:
                    return json.loads(block["text"])
                except (ValueError, KeyError):
                    pass
        raise NudgeError("Switch tool returned an unsupported result shape: " + name)

    def close(self):
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGTERM)
                    self.proc.wait(timeout=3)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(self.proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    self.proc.wait()
        self.proc.stdout.close()


def connect(client, config, room, target):
    if target == config["sender"]:
        raise NudgeError("Nudge sender cannot target itself.")
    if client.room != room:
        result = client.tool("connect_to_room", {"room_id": room, "include_general_instructions": False})
        if result.get("warning"):
            raise NudgeError("Nudge sender identity is in use by another session; use a dedicated identity on one host.")
        client.room = room
        roster = result.get("participants")
    else:
        roster = None
    if not isinstance(roster, list):
        roster = client.tool("list_participants", {})
        if isinstance(roster, dict):
            roster = roster.get("participants", [])
    if not isinstance(roster, list):
        raise NudgeError("Cannot verify room participants.")
    identity = credentials(config)["SWITCH_AGENT_ID"]
    own = next((p for p in roster if str(p.get("id")) == identity), None)
    if not own or own.get("name") != config["sender"]:
        raise NudgeError("Configured sender name does not match the credential identity in this room.")
    recipient = next((p for p in roster if p.get("name") == target), None)
    if not recipient or recipient.get("type") != "agent":
        raise NudgeError("Target must be an agent's exact name in this room.")
    return recipient.get("status", "unknown")


def worker_alive(root):
    private_dir(root)
    with open(root / "worker.lock", "a+") as lock:
        os.chmod(root / "worker.lock", 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        return False


def ensure_worker(root):
    if not worker_alive(root):
        subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--state-dir", str(root), "_run"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True,
        )


def default_root():
    new = Path.home() / '.local/state/switch-nudge'
    old = Path.home() / '.local/state/switch-watch'
    return old if not (new / 'config.json').exists() and (old / 'config.json').exists() else new


def duration(value):
    match = re.fullmatch(r'(\d+)(s|m|h|d)', value)
    if not match:
        raise argparse.ArgumentTypeError('Use a duration such as 60s, 15m, 4h or 1d.')
    seconds = int(match[1]) * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[match[2]]
    if seconds <= 0:
        raise argparse.ArgumentTypeError('Duration must be positive.')
    return seconds


def format_delay(seconds):
    for unit, size in (('d', 86400), ('h', 3600), ('m', 60)):
        if seconds % size == 0:
            return f'{seconds // size}{unit}'
    return f'{seconds}s'


def message(root, item):
    command = ['nudge']
    if root != default_root().resolve():
        command += ['--state-dir', str(root)]
    command += ['schedule', item['id'], '--in', format_delay(item['delay'])]
    return (f"switch-nudge · {item['label']} · {item['id']} #{item['sequence']}\n"
            f"Schedule again? `{shlex.join(command)}`")


def deliver(root, config, client, item):
    ident, revision = item['id'], item['revision']
    attempted = False
    try:
        connect(client, config, item['room'], item['target'])
        with database(root) as db:
            current = db['nudges'][ident]
            if current['state'] != 'sending' or current['revision'] != revision:
                return
            if current.get('legacy_expires_at') and time.time() >= current['legacy_expires_at']:
                current['state'] = 'expired'
                return
        args = {'body': message(root, item), 'target_names': [item['target']]}
        if item.get('thread'):
            args['thread_id'] = item['thread']
        attempted = True
        result = client.tool('send_targeted_message', args)
        target_status = result.get('target_statuses', {}).get(item['target'])
        event_id = result.get('event_id')
        with database(root) as db:
            current = db['nudges'][ident]
            current['last_delivery'] = {'sequence': item['sequence'], 'event_id': event_id,
                                        'target_status': target_status, 'sent_at': time.time()}
            # The receiver may already have rescheduled or cancelled this registration.
            if current['state'] == 'sending' and current['revision'] == revision:
                if target_status == 'not_permitted':
                    current.update(state='blocked', error='Target addressing policy refused the sender.')
                elif not event_id or not target_status:
                    current.update(state='uncertain', error='Incomplete send receipt; inspect the room before scheduling again.')
                else:
                    current.update(state='sent', error=None)
    except Exception as exc:
        error = str(exc) if isinstance(exc, NudgeError) else 'Runtime operation failed.'
        with database(root) as db:
            current = db['nudges'][ident]
            if current['state'] == 'sending' and current['revision'] == revision:
                current.update(state='uncertain' if attempted else 'blocked', error=error)


def run_worker(root):
    # Migrate legacy state before taking the worker lock.
    with database(root):
        pass
    with open(root / 'worker.lock', 'a+') as lock:
        os.chmod(root / 'worker.lock', 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        config = read_json(root / 'config.json')
        client = None
        released = False
        stopping = threading.Event()
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, lambda *_: stopping.set())
        with database(root) as db:
            db['worker'] = {'pid': os.getpid(), 'instance': uuid.uuid4().hex,
                            'started_at': time.time()}
            for item in db['nudges'].values():
                if item['state'] == 'sending':
                    item.update(state='uncertain', error='Worker exited during delivery; inspect the room before scheduling again.')
        try:
            while not stopping.is_set():
                due = None
                with database(root) as db:
                    now = time.time()
                    db['worker']['last_check_at'] = now
                    for item in db['nudges'].values():
                        if item['state'] == 'scheduled' and item.get('legacy_expires_at') and item['legacy_expires_at'] <= now:
                            item['state'] = 'expired'
                    scheduled = [v for v in db['nudges'].values() if v['state'] == 'scheduled']
                    if not scheduled:
                        # Serialize exit with new registrations: a new schedule sees
                        # either a worker that will process it or an unlocked worker.
                        if client:
                            client.close()
                            client = None
                        db['worker']['ended_at'] = time.time()
                        fcntl.flock(lock, fcntl.LOCK_UN)
                        released = True
                        return
                    first = min(scheduled, key=lambda v: v['due_at'])
                    if first['due_at'] <= now:
                        first.update(state='sending', sequence=first['sequence'] + 1)
                        due = dict(first)
                if due:
                    try:
                        if client is None:
                            client = MCP(config)
                        deliver(root, config, client, due)
                    except Exception:
                        with database(root) as db:
                            current = db['nudges'][due['id']]
                            if current['state'] == 'sending' and current['revision'] == due['revision']:
                                current.update(state='blocked', error='Cannot start MCP runtime; run check to diagnose setup.')
                    # No persistent connection between sends. The Python worker only
                    # remains while another scheduled nudge needs a timer.
                    if client:
                        client.close()
                        client = None
                else:
                    stopping.wait(1)
        finally:
            if client:
                client.close()
            if not released:
                with database(root) as db:
                    db['worker']['ended_at'] = time.time()


def build_parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state-dir', type=Path, default=default_root())
    sub = p.add_subparsers(dest='command', required=True)
    c = sub.add_parser('configure', help='Store a credential-file reference; no network request')
    c.add_argument('--credentials', type=Path, required=True)
    c.add_argument('--sender', required=True)
    c.add_argument('--runtime-json', default=json.dumps(DEFAULT_RUNTIME))
    c = sub.add_parser('check', help='Verify runtime and room membership without posting')
    c.add_argument('--room', required=True)
    c.add_argument('--target', required=True)
    c = sub.add_parser('schedule', help='Schedule one nudge, or replace the next time for an existing ID')
    c.add_argument('id', nargs='?')
    c.add_argument('--in', dest='delay', type=duration, required=True)
    c.add_argument('--room')
    c.add_argument('--target')
    c.add_argument('--thread')
    c.add_argument('--top-level', action='store_true')
    c.add_argument('--label')
    c.add_argument('--retry-after-check', action='store_true', help='Reschedule a failed or uncertain send after inspecting room history')
    c = sub.add_parser('status')
    c.add_argument('id', nargs='?')
    c = sub.add_parser('cancel')
    c.add_argument('id', help="Registration ID, or 'all'")
    sub.add_parser('run', help='Resume scheduled timers in the foreground after worker exit')
    sub.add_parser('_run', help='Internal detached worker entrypoint')
    return p


def cli(args):
    root = args.state_dir.expanduser().resolve()
    if any(c in str(root) for c in '\n\r`'):
        raise NudgeError('State-directory paths cannot contain newlines or backticks.')
    private_dir(root)
    if args.command in ('run', '_run'):
        run_worker(root)
        return {'worker': 'ended'}
    if args.command == 'configure':
        if worker_alive(root):
            raise NudgeError('Cancel scheduled nudges and wait for worker exit before configuring.')
        if not NAME.fullmatch(args.sender):
            raise NudgeError('Sender must be an exact lowercase agent name.')
        try:
            runtime = json.loads(args.runtime_json)
        except ValueError:
            raise NudgeError('runtime-json must be a JSON argv array.') from None
        if not isinstance(runtime, list) or not runtime or not all(isinstance(v, str) and v for v in runtime):
            raise NudgeError('runtime-json must be a nonempty JSON argv array.')
        config = {'credentials': str(args.credentials.expanduser().resolve()), 'sender': args.sender, 'runtime': runtime}
        credentials(config)
        atomic_json(root / 'config.json', config)
        return {'configured': True, 'sender': args.sender, 'credentials': 'referenced, not copied'}
    if args.command == 'status':
        alive = worker_alive(root)
        with database(root) as db:
            snapshot = json.loads(json.dumps(db))
        if args.id:
            if args.id not in snapshot['nudges']:
                raise NudgeError('Unknown nudge ID.')
            snapshot['nudges'] = {args.id: snapshot['nudges'][args.id]}
        snapshot['worker_running'] = alive
        return snapshot
    if args.command == 'cancel':
        with database(root) as db:
            selected = list(db['nudges'].values()) if args.id == 'all' else [db['nudges'].get(args.id)]
            if any(v is None for v in selected):
                raise NudgeError('Unknown nudge ID.')
            for item in selected:
                item.update(state='cancelled', cancelled_at=time.time(), revision=item['revision'] + 1)
        return {'cancelled': [v['id'] for v in selected]}
    config = read_json(root / 'config.json')
    if args.command == 'check':
        if worker_alive(root):
            raise NudgeError('Wait for the worker to exit before checking; do not compete for its sender connection.')
        client = MCP(config)
        try:
            reachability = connect(client, config, args.room, args.target)
            return {'membership_verified': True, 'target_status': reachability,
                    'addressing_policy': 'not proven until a targeted send', 'message_posted': False}
        finally:
            client.close()
    if not 60 <= args.delay <= 604800:
        raise NudgeError('Delay must be between 60 seconds and 7 days.')
    with database(root) as db:
        now = time.time()
        if args.id:
            item = db['nudges'].get(args.id)
            if item is None:
                raise NudgeError('Unknown nudge ID.')
            if args.room or args.target or args.thread or args.top_level or args.label:
                raise NudgeError('An existing ID retains its room, target, thread and label. Supply only --in.')
            if item['state'] in ('cancelled', 'expired'):
                raise NudgeError('This registration ended. Create a new nudge instead.')
            if item['state'] in ('uncertain', 'blocked') and not args.retry_after_check:
                raise NudgeError('Inspect the room and fix setup first, then use --retry-after-check if another send is needed.')
        else:
            if not args.room or not args.target or not args.label:
                raise NudgeError('A new nudge needs --room, --target and --label.')
            if not NAME.fullmatch(args.target) or args.target == config['sender']:
                raise NudgeError('Target must be a different agent\'s exact name.')
            if bool(args.thread) == bool(args.top_level):
                raise NudgeError('Supply --thread ID, or explicitly choose --top-level, but not both.')
            if len(args.label) > 120 or any(c in args.label for c in '\n\r@`'):
                raise NudgeError('Label must be at most 120 characters without newlines, mentions or backticks.')
            if args.retry_after_check:
                raise NudgeError('--retry-after-check applies only to an existing failed registration.')
            item = {'id': uuid.uuid4().hex[:12], 'room': args.room, 'target': args.target,
                    'thread': args.thread, 'label': args.label, 'created_at': now,
                    'sequence': 0, 'revision': 0}
        for other in db['nudges'].values():
            if other['id'] != item['id'] and (other['room'], other['target'], other.get('thread')) == (item['room'], item['target'], item.get('thread')) and other['state'] in ACTIVE | {'uncertain'}:
                raise NudgeError('This target/thread already has a pending nudge: ' + other['id'])
        item.update(state='scheduled', delay=args.delay, due_at=now + args.delay,
                    revision=item['revision'] + 1, error=None, scheduled_at=now)
        item.pop('legacy_expires_at', None)
        db['nudges'][item['id']] = item
        result = dict(item)
    ensure_worker(root)
    return result


def main():
    os.umask(0o077)
    try:
        result = cli(build_parser().parse_args())
        if result is not None:
            print(json.dumps(result, indent=2))
        return 0
    except (NudgeError, OSError) as exc:
        error = str(exc) if isinstance(exc, NudgeError) else 'Local file or process operation failed; check paths and permissions.'
        print(json.dumps({'error': error}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
