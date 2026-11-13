# Decision routing (auto-route): setting it up and what rooms do

Auto-route lets Switch pick the agent that answers a message that tags nobody.
In a room with `!auto-route on`, a person's untagged message that no follow-up
or assigned agent took is sent, with the room's recent context, to a decision
service, which names one of the room's agents or nobody. The service itself
(`decision/`, image `switch-decision`) is documented in `decision/README.md`;
this page covers how a server and its workspaces choose one, and what a room
does when there is none or it fails.

## Turning it on for a server

Auto-route needs two feature flags, `follow_the_conversation` and
`decision_routing`, in `FEATURE_FLAGS_ENABLED`. With the flag off nothing is
ever sent to a decision service, `!auto-route` says the feature is off, and
the room toggle shows it unavailable.

## The server default

The server's own decision service is the default for every workspace that
has not chosen one:

| Setting | Meaning |
| --- | --- |
| `DECISION_ENDPOINT_URL` | The decision service. Its base URL (`http://host:8230`) or its `/decide` URL both work. The bundled Helm chart (`decision.enabled`) and the compose `decision` profile set it. |
| `DECISION_API_KEY` | Sent as the bearer token, when the service requires one. |
| `DECISION_TIMEOUT_SECONDS` | How long one decision may take (default 5), for every workspace's backend. |
| `DECISION_BEDROCK_ENABLED` | Whether a workspace may choose Haiku on Amazon Bedrock (default off). Bedrock runs in the server's decision service on the server's own AWS credentials, which is why the operator has to allow it. |
| `DECISION_PENDING_MAX_AGE_SECONDS` | How long a message may wait for a decision, across a restart or an outage, before it is dropped rather than answered late (default 120). |
| `DECISION_SWEEP_CONCURRENCY` | How many workspaces' waiting decisions each process's sweep settles at once (default 4, 1 to 64). |

