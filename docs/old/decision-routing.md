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
- **Run on one of my machines**: the decision model runs on a machine the
  admin owns and has enrolled in this workspace (a computer running Switch
  Console, or a headless agent controller). No URL or key; see
  [On a workspace admin's own machine](#on-a-workspace-admins-own-machine).
- **Confidence threshold**: between 0 and 1, sent to the service as the
  confidence it needs to name an agent. Empty leaves it to the service.

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
`POST /gateway/decision-settings/test`. An agent can read and change them for
its owner on a server running agent management: `get_decision_routing` and
`set_decision_routing` (machine or server default), with "can manage agents"
and only when its owner is a workspace admin who owns the machine.

## On a workspace admin's own machine

The decision model can run on one of the admin's own machines instead of a
hosted service: Qwen3.5-4B (`qwen3.5-4b-q4_k_m`, 4-bit) on llama.cpp, fast on
Apple Silicon and NVIDIA, slow on a CPU. It suits a workspace whose admin has
a recent Mac and no GPU server.

- **Who can choose it.** A workspace admin, from the machines they own that
  are enrolled in this workspace and report decision support (a controller
  that can serve the model reports the `decision.v1` capability; an older one
  is listed as "Update this machine's controller"). The operator role alone is
  not enough: it is not their machine. Nobody else's machine is ever listed.
- **What the machine does.** Told by its assignment, it downloads the pinned
  model and llama.cpp release (checking each against its checksum), starts
  llama-server bound to the machine itself, warms it up and reports
  `running`. Moving the workspace off it stops the server and keeps the
  download. Its owner can refuse decision work on the machine locally.
- **Until it first reports running**, auto-route is unavailable in the
  workspace, saying "The decision model on <machine> is getting ready
  (<progress>)", and no room is sent a notice. Rooms behave as they do with
  no backend.
- **How a decision is asked.** Switch renders the prompt itself (the decision
  service's own code, the `switch_decision` base package), sends it over the
  machine's existing connection to Switch, ahead of anything else queued
  there, and reads the answer and applies the threshold as the service would.
  Nothing on the machine listens on the network, and nothing needs a URL or a
  key. The machine forwards the request to its llama-server and returns the
  answer; neither keeps nor logs the room's messages. On an Apple Silicon Mac a
  decision takes about half a second.
- **Several switch-core processes.** A connection lives in the process holding
  the machine's socket, so only that process decides the workspace's
  messages: the process that wrote one wakes it, and room content never
  crosses processes. With no process holding it, the messages fail at once.
- **Once it has been ready**, a machine that is offline, busy, or whose model
  fails takes the failure path below, and the notice names it: "Auto-route is
  unavailable right now (<machine> is offline); tag an agent to reach it."
  Decisions resume when it reconnects, with no change of setting.
- **A removed machine** (revoked) makes auto-route unavailable with "The
  machine chosen for auto-route was removed…", again without notices. Deleting
  the owner's account deletes the setting, and the workspace returns to the
  server default.
- **Test** asks the machine the fixed sample when it reports the model
  running; otherwise it says the machine is offline or not ready.

## In a room

`!auto-route on` and the auto-route toggle on the room page (Console and the
gateway, `PUT /gateway/rooms/{id}/auto-route`, for the room's owner and
workspace admins) set the same switch. Turning it on is refused, with the
reason and who can fix it, where it cannot act: the flag is off, or the
workspace resolves to no backend. A room's detail reports
`auto_route: {on, available, reason, fallback_agent, fallback_agent_name}`.

### When there is no backend

Nothing changes from a room without auto-route: tags, aliases, roles, direct
rooms, follow-ups (in threads too) and the assigned agent all work, and no
message content is sent anywhere.

### When the backend fails

A timeout, a refused connection, an answer other than 200, or an answer that
is not a decision (including one naming an agent that was not a candidate) is
a failure; for a model on a machine, so is the machine being offline, busy
(four decisions in flight already) or its model not running or failing. A
decision of nobody is not.

- The message goes to nobody, and the server log names the failure.
- Switch posts "Auto-route is unavailable right now; tag an agent to reach
  it." in the room (naming the machine, for a model on one), at most once an
  hour per room. The time is kept in the
  room (`decision_notice_at`), so restarts and several processes don't repeat
  it.
- **Triage agent**: a room can name one of its agents with
  `!auto-route fallback @agent` (or from the toggle). While the backend fails,
  the message goes to that agent instead, through the same addressing-policy
  and budget checks as any routed message, marked `routed_reason: "fallback"`
  so it knows why it got it. It cannot be the room's assigned agent, which
  already gets every untagged message before auto-route is asked.
  `!auto-route fallback off` clears it.

### Across a restart

A message waiting for a decision is recorded with the message
(`pending_decisions`) and decided by whichever process gets to it first: the
one that wrote it at once, any other on its sweep every few seconds, or the
same one after a restart. Each is delivered at most once. One still waiting
after `DECISION_PENDING_MAX_AGE_SECONDS` is dropped and logged.

## What is reported

Every decision is logged with its room, candidate count, choice, confidence,
threshold, latency and backend (`machine` for a model on a machine), never the
message. Product telemetry, when it
is on, counts decisions and failures without any room, agent or message
identifier: `decision_made` and `decision_failed` in
`docs/old/telemetry-events.md`.
