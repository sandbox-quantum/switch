# Hosted agents: design and plan

Status: design spike. Not implemented.

Every Switch agent runs on a machine somebody owns — a laptop, or a server they
onboarded over SSH. That is deliberate, and the README lists it among the things
Switch is not: *"Not a black box self-service platform. Switch's code is here for
everyone to see and contribute to. It is designed to be self-hostable and for
your data to stay where it is."* It is also why nobody can try Switch without
installing three things first, and why the shortest honest answer to "can I see
it?" is "install Node, install a coding agent, install the connector, run a
server."

This document asks what it would take to run an agent session *for* a customer,
on infrastructure we operate, so that someone can sign up and have a working
agent with nothing installed. It is an argument rather than an agreed plan, and
§10 argues the other side of it.

The deliverable is the design, the order of work, and the questions still open.
No code was written.

It refers throughout to the multi-tenancy design spike, which is
`docs/old/multi-tenancy.md` — **in flight on an unmerged branch**, so it is not
on `main` and a reader of this document may not be able to open it yet. Where
this document quotes it, the quote is reproduced in full for that reason.

---

## 1. Where we are today

### The runtime already exists

The hard part of running an agent away from its owner is already built and
shipped. `console/apps/switch-console-desktop/src/sidecar/` is a headless agent
runner: eleven source files, roughly 2,400 lines, bundled by esbuild into a
single `sidecar.mjs`. It reads credentials from a JSON file, opens one event
stream to Switch covering every room the agent belongs to, watches for messages
addressed to it, spawns the agent CLI under `tmux`, types prompts into the
running terminal UI, and keeps a session registry on disk that it reconciles
against live `tmux` panes when it restarts.

It needs `tmux`, `git`, and Node 18 or newer — the preflight's floor, though the
build targets Node 20, now past end of life, so a new image should pin 22 or 24.
Nothing else, and the build script enforces it: a custom esbuild resolver fails
the build if Electron, the local database or the ORM are pulled in transitively,
so the sidecar cannot acquire a desktop dependency by accident.

It contains no SSH code — only comments mentioning it. SSH is how Switch Console
*delivers* it, and the seam between the two is two methods:

```ts
export interface SidecarHost {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  putFile(localAbsPath: string, remoteRelPath: string): Promise<void>;
}
```

One implementation exists, over SSH. Anything that can run a command and put a
file can host the sidecar.

`AgentLaunchSpec` (`src/sidecar/agent-launch-spec.ts`) is the other half: a
plain-JSON launch recipe — command, args, env, cwd, optional home-directory
files, provider id and two behaviour flags — that exists precisely so a headless
watcher with no plugin registry never has to call back into desktop code to work
out how to start an agent. It is already the interface a control plane would
want.

Put that bundle in an image and the runtime problem is mostly solved.

### What assumes a human owns the box

Everything around the sidecar does. A host is an entry in the user's own
`~/.ssh/config` and nothing else — `listSshConfigHosts()` is the whole of host
onboarding, and its comment notes that Switch Console stores no credentials, so
there is nothing a server could enumerate. The deployer imports `electron` and
resolves the bundle out of `process.resourcesPath`, so the desktop app is the
only thing that can deploy it. Setup is deliberately manual: *"There is
deliberately no run-the-whole-plan loop — the ordering in a plan is guidance for
a person, not a script."* And a deploy lock, a bundle-hash dedupe, log trimming
and reattach logic all exist because the box outlives the client and is shared
between installs — none of which is true of a machine we create per agent.
§4 lists what that means for the port.

One of them is not a rough edge but the whole of §6. **Model credentials are
assumed to be already there.** The remote preflight checks `tmux`, `node`,
`git`, the Switch credentials and Switch reachability, and never checks for a
model credential; the launch spec's `env` comes from the provider plugin and
Switch Console's settings, and the desktop's own `ANTHROPIC_API_KEY` is
forwarded to *local* terminal sessions only. A remote session works because a
person logged the CLI in on that host by hand. Nothing provisions it and nothing
notices it is missing.

### The watcher is on the wrong side

The thing that notices "someone addressed an agent that has no live session" is
`NotificationWatcher`, and it runs inside the sidecar: a stream opened with
`scope: 'all', filter: 'addressed', spawnCapable: true`, a per-room in-flight
guard, and a spawn if nothing is already attending.

That is a good design for a machine that is already running. It is circular for
hosting: if the sidecar does not exist yet, nothing is listening.

The server knows this and says so. `connection_model` is one of `always_on`,
`session_addressable`, `session_passive`, `auto_session`, and for an
`auto_session` agent with a watcher connected the server posts *"Starting a
session to handle this — one moment."* on the agent's behalf and waits. With no
watcher connected, what the room actually gets is *"@owner — I'm not online in
this room, and @asker needs me. Open Switch Console to bring me online here."*
The reasoning behind that wording is in the function's docstring rather than in
the room: an `auto_session` agent "is brought online by Switch Console watching
on its owner's machine", so "the fix is for the OWNER to open it, and nobody else
in the room can act."

The model is already there. Only the actor is missing.

### There is no server-side control plane

Nothing in `core/switch_core` can create or run anything. `AgentSession` is
documented as tracking "agent reachability and MCP-session room bindings"; its
rows are written by `touch_heartbeat` in response to a client calling in.
`AgentRuntimeState` mirrors state *reported* by a session. The closest thing to a
launch endpoint is `gateway/known_agents.py`, which renders a shell command for a
human to paste. The server has a complete picture of what is running and no way
to change it.

The server also cannot be scaled out. The Helm chart fails the render outright:
`switchCore.replicaCount must be 1`. Whatever supervises a fleet of sandboxes
either lives in that one process or lives somewhere new.

### There is no chat surface

There is nowhere for a hosted customer to talk to their agent.

The gateway API has thirteen routers and none of them read or post messages;
`rooms.py` has twenty-two routes covering roles, groups, protection, membership
and archiving, and not one touches the conversation. The only *API* for reading
and writing messages is the agent-facing one — `read_context`, `post_message`,
`send_targeted_message`, `send_attachment` — though the collaboration bridge
moves the same rows on behalf of humans in Slack and the rest. What does not
exist is a surface a person can point a browser at: the dashboard has no message
list and no composer.

Every human conversation in Switch today therefore goes through a collaboration
bridge, and every bridge is an admin-created row with an operator-pasted
credential. Slack is Socket Mode with a bot token and an app token; Teams is
app-only client credentials. There is no OAuth install flow for any platform and
no callback route to build one on.

So the enrollment path for a stranger dead-ends immediately after "your agent is
running."

### The security posture is a policy plane with no enforcement plane

