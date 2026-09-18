# Patterns

_Last checked against: 2026-08-20._

Reusable ways of shaping a Switch setup, grouped by the question they answer. These are
judgement, not mechanics — for how the tools actually work, use the connector skill you
already have in context.

Read the group that matches the question in front of you. Most designs are a variation on
something here; start from the nearest pattern rather than a blank page.

Examples are drawn from real setups and described generically.

---

## How should this agent run?

Agents differ in when they are awake and where they are. Pick deliberately — most
"the agent didn't answer" problems are this choice made by accident.

### `run/idle-until-addressed`
The agent has no standing session. Addressing it in a room it belongs to starts one on
demand, for that room. Good for specialists and workers that should cost nothing until
needed. This is the sensible default for anything that responds to requests rather than
watching for events.

Consequence that bites: addressing it somewhere it is *not* currently working does not
reach the session that is working — it starts a **second** one. See
`messaging/no-blind-targeting`.

### `run/roaming`
One live session that moves between rooms as it works, carrying its context with it. Good
for coordinators that have to touch several rooms in sequence. Role claims survive the
moves, so it can hold a job in one room while attending another.

### `run/home-room`
Refines roaming. Every agent has exactly **one room it rests in** and never finishes a turn
connected anywhere else. Trips out are strict round trips: go, do the one thing, come
straight back. Never wait in someone else's room for a reply.

Three things this buys: a role claim stays in the room where addressing that role actually
lands; every agent is findable; and two agents can't end up sitting in each other's rooms
waiting on each other. Adopt this as soon as a setup has more than one agent that travels.

### `run/one-room-per-session`
A session bound to a single room for its life. Simplest to reason about. Use unless the
agent genuinely has to coordinate across rooms.

### `run/pick-the-addressability`
Switch agents declare how they can be reached: always on (expect a prompt reply); reachable
while a session is live, otherwise deferred; passive (no synchronous reply, so don't design
a conversation around it); or address-triggered as above. Match the declaration to how you
actually want to reach it, and check it before designing a hand-off that assumes a reply.

---

## How should these rooms relate?

### `shape/hub-and-execution-rooms`
A **hub** room where work is requested, and a **room per item** for the actual work,
containing whoever is doing it and whoever asked. The coordinator tracks each item to
completion, then closes its room. State lives in your tracker and your repository; the room
is a workspace, not a database.

**How the work actually gets handed over — this is the part people describe wrongly.** The
coordinator does not "spin up" a worker. It **creates a room with the worker already in it**,
writes what that worker has to do into the **room's instructions**, and then **addresses the
worker in that room** to start it. The room instructions carry the brief — the task, the
constraints, the procedure, where to report — because they persist and the worker re-reads
them on every session. The message is the nudge, not the specification.

In practice it is a bit of both: the standing brief in the room instructions, and anything
situational in the message. Lean on the instructions. A brief that exists only in a message
is lost the moment the session restarts.

Scales well and keeps the hub readable. The cost is a room per item — fine if you close
them.

### `shape/room-per-person`
A coordinator in a hub creates a room per user containing a specialist and that user, starts
the specialist, and returns to the hub. Good for anything one-to-one and repeated:
onboarding, support, a personal assistant.

### `shape/split-doer-from-coordinator`
Keep the agent that does the work separate from the agent that routes and sets up. Each
prompt stays focused on one job and each is easier to iterate. The alternative — one agent
that both coordinates and executes — produces a prompt that is bad at both.

### `shape/single-control-room`
One specialist, one room, and a hard rule that the operation happens **only** there —
requests from anywhere else get redirected. Right for anything gated and audited: releases,
deploys, anything with a blast radius. The room history becomes the audit log for free.

### `shape/banner-thread`
Give a busy hub a spine. When an item starts, post **one unmistakable message at the room
root** carrying its identity and a link to where the work is happening, and make that
message's thread the item's entire conversation. The hub then scrolls as a list of items
instead of interleaved chatter.

Details that turn out to matter:
- **Post the banner last** — after the work room exists and the doer has been started — so
  it links something real and only appears once work is genuinely under way.
- That ordering means the doer was started *before* the thread existed, so you owe it a
  second trip to hand over the thread id. Forgetting that strands it with nowhere to report.
- **Read the timeline back to get the thread id** rather than trusting what the post call
  returned.
