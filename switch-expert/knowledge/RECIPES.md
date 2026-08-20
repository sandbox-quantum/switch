# Recipes

_Last checked against: 2026-08-20._

Seven setups that have actually been built and run, described generically. Find the nearest
one to what someone is asking for and adapt it — that is almost always better than starting
from a blank page.

Each recipe names the patterns it uses; read those in `PATTERNS.md` before proposing it.

---

## 1. An expert on one repository

**Use when** someone wants an agent that knows a codebase, a product or a project that has
a repository behind it. This is the most common request by a distance.

**Shape.** One agent, one room. **Make the repository itself the agent's working
directory** — then there is nothing to clone or copy, it is already sitting in the code.
Its instructions tell it what the project is, who asks about it, and how to answer.

**The one rule that makes it work:** it must **pull before it answers** and read the actual
files, rather than answering from what it absorbed once. A checkout lies, and an expert
that has stopped reading is just a confident memory of last month.

**Where things live.** The brief goes in the agent's instructions. Anything specific to the
team using it — who to escalate to, which branch is the real one, what is out of scope —
goes in the room's instructions, so the same brief works for another team.

**Say what it does not know.** Give it an explicit instruction to say so plainly and offer
to go and look, rather than producing something plausible. Someone asking about a codebase
they do not know cannot tell a good answer from a confident wrong one.

**Variations:**
- **More than one source** — docs in another repository, a wiki, a folder of specs: give it
  a working directory of its own and have it clone or read each source from there.
- **Meant to be handed around** — if people who do not have the repository will run their
  own copy, ship the brief and have it clone. That is how this agent works.
- **Should it be able to write?** Decide deliberately. An agent whose working directory is
  your repository can edit it. If you only want answers, say so in the instructions; if you
  want changes, have it work on a branch and open a pull request rather than committing.

**Patterns:** `knowledge/procedure-vs-bindings` · `verify/fetch-before-citing-source` ·
`verify/an-empty-result-proves-nothing` · `run/idle-until-addressed`

---

## 2. Request hub with a room per piece of work

**Use when** a team has a stream of discrete work items and wants them picked up, tracked
and closed without losing track of what is in flight.

**Shape.** One hub channel where work is requested. For each item, a coordinator creates a
private room containing the agent that will do the work and the person who asked, kicks it
off there, and posts a single banner message in the hub linking to it. That banner's thread
becomes the item's whole conversation. When it is done the work room is closed.

**Agents.** A coordinator that lives in the hub and holds an exclusive role there, and any
number of doers that are idle until addressed. The coordinator travels to a work room to
start or brief someone, then comes straight home.

**Where things live.** The portable procedure is in the coordinator's instructions. Project
keys, board ids, channel names, who to notify — in the hub's room instructions. The long
briefing text the coordinator writes into each new work room lives in a separate template
file it reads each time, not in its prompt.

**You know it works when** the hub scrolls as a clean list of items and you can open any one
of them and read its whole history in the thread.

**It fails like this:** the coordinator posts the banner before starting the doer, and then
forgets the second trip to hand over the thread id — the doer has nowhere to report and goes
quiet. Or someone addresses a doer in the hub instead of its own room, which starts a
second, contextless copy of it.

**Patterns:** `shape/hub-and-execution-rooms` · `shape/banner-thread` · `run/home-room` ·
`run/idle-until-addressed` · `role/exclusive` · `role/thin-shell` ·
`knowledge/procedure-vs-bindings` · `knowledge/templates-artifact` ·
`messaging/no-blind-targeting`

---

## 3. Guided one-to-one help

**Use when** people need walking through something individually and repeatedly — getting
set up, learning a tool, a support queue.

**Shape.** A coordinator watches a shared channel. When someone needs help it creates a
room containing that person and a specialist, starts the specialist, and returns. The
specialist guides one person, one step at a time — give a step, ask what they see, wait,
then the next. Never dump the whole sequence at once.

**Agents.** A coordinator (roaming, home in the hub) and a specialist (idle until
addressed). Splitting them keeps the specialist's instructions about helping rather than
about routing.

**Where things live.** The guiding procedure is in the specialist. Anything that differs per
server — URLs, sign-in method, network prerequisites — goes in a deployment table the
specialist looks its own row up in. Never in the prompt.

**The thing that makes it work:** the specialist maintains a knowledge file and updates it
the moment it hits something unexpected, in two halves — current truth overwritten in place,
and an append-only dated log of what changed. That is what turns a fixed script into
something that gets better every time it runs.

**Raise the slow prerequisite first.** Whatever is gated on another human doing something
manual goes in the welcome message, not at the step that needs it. This is often the
difference between a multi-day stall and no delay at all.