Nothing in this repository sandboxes, restricts or limits an agent session today,
because the machine belongs to the person running it and the operating system is
the boundary. Hosting removes that boundary and supplies nothing in its place.
§8 has the detail.

---

## 2. What has to be true

Five things, and the runtime is the only one that exists:

1. A session runs somewhere we operate, isolated from every other session.
2. The server can start, stop and destroy one.
3. The server, not a desktop app, notices that a session should start.
4. The customer can reach their agent in a conversation.
5. Somebody's credential pays for the model, and the licence permits it being
   that somebody's.

The rest of this document takes them roughly in that order — the chat surface
waits until §11, because what it should be depends on who is enrolling and why.
§10 then argues about whether to do any of it.

---

## 3. Where a session runs

### The unit

The unit of identity and state is the **agent**, not the tenant and not the
conversation. A tenant-wide sandbox shares a blast radius between agents that may
have different working directories and different credentials. A per-conversation
sandbox throws away the working directory every time a conversation ends, which
is exactly what the sidecar's durable session registry exists to avoid.

A *machine*, though, is shorter-lived than an agent. Under the recommendation
below it is destroyed when the agent goes idle and started again when it is next
addressed, so the agent's durable state has to outlive its machine rather than
live inside it. That is the hardest consequence of the recommendation and it is
worked through under cold start.

The machine is a **microVM** — its own kernel — not a container sharing the
host's. That distinction is the entire security argument: we are running a
stranger's coding agent, which means a stranger's shell, and a shared kernel is
the wrong boundary for that. Worth saying explicitly wherever this is summarised,
because "sandbox" elsewhere often means a container with a seccomp profile.

### The recommendation: ECS Fargate

Stay on AWS. In AWS's own words, each Fargate task **"has its own isolation
boundary and does not share the underlying kernel, CPU resources, memory
resources, or elastic network interface with another task"** — which is the
property §3 needs, stated by the vendor, and it does all the work on its own.
Each task also gets its own elastic network interface in our VPC and its own IAM
task role.

Which gets us the isolation boundary without operating a cluster; egress policy
as a security group rather than a feature request; a real credential boundary
rather than a convention; and, because it is our own account and region, no new
subprocessor and a residency answer that follows from the account.

**ECS Fargate, not EKS Fargate.** EKS on Fargate has neither ARM nor spot
pricing, and it puts back the Kubernetes cluster the whole point was to avoid.

**And not our own existing cluster.** Per-session pods there are the right
long-term shape in the abstract, but that cluster is not hardened for untrusted
workloads and shares a namespace with the database holding every room's messages.
Putting a stranger's shell there is a decision about the database, not a decision
about hosting.

Source: `docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html`.

### Cold start is the central engineering risk

AWS's task-startup guidance puts a new Fargate task at **thirty to forty-five
seconds or longer**, and practitioner reports range wider depending on image
size. The billing clock starts when the image pull begins, not when the container
is healthy. Both are AWS's figures rather than our measurements, which is why
phase 0 measures them before anything is built on top.

Set that against the trigger this design exists to serve: somebody addresses an
agent in a chat window and waits. Forty-five seconds of silence is the difference
between a product that feels alive and one that feels broken.

Three mitigations, in ascending order of effort:

- **An aggressively small image.** Node, `tmux`, `git`, the sidecar bundle and
  one agent CLI. Every megabyte is pull time on the critical path.
- **Seekable OCI lazy image loading**, which AWS reports as the highest-return
  optimisation available here at over fifty per cent — its number for its own
  workloads, not ours.
- **A small pre-warmed pool** rather than scaling to zero.

**The pool buys less than it looks like, and permanently.** A Fargate task takes
its volume configuration at launch and cannot attach an existing volume
afterwards. So a pooled task can be waiting, but it cannot then adopt a specific
agent's disk — which means a pool removes the infrastructure half of wake latency
and nothing else, by construction rather than pending a workaround.

That has a consequence the rest of this design has to carry: **durable per-agent
state cannot live in the task.** It is either a filesystem mounted at launch — so
the task is created for one agent and the pool is a pool of *unassigned* tasks
that can never be reassigned — or a restore from object storage after the task
starts. Neither is free and neither is currently anywhere in the design. The
honest remaining question is not whether a pool can adopt state, which is settled
and negative, but **how long a restore takes**, which nobody has measured.

### The honest trade against the specialists

Two vendors were evaluated and rejected; a third was not evaluated at all.

- **Fly Sprites** — persistent VMs with root and a durable root filesystem,
  created in a second or two, with automatic sleep when idle. Three billing
  states, of which only *running* is billed. Roughly $0.07 per CPU-hour and
  $0.04375 per GB-hour. Live checkpoint in around 300 ms and restore well under a
  second. Coding agents are the advertised target workload.
- **E2B** — the one most widely used by other agent products. $0.000014 per
  vCPU-second and $0.0000045 per GiB-second. Session length is capped by plan
  tier: one hour on the entry tier, twenty-four hours above it.
- **Northflank** — **not evaluated.** It is the one option that would run in our
  own cloud account, but nobody has established its price, its restore latency or
  whether it pauses at all, so it is named here only so that it is not silently
  dropped. It belongs in the phase 0 measurement, not in this comparison.

**What we give up is pause.** The specialists snapshot and restore a paused
machine in well under a second and charge nothing while it sleeps. Fargate has no
third state: a session is running and billed, or gone.

### The numbers, including the case where we lose

Estimates throughout, with the assumptions stated.

Per *running* hour, for a 2 vCPU / 4 GB shape, Fargate is cheapest. Its published
`us-east-1` rates are about $0.04 per vCPU-hour and $0.0044 per GB-hour, giving
`2 × $0.04 + 4 × $0.0044 = $0.098`. European regions run higher; ten to thirty
per cent is a working assumption here rather than a quoted rate, so call it
**$0.10 to $0.13**. ARM is around twenty per cent cheaper again.

| Per running hour, 2 vCPU / 4 GB | |
|---|---|
| Fargate (Europe, estimated) | $0.10 – $0.13 |
| E2B | $0.17 |
| Fly Sprites | $0.32 |

That is the flattering denominator, and it is not the one the workload lives in.
A hosted agent is expected to be **mostly idle**, and Fargate cannot be idle
cheaply. Take the same agent worked one hour a day:

| One hour a day, per month | |
|---|---|
| Fargate, destroyed when idle | ~$3.60, plus a cold start on every wake |
| E2B, asleep the rest of the time | ~$5 |
| Fly Sprites, asleep the rest of the time | ~$9 |
| Fargate, kept warm to hide the cold start | ~$86 |

**Warm Fargate is the most expensive option on the table by an order of
magnitude.** E2B beats it below roughly seventy per cent duty cycle and Sprites
below roughly forty — and a mostly-idle agent is nowhere near either. So the
specialists dominate warm Fargate on price *and* on wake latency simultaneously.
Fargate wins on price only in the destroy-when-idle regime, which is exactly the
regime that pays the cold start this section calls the central risk.

