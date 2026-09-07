# Quality-of-life work worth doing

Ideas for setup, interface and simplification, each anchored in something that
actually cost time getting the multi-surface demo running — not in speculation
about what might be awkward.

Ordered by payoff. Nothing here is required for D5; several things would make
D5 much less painful to build.

---

## The theme

Every failure in this project's first real run was **diagnosable but not
diagnosed**. The information existed, in a log line or a database column or an
in-memory registry, and finding it meant traversing five components. Not one
failure was mysterious once found; several took an hour to find.

So the highest-value work is not new capability. It is **making the system
able to describe itself.**

---

## 1. Ask the agent what is wrong  ★★★

**Idea:** a `switch_status` operation the agent can call and answer from — who
am I, which rooms do I hold, what is each room's audience and bridge, who may
address me here, what did I last miss.

Debugging Switch today means reading `docker logs`, querying Postgres, and
inferring connection state from error messages. But there is an agent sitting
in the room whose entire job is answering questions, and **all of this data
already exists** — `ConnectionRegistry` has the rooms, `RoomMeta` has the
audience, the addressing policy is a column.

During the demo this was tried by accident. Asked *"what other rooms are you
in?"*, the agent produced a decent answer by inference — and was wrong about
`list_rooms`, because that operation reported `connected: false` for every room
when it held two. The instinct to ask was right; the data behind it was not.

Why this is more than a debugging aid: it makes the agent the diagnostic
surface for its own platform, which is a genuinely different shape from a
dashboard, and it is a demo asset rather than a maintenance cost.

**Cost:** small. One operation over data already in memory.

## 2. `switch doctor`  ★★★

**Idea:** one command that walks the chain and names the first break.

The checks would all have fired today:

| Check | The failure it would have caught |
|---|---|
| agent is a member of every room it is expected in | auto-created email and Slack rooms resolve no agents |
| every external identity that has messaged is claimed | *"has not been claimed by any Switch user"*, twice |
| a Slack bridge with `agent_usergroups: false` in a workspace that already has agent groups | mentions silently filed as chatter |
| the connector's pinned runtime vs the local build | a session running npm `0.4.1` while the work was in local `0.6.0` |
| the bridge's listener port is reachable from outside the container | the email webhook unroutable until an override existed |
| an agent's credential store filename matches its local name | `Settings file not found: …/switch-demo-session.json` |

**Cost:** medium, and it pays for itself the first time someone else sets this
up.

## 3. Make the silences loud  ★★★

The codebase's own philosophy is *fail loud, never fake*. Three places
currently violate it, all found the hard way:

- **An unresolved `<!subteam^S…>` reaching the addressing layer.** Nothing logs
  anything. One `logger.warning` naming the likely cause — *"this looks like an
  unresolved Slack user group; the bridge is registered with `agent_usergroups:
  false`"* — replaces an hour of bisecting with a grep.
- **`[BRIDGE-IN] failed to relay … — it will not reach the room`** with no
  reason. The cause (`M_TOO_LARGE: PDU exceeds 65535 bytes`) was logged by a
  different module at a different level. One line should carry both.
- **An auto-created room with no agents** posts a notice into the channel —
  which an inbound-only bridge cannot deliver, so the one place it would be
  seen is the one place it cannot go. It belongs in the gateway.

**Cost:** trivial. Three log lines and a test each.

## 4. Registration should hand you a working agent  ★★

`POST /agents` returns `{id, api_key}` and leaves you to discover that:

- the runtime reads `SWITCH_API_TOKEN`, and `api_key` is not a name anything
  reads — **this cost a diagnosis on its own**;
- all three of endpoint, id and token must be set or resolution silently falls
  back to a store directory you never chose;
- the store file must be named after the *host's* name for the agent, not the
  agent's name on the server.

Two changes, either of which removes the class:

- **`--write-to <dir>`** (or a response field) that emits the
  `.switch/agents/<slug>.json` the runtime and the hook already read. The
  connector's `configure` skill does this for Codex; nothing does it for an
  agent registered by hand.
- **Accept `SWITCH_API_KEY` as an alias** for `SWITCH_API_TOKEN`, or rename the
  response field to `api_token`. The mismatch is between two things Switch owns.