With no `DECISION_ENDPOINT_URL`, there is no server default: auto-route is
unavailable in every workspace until its admins choose a backend, and Haiku is
not offered (it runs in the server's decision service).

### The model behind the server default

The bundled Helm chart runs **Strands Decider 4B** (AWS's Strands Decider,
the checkpoint built on Google's Gemma 4 E4B) on one NVIDIA GPU, beside the
decision service. It was chosen on a benchmark of 100 routing scenarios in
four rooms with overlapping agents, a third of them messages nobody should
answer, run on one NVIDIA L4:

| Model | Correct | Wrong picks | Stayed quiet when it shouldn't have | Median |
| --- | --- | --- | --- | --- |
| Strands Decider 4B | 92 | 2 | 6 | 0.27 s |
| Qwen3.5-4B, 4-bit (llama.cpp) | 88 | 9 | 3 | 0.16 s |
| Claude Haiku 5.5 (40-scenario subset, for scale) | 38/40 | 0 | 2 | 1.5 s |

The four-point gap is within noise at 100 scenarios; the wrong picks decide
it. A wrong pick is the failure people notice, an agent jumping into a
conversation that was not for it, and most of Qwen's were exactly that
(answering a message meant for a named person, or people talking among
themselves). Strands Decider's misses are the quiet kind: it stays out, its
confidence usually just under the 0.6 threshold.

- **Switching to Qwen** is one chart value, `decision.modelServer.kind:
  llamacpp`, which runs Qwen3.5-4B on llama.cpp's CUDA server instead (smaller:
  8 GiB of RAM rather than 24). Local compose uses Qwen by default, because it
  runs on a CPU; see `docs/old/LOCAL_DEVELOPMENT.md`.
- **Licence.** Strands Decider is Apache-2.0, but its 4B checkpoint is built on
  Google's Gemma 4 (`google/gemma-4-E4B-it`), whose terms apply to whoever
  deploys it. The weights download from Hugging Face at deploy time, into the
  deployment's own volume; Switch does not redistribute them.
- **Hardware.** One NVIDIA GPU with 24 GB (an L4) and a node with 32 GiB of
  RAM (an AWS g6.2xlarge): the 16 GB of bf16 weights pass through memory while
  they load. With 16 GiB the model took about 10 minutes to start.

## Each workspace's choice

A workspace's admins (its owners and admins, and the server operator) choose
in Switch Console → Admin → Decision routing. Switch stores one row per
workspace (`decision_settings`); no row means the server default.

- **Server default**: whatever the server is configured with. "Use server
  default" deletes the workspace's row.
- **None**: auto-route is off in the workspace's rooms, even with a server
  default. Rooms behave as they do without it.
- **Self-hosted endpoint**: the workspace's own decision service, a URL and an
  optional key sent as its bearer token. That workspace's room context goes
  there, by its admin's choice; no other workspace is affected.
- **Haiku (Anthropic API)**: the workspace's Anthropic key, sent per request
  to the server's decision service, which calls Anthropic with it.
- **Haiku on Bedrock**: offered only where the operator set
  `DECISION_BEDROCK_ENABLED`; no key is stored.
- **Confidence threshold**: between 0 and 1, sent to the service as the
  confidence it needs to name an agent. Empty leaves it to the service. Where
  the service picks by lead instead (`DECISION_MIN_LEAD`, see the decision
  service's README), a workspace threshold puts that workspace's decisions
  back on the threshold.

A saved key is encrypted under the server's keys (`SECRET_KEYS`, re-encrypted
on rotation like every other stored secret) and only its last four characters
are ever shown. A key the server can no longer decrypt still loads, shown as
set but unreadable, so an admin can save a replacement; until then that
workspace's decisions fail (see below).

A save applies to the workspace's next decision with no restart: the process
that saved it at once, the others within a few seconds.

**Test** runs one fixed sample decision (three made-up agents and a deploy
question, nothing from any room) against the values entered, saved or not, and
shows the pick, the confidence and the time it took, or why it failed: not
reachable, timed out, key refused, an answer that is not a decision, a backend
the service cannot run, or nothing to test.

The same settings are served by the gateway API, for that workspace's admins
only: `GET`, `PUT` and `DELETE /gateway/decision-settings`, and
`POST /gateway/decision-settings/test`.

## In a room

`!auto-route on` and the auto-route toggle on the room page (Console and the
gateway, `PUT /gateway/rooms/{id}/auto-route`) set the same switch. Turning it
on is refused, with the reason and who can fix it, where it cannot act: the
flag is off, or the workspace resolves to no backend. A room's detail reports
`auto_route: {on, available, reason, fallback_agent, fallback_agent_name}`.

### Who can change it

- **Turning auto-route on or off** takes write access to the room, the same as
  `!follow-ups` and `!assign-agent`: its owner, a workspace admin, or anyone
  on a room everyone may write to. In chat, anyone who can post in the room
  may send `!auto-route on|off`. In Console and on the gateway's room page the
  toggle follows the room's `can_write`, and is shown disabled, with the
  reason, to someone who can see the room but not write to it. The API
  answers 403 without write access.
- **Naming or clearing the triage agent** takes the room's owner or a
  workspace admin (the room's `can_manage`), because it chooses an agent that
  gets messages nobody addressed to it. `!auto-route fallback @agent|off` from
  anyone else is refused with a reply saying who can; the picker in Console
  and on the gateway is read-only for them ("Only the room's owner or a
  workspace admin can change this"); and a `PUT` carrying `fallback_agent`
  answers 403. Anyone may see which agent it is.
- **Choosing the workspace's decision backend** stays with workspace admins
  (above).

### When there is no backend

Nothing changes from a room without auto-route: tags, aliases, roles, direct
rooms, follow-ups (in threads too) and the assigned agent all work, and no
message content is sent anywhere.

### When the backend fails

A timeout, a refused connection, an answer other than 200, or an answer that
is not a decision (including one naming an agent that was not a candidate) is
a failure. A decision of nobody is not.

- The message goes to nobody, and the server log names the failure.
- Switch posts "Auto-route is unavailable right now; tag an agent to reach
  it." in the room, at most once an hour per room. The time is kept in the
  room (`decision_notice_at`), so restarts and several processes don't repeat
  it.
- **Triage agent**: a room can name one of its agents with
  `!auto-route fallback @agent` (or from the toggle). While the backend fails,
  the message goes to that agent instead, through the same addressing-policy
  and budget checks as any routed message, marked `routed_reason: "fallback"`
  so it knows why it got it. It cannot be the room's assigned agent, which
  already gets every untagged message before auto-route is asked.
  `!auto-route fallback off` clears it.
- **Thread replies too.** In a room with auto-route on, a reply in a thread
  is decided like any other untagged message: the follow-up rule that sends
  it to the agent that spoke there last is skipped. So while the backend is
  failing, a reply in an agent's thread that doesn't tag it goes to the
  room's triage agent if one is named, and otherwise to nobody, with the
  notice above; in a room without auto-route it would have reached that
  agent. People reach it meanwhile by tagging it, which works as always.

### Across a restart

A message waiting for a decision is recorded with the message
(`pending_decisions`) and decided by whichever process gets to it first: the
one that wrote it at once, any other on its sweep every few seconds, or the
same one after a restart. Each is delivered at most once. One still waiting
after `DECISION_PENDING_MAX_AGE_SECONDS` is dropped and logged. The sweep
visits only the workspaces with a message waiting (one query across
workspaces), up to `DECISION_SWEEP_CONCURRENCY` of them at a time, so a
workspace whose backend is slow or failing holds up only its own messages.

## What is reported

Auto-route reports through the same channels as the rest of switch-core
(`docs/old/observability.md`). No channel ever carries the message's text, the
room's instructions or a key.

**One decision record per message.** However an undecided message ends,
switch-core writes exactly one log line for it, `Decision routing: …`, at INFO
(WARNING when it expired). With `LOG_FORMAT=json` its fields are an object
under `decision`, and over OTLP they are `decision.*` attributes:

| Field | What it says |
| --- | --- |
| `decision_id` | This decision attempt; also sent to the backend (below). Empty for a message that expired before anyone was asked. |
| `message_key` | The message, as the room knows it. |
| `outcome` | `delivered`, `nobody_chosen`, `nobody_failed`, `triage`, `dropped_not_member`, `dropped_not_allowed`, `expired`, `settled_elsewhere` or `unavailable`. |
| `choice` | The agent that received it, if any. |
| `reason` | Why it reached nobody, in words. |
| `backend`, `candidates` | Which kind of backend was asked, and about how many agents. |
| `model`, `model_choice`, `confidence`, `threshold` | What the model picked and how sure it was, against the threshold. |
| `latency_ms`, `model_ms`, `wait_ms` | The whole request as Switch timed it; the model's own time as the backend reported it; and the time from the person's message to this record. |
| `failure` | Why the backend gave no usable answer, when it did not. |

The room and tenant are log fields on the record (`room_id`, `tenant_id`), as
is `decision_id` on every line logged while that message was being decided, so
a search by room finds the record and a search by `decision_id` finds
everything about one decision.

**Following one decision across the hop.** switch-core sends the decision id
as `X-Request-Id` to a decision service. The service logs it as `request_id`
on its own line for the decision, with its model and model time. To follow a
complaint that "my question went to the wrong agent": filter switch-core's logs
by the room, find the record for the message, then search the decision
service's logs for its `decision_id`.

**Metrics.** `switch.decision.*` in the metric catalogue: decisions by backend
and outcome, failures by reason, what the backend said went wrong behind it
(`backend_errors`, from the service's `error_kind`), latency beside model time,
confidence, how each message ended and how long it waited, the size and age of
the waiting queue, and the "unavailable" notices posted. None carries a room,
agent, workspace or message.

**Health.** With a server default decision service, `/health/ready` reports a
`decision` check, and `switch.health.check{check:decision}` follows it. It
never takes switch-core out of service. A workspace's own endpoint is not
probed; its failures show in `switch.decision.failures{backend:endpoint}`.

**Dashboards and monitors** for all of this are in `deploy/observability/`.

**Product telemetry**, when it is on, counts decisions and failures without
any room, agent or message identifier: `decision_made` and `decision_failed`
in `docs/old/telemetry-events.md`.