**The recommendation therefore does not rest on price, and should not be
defended on it.** It rests on two things that are real and independent of cost:
no new subprocessor holding customer code, and infrastructure we control in a
region we choose. Those are strong arguments. If the phase 0 cold-start
measurement comes back badly enough that a warm pool is mandatory, the price
argument inverts completely and this decision should be reopened rather than
defended.

And the latency gap is wider than the boot numbers suggest, not narrower. A
paused machine keeps its processes, so a specialist's sub-second restore really
does return a session that carries on. **A destroyed task does not**: the agent
CLI's in-memory context goes with it, and what comes back is a terminal with a
dead socket in it. So Fargate's wake is not thirty to forty-five seconds, it is
thirty to forty-five seconds *plus* a state restore *plus* whatever reloading the
agent's context costs — against something close to zero. Session resumption is a
design question in its own right (see the open questions), and it is one the
recommendation creates and the alternative largely avoids.

On residency: **Fly places a sprite near the caller and does not currently let
you choose a region.** Placement looks sensible in practice — a Berlin user gets
Frankfurt — but "usually nearby" is not a commitment a data-processing agreement
can rest on. A gap needing a contractual answer, not a disqualification. Sources:
`fly.io/sprites`, `e2b.dev/pricing`, `aws.amazon.com/fargate/pricing/`, and the
Fly community thread at
`community.fly.io/t/where-do-sprites-dev-sprites-live-as-in-which-fly-io-region-is-it/26775`.

Renting from any of them would also make that vendor a **subprocessor of customer
code and prompts**, requiring a contract, a security review and an entry in a
privacy notice. Staying in our own account removes one layer of that. §10 is
about the layer that remains.

### Rejected: rootless containers

Podman was raised as a cheaper boundary, and it deserves a fair hearing rather
than a reflex. A shared kernel is a reasonable posture when you have contractual
recourse against whoever runs the code — most CI systems work exactly this way
and run arbitrary build scripts all day. The question is not whether a shared
kernel is secure but how strong the boundary needs to be given who is on the
other side of it, and for anonymous free-tier users running whatever a model
decides to type there is no contract and no recourse.

A practical point settles it anyway: if the task is already a microVM, the task
*is* the boundary. Podman inside it is a second boundary inside the first, for no
gain, and Fargate blocks the privileges nested containers usually want.

### What is decided and what is not

Decided: ECS Fargate, in our own account and region, one task per agent, with a
small image and lazy image loading from the start rather than retrofitted — on
the subprocessor and control arguments, not on price.

Not decided: whether a warm pool is needed at launch; how durable per-agent state
is carried, given a pooled task cannot adopt a volume; and what wake latency is
actually acceptable, which is a product judgement nobody has made. Phase 0 exists
to answer the first two with measurements.
## 4. What is reused and what is discarded

| Reused as-is | Discarded |
|---|---|
| The sidecar bundle — stream, watcher, spawner, injector, state store | The SSH transport, and `listSshConfigHosts()` as host identity |
| `AgentLaunchSpec` as the launch contract | The Electron bundle resolver and `extraResources` packaging |
| The `SidecarHost` seam (`exec` + `putFile`) | The interactive setup runner and its refusal to run a whole plan |
| The tmux session model and prompt injection | The deploy lock, bundle-hash dedupe and reattach logic |
| Startup and stall watches that report failures into the room | Log trimming on relaunch |
| The event stream, cursor and `Last-Event-ID` resume | The assumption that a model credential is already on the machine |

The image is the bundle plus a current Node (22 or 24 — the sidecar's floor is
18, but 20 is end of life and a new image should not start there), `tmux`, `git`,
and one agent CLI. Nothing else, because §3 makes image size a latency budget
rather than a housekeeping preference.

Hosting simplifies the delivery seam rather than reimplementing it. `SidecarHost`
is `exec` plus `putFile`; on Fargate the image *is* the file delivery, so
`putFile` mostly disappears and the launch spec arrives as a container override
or from a secret store at task start. Both paths coexist easily at that size — a
self-hosted user keeps SSH, a hosted one gets the task API — and keeping the
interface is what stops the two diverging the way the two on-demand-start
implementations already have.

What remains of `exec` is served by ECS Exec, and that is not free: it requires
`ssmmessages` permissions on the task role, it is incompatible with a read-only
root filesystem, and its sessions run as root. So it is **enabled per task, for
the tasks that need it** — principally the interactive sign-in in §6 — rather
than switched on across the fleet. §8 states the resulting default.

The one genuinely new piece inside the sandbox is credential delivery, and it is
new because today there is nothing there at all.

---

## 5. The control plane

### What has to exist server-side

A record of a sandbox and its lifecycle, and something that drives it:

```
hosted_sandboxes
  id, agent_id, task_arn, region, image_version,
  state (provisioning|running|stopping|stopped|failed),
  created_at, last_active_at, stopped_at, stop_reason
```

Plus a supervisor with three verbs — start, stop, destroy — and a reconciler,
because our view and the task's will disagree and the task is right. Everything
else is bookkeeping.

There is deliberately no `asleep`. Fargate has no pause, so a session is running
or it does not exist, and modelling a sleeping state the platform cannot provide
would be the kind of comfortable fiction that produces a support ticket six
months later. If a warm pool arrives it is a separate concept — a task that
exists and has not yet been assigned an agent — and it should get its own table
rather than a fourth value in this column.

The state column is not decoration. It is what a support conversation is
conducted against, what a metering job sums over, and what tells the room why an
agent did not answer instead of the current guess.

### Moving the watcher

The watcher moves into the server. It is a small change to a component that
already exists on both sides of the wire: `AgentClient` already decides that a
message addresses an agent, already knows the agent's `connection_model`, and
already posts *"Starting a session to handle this — one moment."* For a hosted
agent, the branch that posts that message calls the supervisor instead of waiting
for a desktop watcher to notice.

The sidecar's watcher stays. Both must exist, and the failure mode of having two
is a double-spawn, so the in-flight guard has to be server-side and authoritative
rather than per-process. A hosted agent should have the sidecar's own watcher
gated off — the `watch-enabled` flag it already re-reads every poll is the
mechanism, so nothing new is needed to express it.

The documentation already warns about this pair drifting: *"Fixing on-demand
start in Console does not fix it on a remote host."* Adding a third
implementation server-side makes that worse, not better. The honest end state is
that the server owns the decision and both clients only execute it. That is
larger than this phase and should be named as the direction rather than pretended
away.

### The single-process problem

