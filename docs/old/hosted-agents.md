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

It needs Node 20, `tmux` and `git`, and nothing else. The build script *enforces*
that: a custom esbuild resolver fails the build if Electron, the local SQLite
database or the ORM are ever pulled in transitively. The sidecar cannot acquire
a desktop dependency by accident.

It also touches SSH nowhere. SSH is how Switch Console *delivers* it, and the
seam between the two is two methods:

```ts
export interface SidecarHost {
  exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
  putFile(localAbsPath: string, remoteRelPath: string): Promise<void>;
}
```

One implementation exists, over SSH. Anything that can run a command and put a
file can host the sidecar.

`AgentLaunchSpec` (`src/sidecar/agent-launch-spec.ts`) is the other half: a
plain-JSON launch recipe — command, args, env, cwd, optional files to write into
the home directory, provider id, and two behaviour flags — round-tripped through
base64 and `JSON.parse`. It exists precisely so a headless watcher with no plugin
registry never has to call back into desktop code to work out how to start an
agent. It is already the interface a control plane would want.

Put that bundle in an image and the runtime problem is mostly solved.

### What assumes a human owns the box

The parts around it assume ownership, and would be discarded rather than ported:

- **A host is an entry in the user's own SSH config.** `listSshConfigHosts()`
  parses `~/.ssh/config` and that is the whole of host onboarding. Its own
  comment says authentication "resolves from the SSH config/agent (Switch
  Console stores no credentials)". There is no host record, no inventory, and
  nothing a server could enumerate.
- **The deployer is an Electron app.** `resolveSidecarBundlePath()` imports
  `electron` and resolves the bundle out of `process.resourcesPath`. The bundle
  ships as an app resource, so the app is the only thing that can deploy it.
- **Setup is deliberately interactive.** From the setup runner's own docstring:
  *"There is deliberately no run-the-whole-plan loop — the ordering in a plan is
  guidance for a person, not a script."* That is right for a machine a person
  owns and exactly wrong for provisioning.
- **A deploy lock, bundle-hash dedupe, log trimming and reattach logic.** An
  atomic-`mkdir` mutex with a two-minute staleness break; a hash compare that
  skips the upload when an identical bundle is already there; an 8 MB log
  trimmed to 1 MB on relaunch; and `decideExisting()`, which reattaches to a
  running sidecar rather than replacing it and defers a major upgrade while
  sessions are live. All of it exists because the box outlives the client and is
  shared between installs. A sandbox we create per agent has one client, one
  bundle, one lifetime, and needs none of it.
- **Model credentials are assumed to be already there.** The remote preflight
  checks `tmux`, `node`, `git`, the Switch credentials and Switch reachability.
  It never checks for a model credential, and the launch spec's `env` is built
  from the provider plugin and Switch Console's own settings — the desktop's
  `ANTHROPIC_API_KEY` is forwarded only to *local* terminal sessions. A remote
  session works because a person logged the CLI in on that host by hand. Nothing
  provisions it and nothing notices it is missing.

That last one is not a rough edge. It is the whole of §6.

### The watcher is on the wrong side

The thing that notices "someone addressed an agent that has no live session" is
`NotificationWatcher`, and it runs inside the sidecar. It opens a stream with
`scope: 'all', filter: 'addressed', spawnCapable: true`, and on an addressed
event it takes a per-room in-flight guard, asks whether a session is already
attending, and spawns one if not — three attempts, two seconds apart, posting a
failure notice into the room if it never comes up.

That is a good design for a machine that is already running. It is circular for
hosting: if the sidecar does not exist yet, nothing is listening.

The server knows this and says so. `connection_model` is one of `always_on`,
`session_addressable`, `session_passive`, `auto_session`, and for an
`auto_session` agent with a watcher connected the server posts *"Starting a
session to handle this — one moment."* on the agent's behalf and waits. With no
watcher connected it posts an offline message whose text tells the room that the
agent "is brought online by Switch Console watching on its owner's machine" and
that "the fix is for the OWNER to open it, and nobody else in the room can act."

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
and archiving, and not one of them touches the conversation. Reading and writing
messages exists only on the agent-facing bridge — `read_context`, `post_message`,
`send_targeted_message`, `send_attachment`. The operator dashboard has no message
list and no composer; a search for a conversation view finds only `err.message`
in error dialogs.

