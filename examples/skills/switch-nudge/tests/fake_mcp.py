"""Offline fixture: speaks the real stdio JSON-RPC framing, never uses a network."""
import json
import os
from pathlib import Path
import sys

log = Path(os.environ['NUDGE_TEST_LOG'])
for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    if msg['method'] == 'initialize':
        result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                  'serverInfo': {'name': 'fake', 'version': '1'}}
    else:
        tool = msg['params']['name']
        args = msg['params']['arguments']
        with log.open('a') as f:
            f.write(json.dumps({'tool': tool, 'args': args,
                'sender': os.environ.get('SWITCH_AGENT_ID'),
                'selector': os.environ.get('SWITCH_SESSION_FILE'),
                'connection': os.environ.get('SWITCH_CONNECTION_ID')}) + '\n')
        if tool in ('connect_to_room', 'list_participants'):
            data = {'participants': [
                {'id': 'nudge-id', 'name': 'nudge', 'type': 'agent', 'status': 'live'},
                {'id': 'foreman-id', 'name': 'foreman', 'type': 'agent', 'status': 'live'},
            ], 'warning': None}
        elif tool == 'send_targeted_message':
            if os.environ.get('NUDGE_TEST_FAIL') == 'after_send':
                sys.exit(0)
            data = {'event_id': 'event-123', 'target_statuses': {'foreman': os.environ.get('NUDGE_TEST_STATUS', 'live')}}
        else:
            data = {}
        result = {'content': [{'type': 'text', 'text': json.dumps(data)}]}
    print(json.dumps({'jsonrpc': '2.0', 'id': msg['id'], 'result': result}), flush=True)