`switch-core` refuses to run more than one replica. A supervisor for N sandboxes
inside that process inherits the constraint: one deploy, one restart, and every
sandbox's reconciliation loop stops. That is tolerable at ten sandboxes and not
at a thousand, and it is worth deciding early whether the supervisor is a module
in `switch-core` or a separate service that talks to the same database. The
cheap answer is a module with all its state in Postgres and no in-memory
authority, so extracting it later is a deployment change rather than a rewrite.

---

## 6. Credentials and payment

This is the section that decides the product, and it is decided by somebody
else's licence rather than by us.

### What Anthropic's terms say

From `code.claude.com/docs/en/legal-and-compliance`, under *"Can customers offer
Claude Code in their products?"*:

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in
> your products or services (e.g. in hosted sandboxes or other agent
> infrastructure) requires agreeing to our Commercial Terms of Service and
> complying with the conditions below:
>
> - **The Claude Code binary must not be modified.** Claude Code must be
>   installed and run as published by Anthropic, and customers may not remove,
>   disable, or restrict any authentication method built into it (including
>   methods that permit signing in with a Claude account or the user's own API
>   key).
> - **Customers may not pay for, resell, or intermediate Claude usage on their
>   end users' behalf.** Each end user must authenticate with their own Anthropic
>   API key, Claude subscription plan credentials, or 3P inference provider
>   credential (Amazon Bedrock, Google Cloud's Agent Platform, Microsoft
>   Foundry). That usage is billed directly to the end user under their own
>   agreement with Anthropic or, for third-party inference providers, with the
>   applicable provider.

And, under *Authentication and credential use*:

> This does not restrict how customers provision and manage their own API keys or
> third-party inference provider credentials — for example, configuring an API
> key in a development environment, secrets manager, or machine image for use by
> the customer's own authorized users — provided the resulting usage is billed to
> the key owner under their agreement with Anthropic (or the applicable provider)
> and is not resold or intermediated as described above. Nor does it prevent an
> end user from signing in to the unmodified Claude Code binary with their own
> Claude subscription, including where a platform hosts Claude Code as described
> under *Can customers offer Claude Code in their products?* above.

Read plainly: **hosting Claude Code is explicitly contemplated and explicitly
permitted, on conditions.** A hosted Switch where the customer brings their own
credential is allowed. A free tier that runs Claude Code on our tokens is not.

That last sentence is narrower than it looks, and §9 turns on the difference: it
closes the door on *Claude* usage we pay for, and says nothing at all about a
different model from a different vendor under a different contract.

Three consequences that are not obvious from the headline:

- It requires **agreeing to the Commercial Terms of Service**. That is a
  commercial action taken by a person with authority, not an engineering task,
  and it should be started before the work is, not after it.
- We must not disable any built-in authentication method. Anything that forces
  a single credential path — including a well-meaning "we manage this for you"
  — is on the wrong side of the first condition.
- Naming is constrained. We can say in plain text that Switch runs Claude Code.
  We cannot name a feature after it or use the marks in a way that implies a
  partnership.

### The model

**The customer brings their own credential, per end user, billed to them.** An
API key pasted at enrollment is the clean path and is the case the terms address
in as many words: provisioning your own key into a machine image for your own
authorized users, billed to the key owner.

Subscription sign-in is harder, and the adverse text belongs in front of the
reader in full rather than in the convenient half. The same page says:

> Anthropic does not permit third-party developers to offer Claude.ai login into
> their own applications, or to route requests through Free, Pro, or Max plan
> credentials on behalf of their users. Moreover, developers may not collect,
> store, or intermediate Claude.ai credentials or session tokens — sign-in to a
> Claude account must complete through Anthropic's own flow.

The second sentence rules out proxying the login, which is why an end user would
have to complete it themselves against a terminal inside their own sandbox. But
**the first sentence is arguably a direct description of that arrangement** — a
platform putting a login in front of its users and then running their requests on
subscription credentials — and it sits immediately before the carve-out quoted
above, which permits an end user "signing in to the unmodified Claude Code binary
with their own Claude subscription" on a platform that hosts it.

Those two readings point in opposite directions and this document cannot resolve
them. The honest expectation is **no** for anything resembling a sign-in screen
of ours, and plausibly yes only for a raw terminal in which the user runs the
vendor's own command themselves. The API-key path avoids the question entirely,
which is a reason to make it the default rather than the fallback.

Note that the same shape applies to the other providers. Codex and OpenCode have
their own terms and their own answers, and nothing here should be generalised
from Anthropic's page to all three without reading them.

### The consequence for the multi-tenancy plan

The multi-tenancy spike's quota phase opens with *"Every agent turn costs LLM
money, so one customer's runaway loop is our bill."* Against these terms that
premise does not hold for Claude Code. Under a bring-your-own-credential model a
runaway loop is the customer's bill, at the customer's provider, and our
exposure is the sandbox it runs in.

That is not a small correction. It moves the hard stop from tokens, which we
cannot enforce, to compute-seconds, which we own outright — see §7. Whoever picks
up that phase should read this section first, because building token quotas for
a cost we do not carry is work spent in the wrong place.

---

## 7. Metering and abuse

**Switch is not in the request path.** The model call goes from the customer's
CLI, inside the sandbox, straight to the provider. No amount of accounting in
`switch-core` sees it.

That leaves four options and only two of them enforce anything.

- **Own the credential and cap it at the provider.** The cleanest hard stop, and
  unavailable on the paid path because §6 says the credential is the customer's.
  It becomes available again on the free tier, where the account is ours — see
  §9.
- **Run an inline proxy.** Point the CLI at a base URL we control and the request
  path is ours again. This is the only way to hard-stop model spend, and it is
  the shape of the option in §9. Whether a proxy carrying the *customer's own*
  key, billed to the customer, counts as "intermediating Claude usage on their
  end users' behalf" is genuinely unclear — the end user is the key owner, which
  reads more like a corporate egress proxy than resale, but the word
  "intermediate" is doing a lot of work and we should not guess.
- **Client-reported usage.** Claude Code can emit a cost estimate per
  invocation. It is useful, it is cheap, and it is reported by a process the
  tenant controls. **Telemetry, not enforcement**, and it must be labelled that
  way everywhere it is displayed so nobody later builds billing on it.
- **Meter and cap the thing we actually pay for: task wall-clock.** We start the
  task, we hold its handle, we can stop it. A budget in task-seconds is
  enforceable and maps exactly onto our cost — Fargate bills **per second, with a
  one-minute minimum**, so the accounting and the limit are the same unit down to
  the second rather than an approximation of each other.

The last one is the answer. It is also a better fit for the multi-tenancy
document's own rule that "a limit that only alerts is not a limit", because it is
the only limit here that can be made true.