Every human conversation in Switch today therefore goes through a collaboration
bridge, and every bridge is an admin-created row with an operator-pasted
credential. Slack is Socket Mode with a bot token and an app token; Teams is
app-only client credentials. There is no OAuth install flow for any platform and
no callback route to build one on.

So the enrollment path for a stranger dead-ends immediately after "your agent is
running."

### The security posture is a policy plane with no enforcement plane

Covered in §8. In short: nothing in this repository sandboxes, restricts or
limits an agent session today, because the machine belongs to the person running
it and the operating system is the boundary. Hosting removes that boundary and
supplies nothing in its place.

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

An agent is also the unit the product already talks about: it has a name, a
working directory, a provider and a set of rooms.

A *machine*, though, is a shorter-lived thing than an agent. Under the
recommendation below a machine is destroyed when the agent goes idle and started
again when it is next addressed, so the agent's durable state has to outlive its
machine rather than living inside it. That is the thing to get right, and it is
why the persistent-volume question in the cold-start discussion is load-bearing
rather than an optimisation.

### The shape: a microVM, not a container

A sandbox here means a **microVM** — a real virtual machine with its own kernel,
booted by Firecracker — not a container sharing the host kernel. That distinction
is the entire security argument. We are running a stranger's coding agent, which
means a stranger's shell, and a shared kernel is the wrong boundary for that.
State it explicitly wherever this design is summarised, because "sandbox" is used
loosely enough elsewhere to mean a container with a seccomp profile.

### The recommendation: ECS Fargate

Stay on AWS. **AWS Fargate already gives per-task microVM isolation** — in AWS's
own words, each task has its own isolation boundary and does not share the
underlying kernel, CPU, memory or network interface with another task. Tasks run
on Firecracker microVMs, the same primitive the specialist agent-sandbox vendors
sell, each with its own elastic network interface in our VPC and its own IAM task
role.

That combination is what makes it the right answer rather than merely an
acceptable one. We get the isolation boundary without operating a cluster and
without the hardening our existing cluster would need; the network interface
lands in a VPC we already control, so egress policy is a security group rather
than a feature request; the task role is a real credential boundary rather than a
convention; and because it runs in our own account and region, the data-residency
question that would have decided against at least one specialist provider does
not arise.

**ECS Fargate, not EKS Fargate.** EKS on Fargate has neither ARM nor spot
pricing, and it puts back the Kubernetes cluster the whole point was to avoid.

**And not our own existing cluster.** Per-session pods there are the right
long-term shape in the abstract — we already run Kubernetes and it removes a
dependency — but that cluster has no network policy, no resource limits and no
pod isolation; node cloud credentials are reachable; the database holding every
room's messages is one connection away in the same namespace; there are roughly
six spare cores, no autoscaler, and the Kubernetes version is out of standard
support with a forced upgrade ahead. Putting a stranger's shell in that namespace
is not a decision about hosting, it is a decision about the database.

Sources: `docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html`
and `aws.amazon.com/fargate/pricing/`.

### Cold start is the central engineering risk

AWS's own guidance is that a new Fargate task normally takes **thirty to
forty-five seconds or longer** to start, and practitioner reports range much wider
depending on image size. The billing clock starts when the image pull begins, not
when the container is healthy. Both figures come from AWS's task-startup guidance
rather than from our own measurement — which is why phase 0 measures it before
anything is built on top of it.

Set that against the trigger this whole design exists to serve: somebody
addresses an agent in a chat window and waits for it to answer. Forty-five
seconds of nothing is the difference between a product that feels alive and one
that feels broken. This is the central risk of the recommendation and it should
be treated as such, not as a tuning detail discovered in phase 2.

Three mitigations genuinely help, in ascending order of effort:

- **An aggressively small image.** Node, `tmux`, `git`, the sidecar bundle and
  one agent CLI. Every megabyte is pull time on the critical path.
- **Seekable OCI lazy image loading**, which AWS reports as the single
  highest-return optimisation available here, at over fifty per cent. That is
  AWS's number for its own workloads, not ours.
- **A small pre-warmed pool** rather than scaling to zero.

The pool deserves a caveat, because it is easy to over-claim. A warm pool answers
"how long until a container exists". It does not answer "how long until *this
agent's* session is ready" — that needs the agent's working directory, its
credentials and its CLI state, which is a per-agent restore on top. Total wake
latency is pool-assign plus agent-restore, and only the first half is what a pool
buys. Whether a pooled task can mount a per-agent persistent volume fast enough
to make the second half cheap is unverified and is an open question below.