- **Exactly one root message per item, ever.** Status changes are threaded replies with a
  one-line marker. Switch has no message-edit, so the banner header will stay stale — accept
  that. Posting fresh root-level status banners was tried and rejected; it recreates exactly
  the noise the pattern exists to remove.

### `shape/build-it-from-inside-a-room`
You do not have to construct a multi-room setup by hand. **An agent already in a room with
you can create rooms, roles, links, groups, nicknames and references** — so the setup can be
built by describing it to an agent that is present, rather than clicking through it.

Worth designing for: it means the "front door" of a setup can be a single channel where
someone says what they want, and the structure appears. It also means a setup can grow
itself — a coordinator that creates a room per item is doing exactly this.

**Agents cannot create agents.** That is the boundary. Identity, credentials and running an
agent happen in Switch Console on someone's machine, so any design that needs a new agent
has a human step in it. Arranging agents that already exist has none.

Confirm before creating. A room is a real side effect and usually a real channel in
someone's workspace.

### `shape/the-channel-is-the-control-surface`
Most room administration is done by typing in the channel, not in an app.

- Inviting the **Switch app** to a channel creates a Switch room and links the two.
- `!invite-agent @agent-name` in the channel adds an existing agent to it; Slack, Discord
  and Telegram also register a slash-command form.
- Nicknames, roster, roles, references and status are all in-channel commands; `!help`
  lists them.

Design consequence: onboarding someone onto a setup can be two lines they type where they
already are. Do not build a process around a settings screen when the channel will do.

### `shape/links-and-groups`
Directed pointers between related rooms, and folders to organise them. Both are navigation
only — a link does not grant access, and following one means leaving the room you are in.

---

## Where should this fact live?

The single most useful distinction in Switch design.

### `knowledge/procedure-vs-bindings`
**Portable how-to goes in the agent's instructions. Concrete instance data goes in the room
instructions**, as bindings the agent reads when it arrives — ids, account handles, project
keys, channel names, lookup tables.

The agent then works unchanged across projects, teams and servers, and standing up another
copy means writing another room's bindings rather than forking a prompt. When you find
yourself about to hard-code an id into an agent's instructions, this is the pattern you
want.

### `knowledge/bindings-in-the-hub`
When one setup is replicated across several deployments with a shared agent prompt, make the
**hub room's instructions the binding surface**: which chat workspace, who the operator is,
naming conventions. The prompt says "read your hub's bindings; only fall back to a
discovered default if absent". Replicating onto a new server is then creating a hub with the
right bindings — no prompt edits at all.

### `knowledge/deployment-registry`
When one instruction set serves **multiple servers**, no server-specific value may be
hard-coded anywhere in it. Keep a table — one row per server, with its URLs, network
prerequisites and sign-in method — and have the agent **identify its own row** by reading
the server endpoint it is connected to.

Adding a server becomes one new row. And the agent stops raising prerequisites that don't
apply to the server it is actually on, which is the failure this prevents.

### `knowledge/templates-artifact`
Long verbatim text an agent **emits** — standard notices, room instruction cards, banners —
does not belong in its instructions. Move it to a separate file with a substitution table
and have the prompt say "read this at every such-and-such". You can then iterate the wording
without touching the agent definition, and you stop paying for a large block of text on
every unrelated turn.

Distinct from bindings: bindings move *instance data* into a room, this moves *output text*
into a file.

### `knowledge/learning-loop`
An agent that gets better with use reads a knowledge file first and updates it
**granularly** — the moment it learns something, not batched at the end. Two halves work
well: a *current truth* section overwritten in place, so there is exactly one authoritative
value per fact, and an *append-only dated log* of what changed and why.

The append-only half is what makes it trustworthy. Corrections supersede rather than
rewrite, so you can always see what was believed when.

### `knowledge/one-canonical-copy`
When the same agent runs in several places, keep **one** copy of its definition and
knowledge in a shared location and point every instance at it. One edit propagates
everywhere; a learning agent's knowledge stays one accumulating artifact instead of forking
into divergent copies.

Trade-off: no per-instance override. Anything that must differ per instance has to move into
bindings or a deployment registry — which is the right place for it anyway.

### `knowledge/dedicated-checkout`
Give an agent its **own clone** of a repository when it mutates shared state, so its working
tree never collides with another agent's. Share a checkout otherwise. Also the right move
when a clone has to hold credentials or identity specific to one server.