Note the interaction with §3: the cheapest way to run a hosted fleet is to
destroy idle tasks, and destroying idle tasks is also the metering enforcement.
The cost control and the abuse control are the same mechanism, which is a good
sign about both.

What it does not cover is abuse that costs us nothing directly: using a hosted
task as an egress point for scanning, spam or mining. Compute caps bound it but
do not address it; that is a security-group question and belongs in §8.

On free-tier farming the multi-tenancy spike's reasoning carries over unchanged —
cap what an account can spend rather than how many accounts can exist. Hosting
adds one lever it did not have: a free tenant's task is destroyed the moment it
goes idle and never started on a schedule, so a farmed account that nobody talks
to costs nothing at all.

---

## 8. Isolation and the threat model

### What we would be doing

Running an agent, controlled by a customer, executing a model's decisions, in
infrastructure we operate, with a shell. Every part of that sentence is a
liability.

Threats, roughly in order of how much they should worry us:

1. **Escape to other tenants or to our infrastructure.** The microVM boundary is
   the answer, and it is the reason §3 insists on a real kernel rather than a
   container. This is the threat that is solved by choosing correctly, once.
2. **Egress abuse.** A sandbox with unrestricted network is a free machine on the
   internet with our name on its IP address, and neither a VM boundary nor a
   compute cap addresses it. Default-deny outbound with an allowlist for the
   model provider, the Switch API and the package registries the agent
   legitimately needs. On Fargate this is a security group on the task's own
   network interface — an existing mechanism rather than something to build,
   which is one of the better arguments for the placement in §3. It is also the
   control most likely to be skipped under time pressure, so it belongs in the
   first phase rather than a hardening phase.
3. **Credential blast radius.** The sandbox holds the agent's Switch API key and
   the customer's model key, and its task role is a third credential. One
   sandbox per agent bounds the damage to one agent's room scope and one
   customer's model spend, which is an argument for the unit chosen in §3
   independent of cost. The Switch credential should be short-lived and issued by
   the supervisor per task rather than baked into an image. The task role should
   grant **nothing beyond the `ssmmessages` actions ECS Exec requires**, and only
   on the tasks where the exec path is enabled at all (§4) — a session has no
   other legitimate reason to call our cloud API.
4. **Prompt injection reaching across rooms.** Content arriving in a room can
   instruct an agent. Switch already has answers here — room scoping, the scoped
   addressing policy, owner-only defaults for new agents — and hosting does not
   make the mechanism worse. It makes the *consequences* worse, because a hosted
   session runs with nobody watching a terminal.
5. **The control plane itself.** A supervisor holding credentials that can create
   machines is a high-value target living in the same process as the agent-facing
   API.

### What we must not inherit

The current posture is a policy plane with no enforcement plane, and every part
of that is worse than it first sounds. Verified against the tree:

- **An agent reached over SSH defaults to bypassing permissions.** Switch Console
  sets `autoApprove` from whether the agent's host is remote, and its own comment
  says why: remote agents "run unattended on their VM with no operator to answer
  permission prompts". That translates into the provider's own bypass flag at
  launch. The reasoning is sound for a machine its owner set up, and it is
  precisely the reasoning that must not survive into a machine we set up.
- **The hook suppresses the prompt rather than adding to it.** The pre-tool-use
  handler emits only `allow` or `deny`, never `ask`, so a permissive verdict
  removes the agent's own confirmation step instead of layering a second check on
  top of it. A mediation plane that can only make things more permissive is not a
  safety mechanism.
- **It matches on names, and the server never looks at arguments.** The
  server-side decision is a name-membership check against the agent's attached
  tool rows; the docstring says outright that arguments are accepted but not
  inspected.
- **Shell is on the default list.** Both the Claude Code and OpenCode known-agent
  definitions seed `Bash`, and Codex seeds `Shell`. Since the check is by name
  and shell is allowed, everything reachable from a shell is allowed, which is
  everything. The name-based check is decorative in the presence of that one
  entry.
- **It exists for one host of three.** Only the Claude Code connector ships a
  hook. Codex and OpenCode register with no pre-invocation mediation at all, and
  the Codex definition says so in a comment: it "runs auto-approved".
- **It is cooperative, and the hook says so.** When the mediation call fails the
  hook lets the tool run unmediated, and there is no server-side fallback,
  because these are the CLI's own local tools executing in its own process and
  they are never proxied through Switch. Post-tool mediation returns `ok`
  unconditionally today.
- **Nothing anywhere in the repository sandboxes, restricts or limits an agent
  session** — no seccomp, no cgroup, no filesystem restriction, no egress rule,
  no resource cap. A session is an ordinary process with the full authority of
  the account it runs under.

None of that is a criticism of the local product, where the operating system and
the person at the keyboard are the real boundary and the hook is a useful record
of intent. It is disqualifying for hosting, where neither of those exists.
**The mediation hook must not be counted as a control in any hosted design.**
The enforcement plane for a hosted session is the VM boundary, the security
group, the filesystem it can reach and the clock — mechanisms outside the agent's
own process, which cannot be talked out of a decision by a model.

Concretely, a hosted session defaults to: a task role granting nothing beyond
what ECS Exec needs, on the tasks that need it; no credentials in its environment
beyond the two it must have; a writable filesystem limited to its own working
directory; default-deny egress; and a compute cap that stops it. Getting those
five right matters more than any amount of tool-level policy, and none of them
requires the agent's cooperation.

One of them cannot be had as stated. A **read-only root filesystem is
incompatible with ECS Exec**, and ECS Exec sessions run as root — so the sign-in
flow of §6 and the strongest filesystem posture are mutually exclusive on the
same task. Keep them apart in time: exec enabled for enrollment, disabled for the
working life of the session, and any task still carrying it treated and displayed
as one with a weaker posture.

One thing to fix regardless of hosting: the generic registration endpoint accepts
a caller-supplied tool list with no validation, so an agent registering outside
the known-agent path declares its own allow list. That is defensible when a
registration token means someone with a machine chose to run something, and
indefensible once registration is a self-serve action.

---

## 9. The free tier: an open model on our own account

§6 closes a door. This section looks for the one next to it.

The proposal was to ship OpenCode rather than Claude Code against a model we pay
for: OpenCode is not Anthropic's binary, so §6's terms do not bind it; owning the
credential is what §7 says a hard stop requires; and it removes the worst step in
enrollment, since a stranger who must produce an API key before seeing anything
is a stranger who does not see anything. The standing objection was that paying
for external customers' usage raises the same resale question with whichever
provider we use that Anthropic's terms raise for Claude.

### The door that is open

The reading this section rests on is that **serving a third-party model on
Bedrock to our product's end users, including free ones, is permitted** — the
ordinary SaaS-wrapper pattern — and that what is prohibited is handing customers
raw API-level access to the model, and training a competing model on it. Neither
of those describes what we would be doing.