## 5. Return the webhook secret once, like the API key  ★★

The email bridge's webhook secret is minted at registration and **displayed
nowhere**. Reading it means:

```
docker exec … psql -c "select connection_config from collaboration_bridges …"
```

The runbook documents this, which is the tell that it is wrong. It is a
credential minted for the operator; return it once at registration, exactly as
`api_key` already is.

## 6. An audience without a bridge  ★★

Testing the disclosure story needs an `external` room, and the only way to get
one is to stand up a real email bridge — a domain, or a mailbox and an app
password and a poller. Today that meant Gmail 2FA, a workspace policy fight,
and a throwaway account.

`create_room` already takes `channel_type`. **Let an internal room declare an
audience directly** (dev-only, or admin-only, or flagged in the room so nobody
mistakes it for real). Then the whole US-4 story is testable with two `curl`s
and no external account, and the recorded demo can be rehearsed offline.

## 7. A demo, declared  ★★

`rooms_yaml.py` already provisions a room from YAML and exports it back. Extend
the same surface to a **bundle**: agents, rooms, bridges, allowlists, identity
claims.

```
just demo-up docs/demo/multi-surface.yaml
```

Setting up today's demo took roughly forty manual steps across `curl`, the
gateway, psql and two UIs, and several are ordering-sensitive in ways only the
runbook records. A bundle turns the runbook's Steps 3–8 into a file — which is
also the honest test of whether the runbook is complete.

## 8. Show every room the session is in  ★

Switch Console's badge shows one room while a session serves four, because
`session_room_connections` keys on the session. Cosmetic, and it undercuts the
one thing a multi-surface demo is trying to show. Needs the schema change
deferred in `multi-surface-status.md` §2.

## 9. A read-only view of live connections  ★

There is no `GET` for connection state — no way to ask "which rooms does this
connection cover?" from outside the process. Diagnosis today was done by
*provoking the ambiguity error* and reading the room list out of the message,
which is a good error being used as an API.

---

## Code simplifications

### Already unlocked

- **`_FORWARDED_BODY_MAX_CHARS` dies with D5 Phase 1.** It caps each nested
  part inside a loop while the body accumulates across them, so it never
  measured the thing it was protecting. The recursion removes both it and the
  raw flatten.
- **`EMAIL_BODY_MAX_BYTES` becomes a backstop** rather than the mechanism, once
  overflow text is attached instead of cut.

### Decide, then delete or wire

`multi-surface-status.md` §3 lists 1,072 lines of source with no caller. Two of
those groups are cleanly separable and would shrink the tree today:

- **The US-3 cluster** (`agent.ts` → `host.ts` → `schedule.ts`, 672 lines plus
  1,328 of tests) is self-contained: nothing outside imports any of it. If US-3
  is not next, it is a branch, not a file in `main`.
- **`disclosure.py`'s enforcement half** (91 of 198 lines) is the one place
  where wired and unwired code share a file, so the module reads as a working
  disclosure system when it is a labelling system beside an unused rule.
  Splitting `audience.py` (wired) from `flow_rule.py` (not) would make the state
  of the world obvious from the import list.

### Duplication the repo already flags

`console/AGENTS.md` names `auto-session-watcher.ts` (751 lines) and the
sidecar's `notification-watcher.ts` (346) as *"two implementations of one
watcher"*, with nothing shared. The spawn-guard bug fixed on this branch lived
in one of them, and whether the other has the same bug is unknown — which is
the cost of the duplication, stated concretely. Worth checking as a first step,
even before any refactor.

### Size

Three files carry most of the new complexity: `bin.ts` (2,056), the
`room-connection.ts` it feeds (1,144), and `email/adapter.py` (653). The email
adapter is about to be rewritten for D5 and should come out smaller, since the
recursion replaces the special-casing. The other two are worth a look but not a
refactor for its own sake.

---

## If only three things

1. **`switch_status`** — the agent describes its own wiring. Cheapest, and it
   changes how every future problem gets diagnosed.
2. **The three log lines in §3.** An afternoon, and it retires the whole class
   of silent failure that dominated this project.
3. **Audience without a bridge.** It makes the disclosure work testable and the
   demo rehearsable without a single external account.