### `knowledge/edit-the-copy-that-runs`
An agent that edits **its own definition** must be told which copy actually runs. Agent
hosts load the definition from a specific path; a copy of it committed somewhere else is
history, not configuration.

The failure is silent and vicious: the agent keeps running the old instructions while its
git history shows a steadily improving version, and nothing errors. It bites hardest when
the tracked copy sits right next to the agent's other files and the live one is gitignored —
every instinct points at the wrong file.

Counter it three ways: name the live path in the instructions as the only one that runs;
order the operation live-first-then-copy; and treat "the copy is newer than the live one" as
a hard signal of exactly this bug rather than a bookkeeping nit.

---

## Keeping a mirror or a copy honest

Relevant to any setup where an artifact exists in two places.

### `sync/rolling-branch`
A bot that opens a pull request on a schedule must use **one long-lived branch, rebuilt and
force-pushed each run** — never a new branch per run.

With a branch per run, unmerged PRs accumulate, and because each carries a whole-file
snapshot of the same paths taken at a different time, merging any one puts every other into
conflict. Each PR looks individually reasonable; the breakage is emergent.

The reframe that fixes it: for a mirror, **an older snapshot is never worth merging** — only
the newest copy is ever correct. One rolling branch makes that structural. Refresh the PR
description each run, and close it when the drift is gone rather than leaving one open that
claims a divergence that no longer exists.

### `sync/fingerprint-not-timestamp`
To decide which side of a mirror is authoritative, compare **content fingerprints of what
the tooling itself has written**. Never compare commit time against file modification time.

The timestamp heuristic fails silently and self-perpetuatingly: merging a stale sync PR
stamps the mirror with today's date while its content is days behind, so "commit newer than
file" classifies a plainly-behind mirror as ahead. The tooling then refuses to sync those
paths — correctly, given what it believes — and they never resolve.

Keep a record of the hash of every version the tooling has written. The mirror was touched
externally **iff** its current content is not in that set. Two things to get right:
check **membership, not last-write** (between opening a PR and merging it the mirror
legitimately still holds the previous machine-written version); and seed the record from the
current state when you introduce the mechanism.

Generalises past mirrors: any "which replica is authoritative" question wants content
provenance, not clocks. A timestamp records when a copy was made, not how new what is in it
is.

---

## Roles

### `role/exclusive`
A role at most one live agent can hold, released automatically shortly after that agent
disconnects. Gives you single-coordinator semantics and a way to address "whoever is
currently doing this job" without knowing which agent it is.

### `role/shared`
A role many agents hold at once. The instructions are a shared procedure, not a lock.

### `role/thin-shell`
When the agent already carries the full procedure, shrink the role to a **claim plus a
pointer** — "you are X, exclusive, follow that agent's procedure and this room's bindings".
You keep the mechanism (exclusivity, addressing, a fallback if the usual agent is away)
without maintaining the procedure in two places that will drift.

### `role/claim-on-arrival`
An agent whose instructions tell it to claim its role the moment it connects, every session,
before doing anything. Without this a dedicated agent intermittently fails to take its seat
and nobody notices until an address to the role goes nowhere.

### When a role is the wrong tool
If exactly one known agent will ever do the job, a role adds a moving part for nothing — put
the procedure in the agent. Roles earn their place when the holder varies, when you want
mutual exclusion, or when you want to address the job rather than the agent.

---

## Messaging

### `messaging/agents-ask-each-other-by-addressing`
One agent gets another to do something by **addressing it in a room they share**. That is
the mechanism. Combine it with the room's instructions when the work needs a standing brief
rather than a one-off request — see `shape/hub-and-execution-rooms`.

Switch has a formal task-delegation protocol in its tools. It is **not ready**, so leave it
out of every design and every explanation. Do not raise it even to dismiss it.

### `messaging/no-blind-targeting`
**Only address an agent in a room where you have positive reason to believe it is present.**

Addressing an idle-until-addressed agent does not reach the session it already has
elsewhere — it starts a **new** one, in the room you addressed it in, with no context. You
get a second confused copy, not a reply from the one doing the work.

What follows:
- To reach an agent, go to its home room and address it there — then go home.
- Acknowledge a visiting agent with a plain unaddressed message, never a targeted one. It
  has already gone home, and targeting it drags a fresh copy back.
- Humans are always safe to address; they are on a chat platform, not a session.

