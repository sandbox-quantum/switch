# Running the multi-surface demo — a runbook

Step by step from a clean checkout to a demo. Companion to
`multi-surface-demo.md` (what is demonstrable and why) and
`multi-surface-progress.md` (what happened and what is knowingly missing).

**What you end up with:** one Claude Code session that is a single agent in a
Slack channel *and* at an email address, holding one context across both. That
covers **US-1, US-2, US-6**, and **US-4 in its advisory form**.

Total: an afternoon, most of it Slack app setup. Phases 0–2 need no Slack and
no email and are worth doing on their own.

---

## Phase 0 — prove the client half *(nothing has ever run it)*

The server half is proven: 2173 core tests pass and a `multi` connection was
driven end to end with `curl`. The **client** half — `SWITCH_SCOPE`, `RoomSet`,
the reconnect declaration — is tested and has never executed.

- [ ] `cd console && pnpm install`
- [ ] `pnpm --filter @sandboxaq/switch-agent-runtime run build` — produces
      `dist/bin.mjs`, which is what a session actually runs
- [ ] `pnpm --filter @sandboxaq/switch-agent-runtime run typecheck` — should be
      clean; it was as of the last commit
- [ ] `pnpm --filter @switch-console/desktop exec vitest run --project node --project main-db`
      — **the one thing never run anywhere.** `AGENTS.md` says to skip the
      `browser` project; if only that fails, treat the run as green.
      `switch-event-format.test.ts` is the file that matters here.

**Stop and read the output if the desktop tests fail.** Two of those tests are
mine and have only ever been checked by inspection.

---

## Phase 1 — a stack and an agent

- [ ] `just init-env` — refuses if `.env` exists, which is fine; the existing one
      works