**That reading is not verified here, and it is the only major external claim in
this document with no quotation behind it.** Everything in §6 is quoted from a
named page; this is not, and it is a legal claim doing more work than any other
sentence in the section. Two things make it worth checking rather than assuming.
The operative instrument is probably not "AWS's terms" generically but **the
model provider's own end-user licence as presented through the marketplace at
subscription time**, which differs per model. And some providers' licences
restrict use to the subscribing customer's *internal business purposes* — if the
one attached to the chosen model does, this free tier is dead and the section
does not survive it.

So: name the instrument, quote the operative clause the way §6 quotes Anthropic's,
and only then schedule anything. Until that is done it is an open question, and
it is listed as one.

So the resolution to the credential problem the rest of this document sets up is:

> **A free tier on a cheap open model through our own account. The customer
> connects their own Claude or OpenAI credential when they want the good
> models.**

It also simplifies §7. On the free tier we *are* the account holder, so the
strongest of the four metering options — own the credential and cap it at the
provider — becomes available after all. What owning the account does not give us
is *per-tenant* attribution, and whether that comes from provider-side request
tagging or from a gateway of our own is open. The global cap is the safety net;
the per-tenant cap is the product.

### The candidate

**Qwen's 30B coder model**, served on Bedrock on demand. It is available in
Ireland, Frankfurt, Milan and Stockholm — all inside the European footprint the
rest of this design assumes, so it does not reopen the residency question. And it
is genuinely capable at agentic work rather than only at chat, which is the
distinction that matters for a harness that expects tool calls rather than
prose.

On cost: roughly **$0.13 per active session-hour**, against about **$3.90** for a
mid-tier commercial model on the same assumptions. State the assumptions, because
they do the work — about sixty model calls an hour over a growing context, with
no prompt caching applied. That is deliberately unflattering to the commercial
model, since caching is exactly what a real deployment would use. It is the right
comparison for a free tier all the same: a free tier is where caching is least
likely to be working, because sessions are short, cold and unrelated.

The absolute figures matter less than the ratio: **thirty to one**, on
assumptions chosen to flatter the expensive option.

### Self-hosting: ruled out, with numbers

The obvious next thought is to run the open model ourselves on GPU instances and
avoid the per-token bill entirely. At the duty cycle a free tier actually
produces — bursty, mostly idle, five to twenty concurrent sessions at around ten
per cent utilisation — **owning the GPU costs twenty to a hundred and sixty times
the API price for the same model.**

The sharpest way to put it: self-hosting a cheap open model would cost more per
session than paying full price, per token, for a top-tier commercial model. That
is not a marginal call requiring a spreadsheet, it is two orders of magnitude.

Part of the cause is structural rather than economic. The European regions we
would deploy in have no current-generation datacentre GPUs available on demand at
all, so every throughput figure in the analysis is an optimistic extrapolation
from hardware we could not actually rent. The real number is worse than the
stated one, not better.

### What the cheap models actually get wrong

This is the part that a leaderboard will not tell you, and it is the reason the
recommendation is a process rather than a name.

Every cheap model surveyed has a dated, concrete failure mode in exactly this
class of harness. One has a reproduced infinite-loop bug in OpenCode's own issue
tracker. Another has a structural tool-calling protocol mismatch despite strong
benchmark scores — it scores well and then cannot drive the harness. And the
choice of inference backend alone has been observed to swing a single model's
measured score by forty points, which means "which model" is not even a
well-formed question without "served by what".

**So the recommendation is to validate a model-and-backend pairing against the
harness's own issue history before shipping it, not to pick from a leaderboard.**
That validation is a phase-6 task with a real cost, and pretending otherwise is
how a free tier ships that loops forever on its first conversation.

One licence caution independent of all of the above: **some open-weight releases
carry a restriction keyed to the licensee's domicile rather than to where it
deploys.** One Meta licence was checked and has no such clause, so this is
emphatically not a reason to exclude any vendor wholesale — it is a reason to
read the licence of the specific release being evaluated, because the answer is
per-release and turns on our own entity rather than on our region.

Meta's new closed flagship was also raised and is the wrong tier — priced like a
mid-range commercial model, with a cheap variant conditional on the vendor being
allowed to train on prompts, which a governance product cannot accept on its
customers' behalf.

### What stays uncertain

Two cautions from the original objection survive and should not be lost in the
good news.

- **Anything in the request path that logs prompts becomes a place where customer
  code is stored** — and unlike a per-agent sandbox, it is one system holding
  every tenant's code, which is the worst available blast radius for the most
  sensitive data in the product. If a gateway is built for per-tenant
  attribution, prompt logging is off by default and turning it on is a decision
  with a paper trail.
- **The trial is a different product from the paid one.** If most customers
  intend to run Claude Code, a free tier on OpenCode and an open model is not a
  trial of what they will buy. That is survivable when it is deliberate and
  stated on the page; it is a problem when a user discovers it by being
  disappointed.

Assessment: build it, as the free and trial tier only, explicitly not as the paid
path. It is not a substitute for the bring-your-own-credential model of §6 — it
is what lets someone see the product before deciding to bring one.

---

## 10. Why we might not do this at all

The strongest argument against is not technical.

**It contradicts what we say.** The README's third "what Switch is not" is *"Not
a black box self-service platform... designed to be self-hostable and for your
data to stay where it is."* The user documentation says Switch "starts the
providers you already use on your machine, under your credentials." Hosting
inverts both. Doing it anyway is defensible, but only if the positioning changes
with it, in the same release, on purpose. Shipping a hosted tier while the
homepage still says data stays where it is would be the worst outcome available.

**It makes us a processor of customer code and prompts.** Today a compromise of
Switch leaks messages. A compromise of a hosted Switch leaks working
directories. That is a different category of incident, and it brings a data
processing agreement, a subprocessor list, breach notification obligations, a
residency answer and a security review that a self-hosted product simply does not
have to pass. As a European company selling to European customers, none of that
is optional or deferrable.

**It is a different business.** Hosting is an operations business with a
round-the-clock expectation. Deployment is manual today, the platform carries the
usual debts of something built at pilot scale, and nobody is on call. Adding
customer workloads to that is adding a promise we have no mechanism to keep.

**The market has already run this experiment.** From a separate market review
rather than from anything derived here: every vendor who built hosted agent
execution themselves repriced upward during 2026 once real per-session costs
landed. No vendor is named and no underlying data is reproduced, so treat it as a
read rather than a citation. The honest counter is that their exposure was the
model bill and
ours would not be — under §6 the customer pays for inference and we pay for
compute, and compute is the part that has commoditised. That materially changes
the outcome, and it is worth saying so rather than treating the repricing as a
verdict on all hosting.