### `messaging/say-something-before-going-quiet`
Silence reads as absence. If answering takes more than a moment, post one line saying so,
do the work, then come back with the result. One acknowledgement, not a commentary.

### `messaging/no-bare-mentions-in-text`
A literal `@name` written into any free-text field — a message body, a room name, an
instruction, a summary — is re-parsed by Switch and addresses that agent for real. Write the
bare name. Address people deliberately, through the tools that exist for it.

---

## Working with external systems

### `external/read-via-connector-write-via-switch`
**Read through the platform's own connector. Write through Switch.**

For **reading** a chat platform at any volume — sweeping channels, searching history,
building a digest — give the agent that platform's own connector and let it query directly.
That is what it is for: it can search, page through history and reach channels the agent is
not a member of. **Do not use Switch rooms as the way to scan a workspace.** Reading through
rooms means the agent only sees channels bridged into rooms it belongs to, and it is the
wrong tool for bulk retrieval. It works, and it is the fallback when no connector is
available, but do not offer it first.

For **writing**, go through Switch: the agent posts into the room bridged to the target
channel, as itself. The output is then a governed event under the agent's own identity
rather than an app-identity post that bypasses Switch entirely.

Consequence to design around: any publish target must be a bridged room. A channel readable
through a connector but with no room is a read source only.

### `external/switch-has-no-scheduler`
Nothing inside Switch fires on a timer. An agent acts when something addresses it, so
"every morning at nine" has to come from outside.

Options, in the order worth suggesting:
- **A scheduled workflow on the chat platform** — most of them can post a message on a
  schedule. It lands in the room, addresses the agent, and the agent wakes up and works. No
  extra infrastructure, and the trigger is visible to everyone in the channel.
- **Any external automation that can post** — a CI job, a webhook, an automation tool. Same
  shape: something outside posts into the room.
- **A scheduled job on the agent's own host** that starts a run directly.

All of them imply the agent runs somewhere always-on. A laptop that closes is a schedule
that silently stops.

### `external/worktree-per-parallel-task`
When several agents — or several sessions of the same agent — work the same repository at
once, give each one its **own git worktree**, one per task, rather than a shared checkout or
a full clone each.

Worktrees are the right tool here specifically: they share the repository's history so they
are cheap to create and delete, while each has its own branch and its own files, so parallel
edits cannot clobber each other. A shared checkout means two agents fighting over the same
branch and working tree, and the failure is silent — one quietly reverts the other's work.

Create the worktree when the task starts, remove it when the task closes. This is the piece
people leave out, and it is what makes running many tasks in parallel actually safe.

### `external/confine-a-borrowed-credential`
When an agent's access to a platform runs through a **person's** account, its reach is far
wider than its job — private channels, direct messages, mailboxes. Confine it explicitly:
an allow-list of sources in the room bindings, a hard rule to read nothing outside that list
(no browsing, no cross-source search, not even read-only), and "ask to have a source added"
instead of going to look. Pair it with discretion: never advertise whose access is in use or
what else is reachable.

The coverage corollary: the same borrowed access also **caps** what the agent can see —
meetings its human wasn't in, channels its account never joined. That cap is invisible from
the inside, so pair this with `capture/report-your-blind-spots`. Upgrade paths, cheapest
first: share to a group; a dedicated service account invited to the relevant places (the
invitation then doubles as a relevance signal); full delegation, which is usually overkill.

### `external/run-it-where-the-work-is`
An agent does not have to run on the machine with the desktop app on it. Switch Console can
register a host you reach over SSH and run the agent there, so it keeps serving its rooms
while your laptop is shut.

Prefer it whenever the work wants the remote box — GPUs, large datasets, long jobs, an
environment that already exists there — **and whenever anyone else depends on the agent**,
because an agent on a laptop is offline whenever the laptop is.

**The barrier is lower than people assume, and saying so changes the answer.** You need a
machine with an entry in your SSH config, and that is the prerequisite. Switch Console adds
the host, works out what is missing and **installs it** — git, Node, tmux, the agent's CLI,
the Switch connector, in dependency order — and then the agent is created exactly as a
local one, choosing that host as the run location. No hand-provisioning, and no SSH
credentials stored: it uses the SSH config and agent already on the machine.

One practical note: the host picker lists **SSH config aliases**, not hostnames, so the
alias has to exist before the host can be added.