- [ ] `just up` — Postgres, Tuwunel, Mattermost
- [ ] `just migrate`
- [ ] `just run` — switch-core on `127.0.0.1:8000`, in its own terminal
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health` → `200`

Register an agent. Either from Switch Console, or directly:

```bash
TOKEN=$(grep AGENT_REGISTRATION_TOKEN .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:8000/agents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{
    "name":"atlas","description":"multi-surface demo agent","connector_type":"claude_code",
    "integration_profile":{"connection_model":"always_on","message_exchange":true,
      "pre_invocation_mediation":[],"post_invocation_mediation":[],"event_reporting":[],
      "task_protocol":{"can_delegate":false,"can_accept":false}}}'
```

- [ ] Keep the returned `id` and `api_key`

---

## Phase 2 — two rooms, one session *(the real smoke test)*

This is Phase 0's proof, through the client rather than `curl`. **Do it before
touching Slack**: if it fails, nothing after it will work.

- [ ] Create two internal rooms with the agent in both
      (`POST /agents/{id}/ops/create_room`, `agent_names:["atlas"]`,
      `internal_only:true`)
- [ ] Point a Claude Code session at the connector with
      `SWITCH_SCOPE=multi`, `SWITCH_AGENT_ID`, `SWITCH_API_ENDPOINT`,
      `SWITCH_API_KEY`
- [ ] In the session: `connect_to_room` for the **first** room, then again for
      the **second**
- [ ] Confirm the session's stderr shows both rooms, and that the server's
      `connection_state` frame lists both

**Acceptance:** post into room A from a second agent (or from Switch Console);
the session receives it. Post into room B; the session receives that too, on the
same connection. It replies to each with `post_message(room_id=…)`.

**If the second `connect_to_room` drops the first room**, `SWITCH_SCOPE` did not
take — check for the "must be 'single' or 'multi'" line on stderr.

---

## Phase 3 — Slack

- [ ] Follow `docs/old/bridges/SLACK_SETUP.md` end to end
- [ ] Register the Slack bridge in the operator dashboard
- [ ] Invite the app to a channel; confirm a room is auto-created
- [ ] Add `atlas` to that room

---

## Phase 4 — email, without a domain

The provider only proves mail *delivery*. Skip it: POST a raw message at the
adapter and you have demonstrated the feature.

- [ ] Register the email bridge (operator dashboard → bridge type `email`):
      `listen_port` (something free, e.g. `8099`), `agent_address`
      (`atlas@agents.example.com` — nothing routes to it in this mode), and
      `allowed_senders` set to **your own address only**
- [ ] Read the minted webhook secret. It is displayed nowhere, by design:

```bash
docker exec switch-postgres-1 sh -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c "select connection_config from collaboration_bridges where type='"'"'email'"'"';"'
```

- [ ] Save a real forwarded email as `sample.eml` (any client: "Show original" /
      "View source"), with **your** address in `From:`
- [ ] Deliver it:

```bash
curl --data-binary @sample.eml \
  -H 'Content-Type: message/rfc822' \
  http://127.0.0.1:8099/inbound/<SECRET>
```

- [ ] **Add `atlas` to the room that just appeared.** An auto-created email room
      resolves no agents, and the bridge logs a notice saying so. Easy to miss.
- [ ] Reconnect the session so it holds the Slack room *and* the email room

---

## Phase 5 — the demo

1. **Forward an email**, from your phone, with no note. (Or `curl` a second
   `.eml`, if nobody is watching the terminal.)
2. **In Slack, ask about it** — "what did they want?" Never paste it, never say
   which email. *This is US-1 and US-2, and it is the whole demo.*
3. **Ask a colleague to ask a follow-up** in the same channel. Same agent, same
   context, someone else's question.
4. **US-6:** `curl` an `.eml` from an address not on the allowlist. Nothing
   appears; the log says it refused, naming the address.
5. **US-4, carefully:** tell the agent something in a Slack DM, then ask about
   the subject in the channel. It should answer usefully without quoting you —
   and then say the sentence below.

---

## Say these out loud

- **US-4 is advisory.** The agent is *told* who can read each room and what may
  be repeated; **nothing enforces it**. What you are seeing is a model being
  discreet because it was asked to, not a system preventing a leak. The
  enforcement is written (`disclosure.py`) and wired to nothing.
- **The allowlist is a config list**, not claimed identities. "It knows it's me"
  is really "an operator listed this address".
- **No outsider can be answered.** Inbound only — there is no outbound email.

---

## Known snags, in the order you will hit them

| Symptom | Cause |
|---|---|
| The session sees nothing after it posts | An agent's own messages are not delivered back to it. Use a second speaker. |
| `Not connected to a room` with a valid `room_id` | The caller has no connection. A room id is an argument, not a permission. |
| Email room exists, agent never answers | Auto-created email rooms resolve no agents. Add it. |
| Every forwarded mail is dropped | Check the log for a loop marker. Server-side forwarding sets `Auto-Submitted: auto-forwarded`, which is exempt now — but a mailing-list header plus a bulk `Precedence` is not. |
| `connection smoke-1 is not open` | The heartbeat TTL is 6s. A session's runtime handles this; a `curl` harness must beat. |
| Second `connect_to_room` replaces the first | `SWITCH_SCOPE` is not `multi`. |

---

## What this demo does **not** show

- **US-3** (the agent waking itself). Needs `MultiRoomHost`, schedule
  persistence and a launcher — a separate project sharing the branch.
- **US-5** (answering an outsider). Needs outbound email, which does not exist.
- Real mail delivery, unless you add a provider.

## Teardown

Everything this runbook creates, most-contained first.

**The branch.** `main` is untouched; nothing is pushed.

```bash
git checkout main && git branch -D feat/multi-surface-agent
```

**Gitignored, but on disk.** `console/node_modules` is ~1.1G and `core/.venv`
~242M — the rest is small.

```bash
rm -f .env
rm -rf core/.venv
git clean -xdf console          # node_modules and every packages/*/dist
```

**Docker.** `just down` removes the containers and keeps the volumes; `just
reset` drops the volumes too, and with them every agent, room and Matrix account
the demo created.

```bash
just reset
docker rmi switch-setup:latest jevolk/tuwunel:v1.7.1 \
           mattermost/mattermost-team-edition:latest
```

**Not repo-local — the one thing worth knowing.** Making `pnpm` available
installs corepack globally and writes shims into the global npm bin:

```bash
corepack disable && npm uninstall -g corepack && rm -rf ~/.cache/node/corepack
```

Nothing here is destructive on the way in: `just init-env` refuses to overwrite
an existing `.env`, and no step touches `main`.

**One trap.** Do not run a filtered install with `--ignore-scripts` and then a
full one — Electron's postinstall downloads its binary, and the second install
sees the package as present and skips it. The symptom is *"Electron failed to
install correctly"* across ~100 desktop test suites. Fix:

```bash
rm -rf console/node_modules/electron && pnpm install
```