**And the argument for.** Sandbox infrastructure is now a commodity, so the cost
of trying is low. From the same market review: the closest competitor to Switch's
pitch shipped a coding agent into team chat in August with governance at the
protocol level — again unnamed here and unsourced — so "agents in chat" is no
longer differentiating on its own. The genuine white space is
multiple agents *from different vendors* collaborating in one room under one
governance layer — something no single-vendor product has a reason to build.
That is the thing worth demonstrating, and today demonstrating it requires
somebody to install three CLIs. **Hosting is how the differentiator becomes
visible.** If it is built for any reason, it should be built for that one, which
also implies a much smaller first version than a full self-serve tier.

The middle path, if the positioning objection wins: host the demo, not the
product. A hosted agent that is explicitly a trial, time-limited, labelled as
running on our infrastructure, with the self-hosted path as its destination. It
answers "can I see it?" without claiming to be where customer code should live.

---

## 11. The enrollment path

What a stranger actually walks, and what each step depends on:

1. **Sign up and create a workspace.** Multi-tenancy spike, phases 1 and 2. Not
   in this document's scope and entirely blocking for the self-serve case.
2. **Add an agent.** Name, provider, and nothing else — no working directory to
   choose, because a hosted agent starts with an empty one.
3. **Provision.** The supervisor starts a task from the image with the Switch
   credentials and the launch spec as overrides, and the sidecar comes up. Tens
   of seconds on the numbers in §3 — which is acceptable here, where the user is
   watching a progress indicator they asked for, and is exactly the same latency
   that is not acceptable in step 5.
4. **Supply a model credential.** Paste an API key, or open a terminal into the
   sandbox and sign in. This is the step that loses people, and §9 exists mostly
   to remove it for a first look.
5. **Talk to the agent.** Needs a chat surface — see below.
6. **Optionally, connect Slack.** Multi-tenancy spike, phase 4.

Steps 1, 5 and 6 are all downstream of other work, which makes the self-serve
case downstream of the multi-tenancy spike as a whole. That is a scheduling fact
worth stating plainly rather than discovering in the middle of it.

### The chat surface

Four options for step 5:

- **The official Slack app.** The best fit with the positioning — we do not
  replace your chat — and the real product path. But it makes a stranger's first
  conversation depend on having a Slack workspace and, in most companies, an
  admin approving an app install. That cannot happen inside a signup flow.
- **A minimal message list and composer in the gateway.** New endpoints over the
  same `messages` table, and a single view in the dashboard. It is the smallest
  thing that makes signup work end to end, and the gateway wants a message read
  surface anyway for support and audit — today an operator investigating a
  complaint has no way to see a conversation at all.
- **An embed of an existing client.** Switch Console already does this for
  platforms that support it. Not available on the web without the platform, so
  it does not solve the stranger case.
- **Telegram or Discord as the first surface.** Genuinely lower friction — a
  Telegram bot needs nobody's approval — but it is not where companies work, and
  a first impression formed in Telegram is a first impression of the wrong
  product.

Take the second. Signup-to-first-message must not depend on a third party's
install review, and the read half is wanted regardless.

The objection is real: building a chat UI is precisely the thing the README says
we are not doing. The answer is scope discipline rather than a clever
distinction. It is a first-run and support surface: a message list, a composer,
and nothing else. No threads, no reactions, no notifications, no mobile. If it
grows past that, the positioning objection was right.

---

## 12. Decisions

| Decision | Chosen | Alternative and why not |
|---|---|---|
| Isolation boundary | microVM with its own kernel | Rootless containers — a shared kernel is a defensible boundary when you have recourse against whoever is inside it, and we would not. Redundant anyway once the task is already a microVM. |
| Where sessions run | ECS Fargate, in our own account and region | Specialist sandbox vendors — sub-second restore and free sleep, and **cheaper than warm Fargate for a mostly-idle agent**. Chosen against them on subprocessor and account-control grounds, not on price. Northflank was not evaluated. |
| Which Fargate | ECS | EKS on Fargate has neither ARM nor spot pricing and puts back the cluster we are avoiding. |
| Not our existing cluster | Explicitly excluded | It is not hardened for untrusted workloads and shares a namespace with the message database. Putting a stranger's shell there is a decision about the database. |
| Idle handling | Destroy and rebuild, with cold start attacked directly | Modelling a sleep state — Fargate has no pause, and a state the platform cannot provide is a fiction that becomes a support ticket. The cost is that a destroyed task loses the agent's in-memory context, which a paused machine would have kept. |
| Unit of hosting | One task per agent | Per tenant shares a blast radius between agents with different credentials; per session throws away the working directory and the CLI's state every time. |
| Runtime | The existing sidecar, containerised | A new server-side runner — discards working, tested code for no gain. The `SidecarHost` seam is already two methods wide. |
| Delivery mechanism | The image, plus container overrides; keep the `SidecarHost` interface | Replacing SSH — self-hosted users still own machines, and keeping one interface is what stops the two paths diverging the way on-demand start already has. |
| Host identity | A row in the database | An entry in the user's SSH config — meaningless when the user owns nothing. |
| Who decides to start a session | The server | The sidecar's watcher — circular: nothing is listening before the sidecar exists. The server already models `auto_session` and already posts the "starting a session" message. |
| Supervisor placement | A module in `switch-core`, all state in Postgres | A separate service now — premature, but keeping no in-memory authority makes extracting it a deployment change rather than a rewrite. |
| Model credential | The customer's own, per end user, billed to them | Us paying — prohibited for Claude Code by Anthropic's terms, in as many words. |
| What we hard-stop on | Task wall-clock seconds | Model tokens — we are not in the request path, so a token limit is advice. Compute is the cost we actually carry. |
| Client-reported usage | Telemetry, labelled as such | Enforcement or billing — the process reporting the number belongs to the tenant. |
| Permission model for a hosted session | VM boundary, default-deny egress, scoped filesystem, compute cap | Today's defaults — checks disabled off-laptop, name-based matching, shell allowed, one host of three. The mediation hook is not an enforcement plane. |
| First chat surface | A message list and composer in the gateway, scoped to first-run and support | Slack first — depends on an app install review a stranger cannot complete during signup. |
| Free tier | OpenCode on a cheap open model through our own account | A free tier on our Claude credentials — prohibited by the terms in §6. AWS's terms for third-party models permit serving end users, which is the door §6 leaves open. |
| Free-tier model | **A validation process**: drive a model-and-backend pairing through the real harness and check it against that harness's issue history. Qwen's 30B coder is the leading candidate to test first | Picking a model from a leaderboard — the surveyed cheap models each have a dated failure mode in this class of harness, and the inference backend alone can move a score by forty points. |
| Serving the free-tier model | Per-token through our own account | Self-hosting on GPUs — twenty to a hundred and sixty times the price at a free tier's duty cycle, and the European regions we would use have no current-generation datacentre GPUs on demand anyway. |
| Relationship to multi-tenancy | Downstream of it for self-serve; the existing-deployment case ships first | Building hosting first — signup, tenant isolation and the Slack app are all prerequisites for a stranger. |