### The honest trade against the specialists

Three vendors were considered and rejected, and the reasoning is worth keeping
because it is the reasoning that would reverse the decision if the risk above
turns out to be fatal.

- **Fly Sprites** — persistent Firecracker VMs with root and a durable root
  filesystem, created in a second or two, with automatic sleep when idle. Three
  billing states of which only *running* is billed. Roughly $0.07 per CPU-hour
  and $0.04375 per GB-hour. Live checkpoint in around 300 ms and restore well
  under a second. Coding agents are the advertised target workload.
- **E2B** — the one most widely used by other agent products. $0.000014 per
  vCPU-second and $0.0000045 per GiB-second. Session length is capped by plan
  tier: one hour on the entry tier, twenty-four hours above it.
- **Northflank** — the only one of the three that runs in our own cloud account,
  which is the answer if a customer says their code may not leave infrastructure
  we control. Fargate answers that too, and more directly.

**What we give up is pause.** The specialists snapshot and restore a paused
machine in well under a second and charge nothing while it sleeps. Fargate has no
pause: an idle session is either destroyed and rebuilt slowly, or kept warm and
paid for. There is no third state. That is the real cost of staying on AWS, and
it is paid in exactly the dimension — wake latency for a mostly-idle agent — that
this product cares most about.

Two things blunt it. Fargate is cheaper per running hour than either specialist,
so keeping something warm is less punitive than it sounds. And **destroying a
session loses the agent CLI's in-memory context regardless of provider** — a
restored microVM gives you back a `tmux` pane with a process in it whose sockets
are dead, which is not the same as a session that can carry on. Session
resumption is a design question in its own right, not something a hosting choice
solves. The specialists' sub-second restore is a real advantage over cold start,
but it is a smaller advantage than it first appears.

There was also a residency problem on at least one of them: Fly's Sprites do not
appear to expose region selection, and their own community forum has a user in
Germany finding their machine in France, apparently routed to a nearby point of
presence rather than a chosen region. For a European company selling to European
customers that is close to disqualifying on its own. Sources: `fly.io/sprites`,
`e2b.dev/pricing`, and the Fly community thread at
`community.fly.io/t/where-do-sprites-dev-sprites-live-as-in-which-fly-io-region-is-it/26775`.

Note that renting from any of them would also make that vendor a **subprocessor
of customer code and prompts**, requiring a contract, a security review and an
entry in a privacy notice. Staying in our own account removes one layer of that
problem — but only one layer. §10 is about the layer that remains.

### Rejected: rootless containers

Podman was raised as a cheaper boundary than a microVM. Rootless containers share
the host kernel, and it is worth being fair about what that means rather than
treating it as an obvious error. It is a perfectly reasonable posture when you
have contractual recourse against whoever is running the code — most CI systems
work exactly this way, and they run arbitrary build scripts all day. The question
is not "is a shared kernel secure", it is "how strong does the boundary need to
be given who is on the other side of it".

For anonymous free-tier users running whatever a model decides to type, a shared
kernel is the wrong boundary. There is no contract, no identity worth the name,
and no recourse.

There is also a practical point that settles it: if the task is already a
microVM, the task *is* the boundary. Podman inside it would be a second boundary
inside the first, adding a layer to reason about for no gain — and Fargate blocks
the privileges nested containers usually want anyway.

### The numbers

Estimates, with the assumptions stated, because every one of them turns on a
ratio we do not have data for.

Fargate is roughly $0.04 per vCPU-hour and $0.0044 per GB-hour in the cheapest
region. European regions run higher; ten to thirty per cent is the working
assumption here rather than a quoted rate, and the real figure should be read off
the pricing page for whichever region is chosen. A 2 vCPU /
4 GB task is therefore about `2 × $0.04 + 4 × $0.0044 = $0.098` per hour before
the regional uplift, so call it **$0.10 to $0.13 an hour in Europe**. ARM is
around twenty per cent cheaper again, and billing granularity is one minute. For
comparison, the same shape is about $0.315 an hour on the Sprites rates and about
$0.17 on the E2B rates — Fargate undercuts both.

