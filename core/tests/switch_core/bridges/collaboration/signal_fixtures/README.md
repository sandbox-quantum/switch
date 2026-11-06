# signal-cli daemon fixtures

Captured on Nov 6, 2026 against a live signal-cli **0.14.9** daemon
(multi-account mode, `--http 127.0.0.1:8080 --receive-mode on-start`) with a
second phone generating the inbound events. Every value is a placeholder:
the bot number is `+15555550100` (aci `00000000-0000-4000-8000-000000000001`),
the human is `+15555550200` (uuid `00000000-0000-4000-8000-000000000002`),
group ids are `c3dpdGNoLWdyb3VwLTE=` (member group) and
`c3dpdGNoLWdyb3VwLTI=` (invited group), and every millisecond timestamp is shifted down by a constant, so the SSE
event ids read `285-1` … `285-21` (base `285` plus a running counter) and
every `result.timestamp` is a small offset.

Layout: each `*.json` is `{"request": …, "response": …}` for one RPC call, or
`{"sse_id", "event", "data"}` for one SSE event. `data` is the parsed JSON of
the `data:` line.

- RPC: `version`, `list_accounts`, `list_groups`, `send_dm`,
  `send_text_style`, `send_quote`, `send_edit`, `send_group`, `send_attach`,
  `send_typing`, `send_reaction`, `send_sync`, `remote_delete`,
  `get_attachment` (payload trimmed; shape noted).
- SSE: `sse_receipt`, `sse_typing`, `sse_dm`, `sse_group`, `sse_quote`,
  `sse_attachment`, `sse_reaction`, `sse_edit`, `sse_delete`,
  `sse_replay_excerpt` (the 0-sentinel replay, 21 events, ids strictly
  increasing).
- Errors: `error_unknown_account` (-32602, "Specified account does not
  exist" — the same code and message for `send` and `remoteDelete` probes),
  `error_malformed_recipient`, `error_no_recipient`, `error_unknown_group`,
  `error_unknown_attachment` (all -1), `error_missing_method` (-32600).

Findings from the capture that shape the adapter:

- **Inbound envelopes have no top-level `groupId`.** DMs carry no group info;
  group events carry `dataMessage.groupInfo.groupId` (groups) or — for
  typing and receipts — the message-type's own `groupId`. The adapter
  resolves the channel as `d:<sourceUuid>` when no group info is present.
- **The bot's own outbound sends produce no SSE events** (no `syncMessage`)
  in multi-account mode, so there is no "ignore own sends" path from the
  stream itself; dedupe on `message_ref` is the guarantee.
- **Replay:** an unknown `Last-Event-ID` (`0` or garbage) replays all kept
  events; a fresh stream with no header replays nothing; a valid last id
  resumes after it.
- **Error codes are a reliable classifier:** -32602 = account not on the
  daemon → `BridgeCredentialError`; -32600/-32601 = malformed request →
  `BridgeOperationError` (config-class); -1 = any other platform rejection
  → `BridgeOperationError`.