---

## 13. Plan

Ordered so each phase is useful on its own. The first three are useful to
*existing* users and need nothing from the multi-tenancy spike, which is what
makes them worth doing before any decision about self-serve is taken.

**Phase 0 — the image and the measurement.** Build the task image — sidecar, Node
20, `tmux`, `git`, one CLI — with lazy image loading configured from the start
rather than retrofitted. Add the sandbox record and its state machine. Then
measure the two numbers the design turns on: **cold start end to end**, and the
**idle-to-active ratio of existing sessions**, which is available today from
production data and does not need any of this to be built.
*Done when:* a task can be started by hand, the sidecar comes up in it, an agent
answers in a room, and we know how long that took and how often it would happen.

**Phase 1 — hosted agents for an existing deployment.** The supervisor, task
start and stop, credential delivery, the security group and task role from §8,
and a control in the dashboard. Useful on its own to every current user: your
agent survives your laptop closing without you having to own and maintain a
server.
*Done when:* a user of an existing deployment can move an agent off their machine
from the gateway, supply a model credential, and have it answer in Slack — with
egress locked down from the first day rather than a later one.

**Phase 2 — server-side on-demand start.** Move the watcher decision into
`switch-core`, with an authoritative in-flight guard, and gate the sidecar's own
watcher off for hosted agents. This is where the cold-start number from phase 0
either is acceptable or forces the warm pool.
*Done when:* a mention starts a task and gets an answer, with nothing running on
anyone's laptop, and the room is told what is happening while it waits.

**Phase 3 — metering and the compute hard stop.** Task-seconds per tenant, plan
ceilings, enforced by stopping tasks. Client-reported model cost recorded and
displayed as telemetry, labelled as such.
*Done when:* a tenant out of compute budget has its tasks stopped and can see in
the dashboard why.

**Phase 4 — the chat surface.** Message read and write on the gateway API, one
view in the dashboard.
*Done when:* someone with no Slack can hold a conversation with their agent.

**Phase 5 — self-serve, paid-only beta.** Needs multi-tenancy phases 1 and 2.
Signup creates a tenant, the tenant's first agent is hosted, payment. Call it a
beta and mean it: §9 identifies "bring an API key before you can see anything" as
the step that loses people, and this phase still has it. Phase 6 is the fix, and
the two may well want to ship together rather than in sequence — the argument for
splitting them is only that phase 5 can be measured without waiting on a legal
answer.
*Done when:* a stranger with a card and an API key has a working agent without
talking to anyone.

**Phase 6 — the free tier.** OpenCode plus a cheap open model served from our own
account, with the global spend cap that owning the account makes possible. The
real work here is validation, not plumbing: a model-and-backend pairing has to be
driven through the actual harness and checked against that harness's own issue
history before anyone sees it.
*Done when:* a stranger who has brought no credential at all can hold a working
conversation with an agent, and a runaway one stops at a cap we set.

---

## Open questions

- **What is an acceptable wake latency?** A product judgement nobody has made,
  and the thing the whole cold-start argument in §3 is measured against. Thirty
  seconds with a "working on it" message in the room may be fine; the same thirty
  seconds in silence is not.
- **Is a warm pool needed at launch, and how is durable per-agent state
  carried?** Whether a pooled task can adopt an agent's disk is *not* open — a
  Fargate task takes its volume configuration at launch and cannot attach one
  afterwards, so it cannot. What is open is how long a restore from object
  storage takes, which is the only remaining route to a pool that is worth
  having.
- **What is the idle-to-active ratio of a real agent?** Every number in §3 turns
  on it and we have no data. It is measurable today from existing sessions and
  should be measured before the pooling decision, not after.
- Staying in our own account and region answers residency for us. It does not
  answer whether any target customer requires more than that — a specific region,
  a specific account, or their own. Northflank was the only rented option that
  could have offered the last of those; Fargate can, at the price of operating a
  second deployment path.
- **Will we agree to Anthropic's Commercial Terms of Service, and who signs?**
  §6 makes this a gate on the entire paid path — no agreement, no hosted Claude
  Code, and the plan below has no phase 1. It is a commercial decision with a
  named owner, and it has neither.
- **Will the positioning change, and when?** §10 argues that shipping a hosted
  tier while the public material still says data stays where it is would be the
  worst outcome available. Nobody has decided whether it changes, so nobody has
  decided whether this is buildable as described.
- **What does the model licence behind the free tier actually say?** §9 rests on
  an unverified reading. If the applicable instrument restricts use to the
  subscribing customer's internal business purposes, phase 6 does not exist.
- Does an inline proxy carrying the customer's *own* key count as
  "intermediating" under Anthropic's terms? A legal read, not an engineering
  call, and §9 depends on the equivalent answer from whichever provider sits
  behind our proxy.
- Does a sandbox we operate holding the OAuth token that resulted from the
  customer's own sign-in count as "collect, store, or intermediate Claude.ai
  credentials"? The API-key case is explicitly permitted; this one is not
  addressed anywhere on that page.
- How does an end user complete an interactive provider sign-in in a headless
  sandbox? A browser terminal is the obvious answer and is also a remote shell we
  are handing to a stranger.
- **What does session resumption mean?** Destroying a task loses the agent CLI's
  in-memory context, and no hosting choice fixes that — a restored machine gives
  back a terminal with a dead socket in it, not a conversation that carries on.
  Whether a resumed session reloads context from the room, from the CLI's own
  transcript, or starts clean is a product decision that nobody has taken and
  that hosting forces.
- §5 guesses that one supervising process is fine at ten sandboxes and not at a
  thousand. Nobody has established where between those the `replicaCount must be
  1` constraint actually breaks, or what breaks first — the reconciliation loop,
  the connection registry, or the database pool.
- **Per-tenant attribution for free-tier model spend.** Owning the account gives
  a global cap. Whether per-tenant numbers come from provider-side request tagging
  or from a thin gateway of our own is unresolved, and the second answer puts a
  system holding every tenant's prompts into the request path.
- Our production cluster is in a region with no on-demand models available at
  all, so any model call from our own infrastructure would be cross-region today.
  That is outside this document's scope but it lands squarely on whoever builds
  the free tier.
- Should hosted customers be a separate deployment from self-hosted ones, the way
  the multi-tenancy spike keeps the demo environment separate?
- Who is on call, and what is the promise? Neither has an answer today, and
  neither is an engineering decision.