Assume an actively working session — the CLI in a turn, reading files and calling
the model — costs roughly $1.50 per hour on a mid-tier model with prompt caching
working properly, and about five times that if caching breaks. So **compute is
under a tenth of the model bill while working**, and under the credential model
in §6 the model bill is not ours to pay at all.

Which means our entire exposure is idle time, and idle time is the number we have
no data for. Two bounds make the shape clear. An agent kept warm around the clock
costs roughly $0.12 × 24 × 30 ≈ **$86 a month**, whether or not anyone speaks to
it. An agent that is destroyed when idle and works one hour a day costs about
**$3.60 a month**, and pays for it in a cold start every time. Nothing sensible
sits at the first number for every agent; the design lives somewhere between,
which is what makes the pooling question in the cold-start section the one that
decides the unit economics.

### What is decided and what is not

Decided: ECS Fargate, in our own account and region, one task per agent, with a
small image and lazy image loading from the start rather than retrofitted.

Not decided: whether a warm pool is needed at launch or can wait for evidence;
whether a pooled task can adopt a specific agent's state quickly enough to be
worth having; and what the acceptable wake latency actually is, which is a
product judgement nobody has made. Those are open questions below, and the first
phase of the plan exists partly to answer them with measurements rather than
argument.

---

## 4. What is reused and what is discarded

| Reused as-is | Discarded |
|---|---|
| The sidecar bundle — stream, watcher, spawner, injector, state store | The SSH transport, and `listSshConfigHosts()` as host identity |
| `AgentLaunchSpec` as the launch contract | The Electron bundle resolver and `extraResources` packaging |
| The `SidecarHost` seam (`exec` + `putFile`) | The interactive setup runner and its refusal to run a whole plan |
| The tmux session model and prompt injection | The deploy lock, bundle-hash dedupe and reattach logic |
| Startup and stall watches that report failures into the room | Log trimming on relaunch |
| The event stream, cursor and `Last-Event-ID` resume | The assumption that a model credential is already on the machine |

The image is the bundle plus Node 20, `tmux`, `git`, and one agent CLI — and
nothing else, because §3 makes image size a latency budget rather than a
housekeeping preference.

Hosting simplifies the delivery seam rather than reimplementing it. `SidecarHost`
is `exec` plus `putFile`; on Fargate the image *is* the file delivery, so
`putFile` mostly disappears and the launch spec arrives as a container override
or from a secret store at task start. What remains of `exec` is served by ECS
Exec. Both paths coexist easily at that size — a self-hosted user keeps SSH, a
hosted one gets the task API — and keeping the interface is what stops the two
diverging the way the two on-demand-start implementations already have.

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

Subscription sign-in is harder and the terms are the reason. *"Developers may not
collect, store, or intermediate Claude.ai credentials or session tokens — sign-in
to a Claude account must complete through Anthropic's own flow."* So we cannot
proxy an OAuth login, which means the end user has to complete it themselves
against a terminal inside their own sandbox — a browser-based terminal, or a
one-time interactive attach. Whether the resulting token sitting on a filesystem
we operate counts as "storing" it is not addressed anywhere on that page, and it
is an open question for a lawyer rather than a judgement call for an engineer.

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
  enforceable and maps exactly onto our cost — Fargate bills at one-minute
  granularity, so the accounting and the limit are the same unit rather than an
  approximation of each other.

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
   the supervisor per task rather than baked into an image, and the task role
   should grant nothing — a session has no legitimate reason to call our cloud
   API at all.
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

Concretely, a hosted session defaults to: a task role that grants nothing; no
credentials in its environment beyond the two it needs; a writable filesystem
limited to its own working directory; default-deny egress; and a compute cap that
stops it. Getting those five right matters more than any amount of tool-level
policy, and none of them requires the agent's cooperation.

One thing to fix regardless of hosting: the generic registration endpoint accepts
a caller-supplied tool list with no validation, so an agent registering outside
the known-agent path declares its own allow list. That is defensible when a
registration token means someone with a machine chose to run something, and
indefensible once registration is a self-serve action.

---

## 9. The free tier: an open model on our own account

§6 closes a door. This section finds the one next to it that is open.

The original proposal was to ship OpenCode rather than Claude Code, pointed at an
internal model proxy with per-key spend limits. It was attractive because OpenCode
is not Anthropic's binary, so the terms quoted in §6 do not bind it; because a
proxy is exactly the mechanism §7 says a hard stop requires; and because it
removes the worst step in the enrollment path — a stranger who has to produce an
API key before they can see anything is a stranger who does not see anything.