**It fails like this:** the specialist quotes a version or a URL from memory and sends
someone to a page that no longer exists. Look volatile things up at the moment you need
them.

**Patterns:** `shape/room-per-person` · `shape/split-doer-from-coordinator` ·
`knowledge/deployment-registry` · `knowledge/learning-loop` · `prereq/longest-lead-first` ·
`run/idle-until-addressed`

---

## 4. A gated, audited operation in one room

**Use when** something has a blast radius and needs a human to say go: releases, deploys,
production changes.

**Shape.** One control room. One specialist that owns the whole procedure. A hard rule that
the operation happens only in that room — requests anywhere else get redirected there. A
human says what to do; the agent confirms what it is about to do and waits for an explicit
yes before the irreversible step.

**Agents.** A single specialist. No coordinator, no roles — it does the work itself. Give it
its **own checkout** so its working tree never collides with another agent's.

**Where things live.** The procedure is in the agent, sourced from whatever the repository
itself documents. Who to notify, where deploys route — in the room's instructions.

**You know it works when** the room history is a usable audit log of every operation, with
the link to each run.

**It fails like this:** the agent acts on a stale checkout, or tags a version that does not
match the version file. Pull first, verify the preconditions, then act.

**Patterns:** `shape/single-control-room` · `knowledge/dedicated-checkout` ·
`knowledge/procedure-vs-bindings` · `verify/fetch-before-citing-source`

---

## 5. A tracker that accumulates institutional memory

**Use when** a project's decisions and history are scattered across chat and meeting notes
and nobody can reconstruct why something was decided.

**Shape.** One agent sweeps the sources on a schedule and on demand, and writes what it
finds into a small set of ledger files: sources, decisions, a timeline, and — importantly —
a file of known gaps. It answers questions in any room with citations back to the original
message.

**Where things live.** The ledgers are files the agent owns and appends to. The list of
sources it is allowed to read is in the room bindings, not the prompt.

**Two things make it trustworthy.** Facts taken from machine-generated summaries — meeting
transcripts, auto-notes — are recorded as **provisional** until a human confirms them, so it
never manufactures a decision nobody made. And it reports its **blind spots** as a
first-class output: what it expected to be able to read and could not. A silent gap is a
failure; a reported gap is fine.

**If its access runs through a person's account,** confine it explicitly to an allow-list of
sources and forbid browsing outside it. That access is far wider than the job, and it also
silently caps what the agent can see.

**Patterns:** `capture/provisional-until-confirmed` · `capture/report-your-blind-spots` ·
`capture/there-is-no-single-workspace` · `capture/flag-with-a-reaction` ·
`external/confine-a-borrowed-credential`

---

## 6. A recurring digest or newsletter

**Use when** someone hand-writes a regular summary from scattered sources.

**Shape.** One agent, one room. It sweeps the sources for the period, drafts in the room,
takes edits from whoever is reviewing, and publishes when told. It keeps a style file and an
archive of past editions so each one sounds like the last.

**The rule that matters:** it may **read** external platforms through its connectors, but it
**publishes through Switch** — by posting into the room bridged to the target channel, as
itself. The output is then a governed event under the agent's own identity rather than an
app post that bypasses Switch. The consequence to design around is that any publish target
must be a bridged room.

**It gets better because** the style file and the edition archive are artifacts it updates,
so corrections to tone survive into the next edition instead of being re-explained.

**Patterns:** `external/write-through-switch` · `knowledge/learning-loop` ·
`capture/there-is-no-single-workspace`

---

## 7. A heavy job run on a remote machine

**Use when** the work needs a GPU, a large dataset, or an environment that already exists on
some other box.

**Shape.** The agent runs on a host reached over SSH, not on the laptop with the desktop app
on it. It is invitable to any channel; someone asks for a job, it runs it on the remote box
and posts the result back as an attachment.

**Setup notes.** Switch Console registers the host from your SSH config — it lists **config
aliases, not hostnames**, so the alias has to exist first — and installs what it needs
there. Once the host is ready you create the agent as normal and choose it as the run
location. The agent keeps serving its rooms while your laptop is closed.

**The thing that will bite you:** these stacks fail by producing a zero exit code and a
valid-but-empty output. "It ran" and "a file exists" are not evidence. Make the agent assert
a property of the **content** before it reports success — and test that check in the failing
direction, because a diagnostic you have never seen fail is not a diagnostic.

**When you move it to another machine,** ask the agent to package itself rather than copying
files by hand. It knows the pins and the failure modes; a directory listing does not.

**Patterns:** `external/run-it-where-the-work-is` · `verify/assert-the-artifact` ·
`verify/honest-failure-messages` · `handoff/ask-the-agent-to-package-itself`