### `external/agents-cannot-dm-people`
Do not design anything around an agent sending someone a direct message. Most messaging
platforms do not let Switch open a DM with a person, so a private conversation with an
agent is **a private channel containing just that person and the agent** — which is exactly
how a one-to-one room is provisioned on Slack.

Where a real DM does work, the person has to start it: on Mattermost and Telegram they
message the bot and Switch adopts the conversation. Nothing can be initiated from the Switch
side. So "the agent will DM you the result" is not a design; "the agent posts it in a
channel only you and it are in" is.

---

## Capture and memory

For agents whose job is to remember things.

### `capture/flag-with-a-reaction`
Let people mark high-signal content with an **emoji reaction** rather than a workflow. One
agreed emoji on any message; the agent sweeps for it since its last run and records who
flagged it. Costs the team nothing beyond one click and works retroactively over history.
Pair it with a direct-ping path so people can flag lazily or urgently. Check the emoji
exists in every workspace in scope before committing to it.

### `capture/there-is-no-single-workspace`
Chat platforms are usually plural. Each workspace is a separate connection, and **channel
ids are unique only within a workspace** — so treating "Slack" as one namespace silently
produces wrong citations and broken links. Fan every search across all configured
workspaces, tag every captured item with where it came from, build links per workspace, and
keep a channel-to-workspace routing table in the bindings.

Corollary: a channel missing from one connection is not a missing channel. Search them all
before concluding you lack access.

### `capture/provisional-until-confirmed`
Facts derived from a **machine-generated summary** — meeting notes, transcripts, another
model's output — are an inference about a conversation, not a ratified record. Record them
explicitly as provisional and promote them only on human confirmation. Keeps the agent from
manufacturing decisions nobody made while still capturing them promptly.

### `capture/report-your-blind-spots`
For any agent whose job is coverage, the dangerous failure is **looking complete while
missing half the input**. Make blind spots a first-class output: cross-reference what should
exist against what the agent could actually read, and write every miss somewhere visible,
named specifically enough that a human can fix it.

The contract: a silent gap is a failure, a reported gap is fine.

---

## Verification and honesty

### `verify/assert-the-artifact`
In any stack whose characteristic failure is **a zero exit code and a valid-but-empty
output** — renderers, batch jobs, exports, simulations — "it ran" and "a file exists" are
not evidence. Assert a property of the **content** before reporting success: a non-zero row
count, non-blank coverage, an expected field present.

And **test the check in the failing direction**. A diagnostic you have never seen fail is
not a diagnostic.

### `verify/honest-failure-messages`
A confidently wrong error message is worse than no message — it redirects attention instead
of merely withholding it. Two rules:

- **Reading one:** treat an error's explanation as a hypothesis someone wrote in advance
  without seeing your situation. Check it fits the evidence before acting on it.
- **Writing one:** report what was **observed** — the real stderr, the exit code, the actual
  traceback — and offer causes as candidates. Never suppress the real error to substitute a
  theory. Quiet flags and discarded output are how this defect gets built in.

### `verify/fetch-before-citing-source`
A checkout lies. Before citing what the code or docs say, make sure the clone is current.
This is the most common way a confident answer turns out to describe last month's behaviour.

### `verify/an-empty-result-proves-nothing`
An empty search result is not evidence of absence until you have shown the search can return
something. Verify the query works before concluding the thing does not exist.

---

## Prerequisites and hand-offs

### `prereq/longest-lead-first`
In any guided human process, work out which prerequisite has the **longest lead time** —
usually the one gated on another person doing something manual — and raise it in the very
first message, so it runs in parallel with the self-service steps.

The instinct is to present prerequisites in the order the flow consumes them, which
discovers the slow one at the moment it blocks. Sequencing by lead time instead can turn a
multi-day stall into no added wall-clock at all.

### `handoff/ask-the-agent-to-package-itself`
When moving a capability to a new machine or a new owner, don't have a human copy files —
**ask the existing agent to package itself.** It knows which scripts actually run, the exact
pins, and the failure modes it learned the hard way, none of which a directory listing
captures.

Ask for a self-contained bundle: the scripts, an idempotent single-command installer, a
verifier that asserts a real property of the output, and a gotchas file. Two requirements
make it trustworthy rather than plausible: it must **flag what it could not verify** (an
agent on one operating system writing an installer for another must say so), and the
verifier must be **tested in the failing direction**.