The objection to it was that serving external customers through our own model
account raises the same resale question with the inference provider that
Anthropic's terms raise for Claude. That objection turns out not to survive
contact with the terms.

### The door that is open

**AWS's terms for third-party models on Bedrock distinguish our own engineers
from our product's end users, and permit serving end users — including free
ones.** That is the ordinary SaaS-wrapper pattern, and it is allowed. What they
prohibit is handing customers raw API-level access to the model, and training a
competing model on it. Neither describes what we would be doing.

So the resolution to the credential problem the rest of this document sets up is:

> **A free tier on a cheap open model through our own account. The customer
> connects their own Claude or OpenAI credential when they want the good
> models.**

That is a coherent product shape rather than a workaround. The free tier is not a
crippled version of the paid one; it is a different model tier, which is a thing
users already understand from every other tool they use.

It also simplifies §7 considerably. On the free tier we *are* the account holder,
so the first of the four metering options — own the credential and cap it at the
provider — becomes available after all, and it is the strongest of the four. What
owning the account does not give us for free is *per-tenant* attribution, and
whether that comes from provider-side request tagging or from a thin gateway of
our own is an open question rather than a solved one. The global cap is the
safety net; the per-tenant cap is the product.

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

Note that this $3.90 and the $1.50-to-$7.50 range in §3 come from different
assumed call rates and context sizes, so they are not the same calculation
disagreeing with itself. Read them together as one range — somewhere between a
dollar and eight dollars an active hour for a commercial model, depending mostly
on whether caching is working — inside which $3.90 is an unremarkable point. The
comparison that matters is not the absolute figure but the ratio to $0.13.

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

One licence caution that is independent of all of the above: **Meta's open-weight
licence excludes European-domiciled companies from the grant.** That is a legal
question about our own entity, not about which region we deploy in, and it rules
their open weights out for us regardless of how they benchmark.

### The closed flagship, briefly

Meta's new closed flagship was raised as a candidate. It is real, and it is the
wrong tier: priced like a mid-range commercial model rather than a
cheap one, and its cheap variant requires that the vendor be allowed to train on
prompts — which a governance product cannot accept on its customers' behalf and
should not want to. Its open-weight sibling has no agentic benchmarks yet, which
makes it a thing to revisit rather than a candidate to evaluate.

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
round-the-clock expectation. Four environments are deployed by hand today, the
cluster is on an unsupported Kubernetes version, and nobody is on call. Adding
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
| Where sessions run | ECS Fargate, in our own account and region | Specialist sandbox vendors (Fly Sprites, E2B, Northflank) — sub-second restore and free sleep, but a new subprocessor, and at least one cannot answer the residency question. Fargate is also cheaper per running hour. |
| Which Fargate | ECS | EKS on Fargate has neither ARM nor spot pricing and puts back the cluster we are avoiding. |
| Not our existing cluster | Explicitly excluded | No network policy, no limits, no autoscaler, six spare cores, an out-of-support version, and the message database one connection away in the same namespace. |
| Idle handling | Destroy and rebuild, with cold start attacked directly | Modelling a sleep state — Fargate has no pause, and a state the platform cannot provide is a fiction that becomes a support ticket. |
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
| Free-tier model | Qwen's 30B coder on Bedrock on demand, validated against the harness before shipping | Picking from a leaderboard — the surveyed cheap models each have a dated failure mode in this class of harness, and the inference backend alone can move a score by forty points. Meta's open weights are excluded by a licence term about European-domiciled companies. |
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

**Phase 5 — self-serve.** Needs multi-tenancy phases 1 and 2. Signup creates a
tenant, the tenant's first agent is hosted, payment.
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
- **Is a warm pool needed at launch, and can a pooled task adopt a specific
  agent's state?** A pool removes the infrastructure cold start, not the agent
  restore. Whether a task can mount a per-agent persistent volume fast enough for
  the second half to be cheap is unverified.
- **What is the idle-to-active ratio of a real agent?** Every number in §3 turns
  on it and we have no data. It is measurable today from existing sessions and
  should be measured before the pooling decision, not after.
- Staying in our own account and region answers residency for us. It does not
  answer whether any target customer requires more than that — a specific region,
  a specific account, or their own. Northflank was the only rented option that
  could have offered the last of those; Fargate can, at the price of operating a
  second deployment path.
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
