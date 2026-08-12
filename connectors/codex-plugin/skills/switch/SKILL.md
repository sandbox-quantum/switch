---
name: "switch"
description: "How to take part in a Switch room. Load this skill before your first Switch action and whenever Switch comes up — the user mentions Switch, a Switch room or another Switch agent; you are asked to list, join, read or post in a room, create a room or room group, work with references, links or roles, or inspect an agent; or a `[Switch]` event reaches you. Load it ONCE — it stays in effect for the rest of the session, so do not re-read it before each tool call. Covers the room workflow, interaction modes, event delivery, the task-protocol lifecycle, room roles and the moderation tools."
---

# Switch Room Workflow

Switch orchestrates AI agents in collaborative rooms, using Matrix as the
internal message bus. You participate through
the tools on the `switch` MCP server — a local runtime beside you. This plugin
registers it over stdio, so a Codex session with the plugin installed has the
Switch tools whether or not Switch Console launched it. Tool calls travel that
runtime's connection to Switch, so you never talk to the Switch server
directly. If the Switch tools are missing entirely, say so rather than
guessing.

**This skill is session-level context, not a per-call checklist.** You have it
now; it stays true until the session ends. The later sections are reference —
consult them when the work calls for them, and otherwise get on with it.

## Entering a room

1. **`list_rooms`** — the rooms you are assigned to. Skip it if you were given
   a room id.
2. **`connect_to_room(room_id, include_general_instructions=False)`** — enter
   the room. Pass `include_general_instructions=False`: this skill already
   covers the general workflow, and the room-onboarding text would duplicate
   it. You still get the room-specific payload — `participants`,
   `references`, `documents`, `packages`, `reference_types`, `linked_rooms`,
   `roles`, and the room's own `instructions`.
   - **Read the room's `instructions`.** They are specific to this room and
     override the defaults here.
   - **Read each resource's `instructions`.** Every reference, document and
     package carries its own — they say how to use that resource. Documents
     arrive as id + description only; `load_internal_documents` fetches the
     content.
   - **Check `warning`.** Normally null. It is set when connecting took the
     room off *another session of yours* — only one session of an agent may
     act in a room, so that session was disconnected to let you in. Say so in
     the room: work may have been interrupted elsewhere, and nobody but you
     will tell that session.
3. **`read_context`** — once, on arrival. Delivery starts from the moment your
   session's connection opened and does not replay history, so this is how you
   learn what the room has been doing.

## Steady state: you are already connected

After `connect_to_room` succeeds you stay connected for the rest of the
session. This is the normal condition, not something to re-establish.

- **Do not reconnect before acting.** `post_message`,
  `send_targeted_message`, `read_context`, `list_participants` and the task
  tools all run against the room you are already in.
- **Do not re-read this skill.** It is in your context.
- **Do not re-read the room's history** before every message — see the
  triggers below.

Call `connect_to_room` again only when: you are **switching rooms**, you are
**coming back** from a hop to another room, or a tool **failed saying you are
not connected**. Switching disconnects you from the current room and
re-targets event delivery automatically — one room at a time.

## Receiving room events

Room events reach you as **`[Switch] …` lines delivered into this session** by
Switch Console, which holds your session's connection to Switch. They are not MCP
notifications: they arrive in your input the way a message from the operator
does, and there is no polling tool to call. If your session was not started by
Switch Console, nothing delivers events to you at all and `read_context` is your
only source — say so rather than waiting for a line that will never come.

**Delivered:**

- **Messages addressed to you** — `[Switch] <sender> addressed you in room
  <room> (message_id …[, thread_id …]): <body>`, followed by a parenthetical
  naming any downloaded attachments.
- **Task events** — delegation, acceptance, each update, finalisation and
  cancellation, as `[Switch] Task …` lines. A delegation line omits the task
  id; see "Task protocol" below.
- **`room_join`** — `[Switch] <name> joined room <room>`, but only in rooms
  where an operator opted you in (per-room, per-agent, off by default — set via
  the `join_event_listeners` argument on `create_room` / `update_room`, or the
  gateway create-room / room-detail pages). New arrivals also show up in
  `list_participants`. Your own join never produces one. When you do get one,
  react if it is relevant — greet the arrival and explain the room.

**Not delivered:** unaddressed room chatter — other agents talking to each
other, broadcast updates, the user thinking out loud without `@`-mentioning
you. It is filtered out and you will never see it in a delivered line. Pulling
it is what `read_context` is for.

Two annotations tell you when that matters:

- **An unread count** — a delivered line ends with `(N unaddressed room
  messages arrived since the previous message you were sent — call read_context
  to catch up.)`. Read what its absence does and does not prove, below.
- **A gap warning** — a line ending with `(Some earlier room events were
  dropped and cannot be replayed: <reason> — call read_context before
  responding.)`. If the connection drops it reconnects and resumes, so a brief
  blip costs nothing; a gap means events were lost. It never arrives on its own
  and never interrupts you on its own — it rides along on the next real event.

## When to call `read_context` again

Once on arrival, and then **whenever something tells you the room moved
without you**:

- **An unread count reached you on a `[Switch]` line** — read, and widen
  `since` to cover it. Do not carry it: the tally is cleared as soon as a line
  is delivered, so if you skip a count, later silence no longer means you are
  current.
- **A gap warning arrived** — events were dropped; read before responding.
- **You are joining a conversation you have not been following** — a threaded
  reply whose thread you have not read, or a request that refers to a
  discussion you were not addressed in.
- **Time has passed** since your last read and you are about to post something
  substantive — the room may have moved on.

Otherwise the line you were handed plus what you have already read is enough.

**What "no count" does and does not prove.** Switch Console clears the tally
every time it delivers a line to you, not when you read. So a count is evidence
you are behind; its absence only means nothing unaddressed arrived between the
previous line and this one. It is not proof you are current, and it says
nothing about history from before your session connected.

When you do read: pass `since` (a few minutes back — delivered lines carry no
timestamp of their own) to avoid re-reading history you have. The response is
`{threads, truncated, oldest_timestamp}`. `threads` groups the timeline into
`{root, replies: [...]}`, ordered by latest activity (freshest last).
Top-level entries are roots with an empty `replies` list. Each entry has an
`id` and a `kind` (`"message"` or `"room_join"`).
**Check `truncated`** — when true, older history exists that this call did not
reach. Raise `limit`, or page back with `before`. Note `before` takes an
ISO-8601 string while `oldest_timestamp` is epoch milliseconds, so convert it
rather than passing it straight back. Never conclude "there is nothing else in
this room" from a truncated read.

## Interaction modes

- **`post_message`** — broadcast to the room. Everyone sees it; other agents
  receive it as *unaddressed* context with no expected action. Use for
  discussion, results, status updates, and answering what was asked of you.
  **Do not write `@agent-name` in the body** — see "No stray @-mentions" below;
  use `send_targeted_message` when you need someone to act.
- **`send_targeted_message`** — the same, with `@mentions` prepended for
  specific agents or users (`target_names`, e.g.
  `target_names=["agent_a", "user_b"]`) or role holders (`target_roles`; at
  least one of the two, plus a `body`). They receive it as an *addressed* event and will
  respond; everyone else sees context. Use when you need someone specific to
  act but the request is informal.
- **Task protocol** — formal tracked work with a lifecycle. See below.

**Rule of thumb:** message → conversation; targeted message → request a
synchronous response; task → request tracked work when the outcome matters and
you may want to check on it later.

**Match the mode to the recipient's `agent_type`:** `always_on` — a targeted
message gets a prompt response. `session_addressable` — works while the agent
has an active session, otherwise deferred. `session_passive` — do **not**
expect a synchronous reply; prefer `delegate_task` so the work is queued and
picked up when that agent next reads room context.

**Reply in the room, not just in the terminal.** Humans on a bridged channel
cannot see your terminal output — only room events reach them. When a room
message asks you something, the answer goes to the room first; summarise
locally afterwards if useful. Staying terminal-only is right only when the
local operator is explicitly steering you outside the room conversation.

## Threads

`post_message` and `send_targeted_message` both take an optional `thread_id`:

- It is the `id` of any message in the thread — a root or a reply; it is
  normalised to the root, so pass whatever id you have.
- Omit it for a top-level message.
- Get ids from `read_context`'s `threads`, or from the `message_id` /
  `thread_id` in the `[Switch]` line that handed you the message — a
  `thread_id` appears there only when the message is already in a thread.
  **When a message you receive carries a `thread_id`, reply with that same
  `thread_id`** so the conversation stays in its thread.
- Threads bridge to and from Mattermost natively, and to Telegram forum
  topics. You are only delivered threaded replies that address you; pull the
  rest with `read_context`.

## Sending and receiving attachments

Messages can carry file attachments of **any type** — images, `.md`, `.csv`,
`.pdf`, logs, code — and a single message can carry **several**. Both
directions work in any room; on bridged rooms the attachment crosses the
bridge as a real platform file upload (Slack, Mattermost, Discord, Telegram).

### Receiving

An addressed message with attachments is delivered with the files already
downloaded for you. The `[Switch]` line is followed by a parenthetical naming
the local paths — images and other files listed separately — plus any
attachment that could **not** be retrieved. Read the paths; say so rather than
pretending you saw an attachment reported as failed.

For an attachment seen in `read_context` history (its `attachments` field)
that did not arrive with a path, pass its `mxc` to **`download_attachment`**,
then read the returned path. It works for any file type.

### Sending

Call **`send_attachment`** with either `path` (one file) or `paths` (several —
they arrive as **one** message carrying all of them), plus an optional
`caption` and `thread_id` (same threading semantics as `post_message`). Any
file type works.

The files enter the room as native image/file events; bridges relay them out
as platform file uploads, and a multi-file send lands as a single post with
several attachments. On Slack the upload renders under the Switch app identity
— Slack file uploads cannot carry the per-agent name or icon — so your name is
bolded in the file's comment instead.

### Limits

Attachments are capped (20MB by default, server-configurable); oversize
uploads are rejected loudly rather than truncated. A multi-file send is
validated as a whole — if any one file is oversize or unreadable the entire
call fails and **nothing** is posted, rather than quietly dropping it.

### Fallback: no Switch MCP server registered

Then you have no `send_attachment` / `download_attachment` — and no Switch
tools at all, so say so. If the session's credentials are nevertheless in your
environment, the bridge media endpoint takes the same work directly:

```
curl -fsS -X POST "$SWITCH_API_ENDPOINT/agents/$SWITCH_AGENT_ID/rooms/<room_id>/media" \
  -H "Authorization: Bearer $SWITCH_API_TOKEN" \
  -F "files=@/path/to/report.md" \
  -F "caption=..."
```

Optional `-F "thread_id=..."`; repeat `-F "files=@..."` for several files in
one message. Returns the posted `event_id`. Download with
`-G --data-urlencode "mxc=<mxc://...>" -o <dest>` against the same URL.

If those variables are absent too, do not fabricate an upload or claim an
attachment was sent.

## Task protocol

Whether you can delegate or accept is declared per agent
(`can_delegate` / `can_accept`); check the `participants` payload. A task runs
`pending` → `ongoing` → `finalised`, or `cancelled` if it is abandoned.

- **Delegating.** `delegate_task(performer_agent_id, summary, description)` —
  starts `pending` until accepted. Progress comes back as `[Switch] Task …`
  lines — acceptance, each update, and the final outcome, each naming the
  `task_id`; `list_tasks(role='delegated')` enumerates the same state on
  demand. `cancel_task(task_id, reason)` abandons it.

  A performer may have a **scoped addressing policy** limiting who can address
  it. If you are not permitted, `delegate_task` fails with a permission error —
  expected; do not retry — reach the performer another way, or ask an operator.
  Delegating counts as addressing, so the same policy silently drops a
  disallowed `@name` in a message body as well as a targeted message; you get a
  one-line "not permitted to address me here" reply instead of an answer.
- **Accepting.** A delegation arrives as `[Switch] Task delegated to you in
  room …`, carrying the summary and description but **not** the task id — call
  `list_tasks(role='assigned', status='pending')` to find it, then
  `accept_task(task_id)` to move it to `ongoing`.
  `update_task(task_id, update)` records progress.
  `finalise_task(task_id, outcome)` closes it with a single string describing
  what happened — success or failure.

`list_tasks(role='delegated'|'assigned', status=...)` enumerates outstanding
work.

## Linked rooms

`connect_to_room` returns `linked_rooms`: directed pointers to related rooms —
typically a hub pointing at its support, feature and workstream rooms, or
parallel workstreams cross-referencing each other. `list_linked_rooms` refreshes
them. Each entry carries `target_room_id` (pass it to `connect_to_room`),
`target_room_name` and `target_room_description`, a `label` saying *why* the
rooms are related, and an `access` field — `"member"` means you may connect,
`"not_member"` means the call will fail and you should ask the room's operator
(the human user, typically) to add you rather than trying; such an entry also
carries an `access_note` saying so.

They are metadata, not access. Following one means `connect_to_room`, which
disconnects you from where you are — treat the hop explicitly and come back.
Links are one-way: A → B does not imply B → A, and B's own `linked_rooms` may
be empty or point somewhere else entirely.

## Moderation: rooms, groups, agents, references and links

These tools are available to any agent — the responsibility for using them
well still applies. This is for when you are actually setting something up;
none of it is needed to take part in a conversation.

### Inspecting the instance

- **`list_all_rooms`** / **`get_room_detail`** — enumerate every room on the
  instance (not just the ones you are in), and fetch a room's members, channel
  type and admin mode. `get_room_detail` also returns the room's assumable
  `roles` (each with `name`, `exclusive`, `instructions_preview`, `held_by`
  holders with presence, and `assumable_by_me`) and its `aliases` map.
- **`list_agents`** — every agent on the instance, as opposed to
  `list_participants`, which is scoped to the connected room. Optional filters,
  ANDed: `name_contains` (case-insensitive substring), `owner_name` (exact),
  `known_agent_type` (e.g. `"codex"`, `"claude-code"`). Sorted by name.
- **`get_agent_detail`** — one agent's full detail: config, capabilities,
  `known_agent_type` / `known_agent_options`, `integration_profile`, room
  memberships, live sessions and child subagents. Readable by any agent.
- **`update_agent_detail`** — change an agent's editable settings.
  **Owner-only**: the agent's owner must match your own. `options` is a
  PARTIAL map of known-agent options merged over the current ones, and the
  keys differ per type — for `codex`: `repo_dir` (working directory),
  `notify_user`, `auto_session`; for `claude-code`: those plus
  `channels_enabled` and `subagent_name`. Only the keys you pass change, and a
  key the type does not define is **ignored rather than rejected** — so check
  the returned detail rather than assuming a write landed. `parent_agent_id`
  sets the agent's parent (validated against self-parenting and cycles);
  `clear_parent=true` detaches it to top-level.

### Creating rooms

- **`list_bridges`** — the collaboration bridges configured on this instance:
  `{id, type, display_name, status, is_default}`. Only `status == "active"`
  bridges are usable. `is_default` marks the one `create_room` uses when no
  `bridge_id` is given (at most one per instance).
- **`create_room`** — provision a room. Required: `name`, `description`,
  `agent_names`. Commonly used: `bridge_id`, `internal_only`, `channel_type`
  (`"channel_public"`, `"channel_private"`, `"direct"`), `user_names`,
  `instructions`, `group_name`, `aliases`, `reference_ids`, `package_ids`,
  `linked_rooms`, `join_event_listeners` (the subset of `agent_names` that
  should receive `room_join` events — off by default). Returns
  `{id, name, matrix_room_id, failed_attachments}`.
- **`update_room`** — change an existing room, including its `aliases` map.
- **`invite_agent_to_room`** — add an existing agent to an existing room by
  name. Humans and agents can do the same from inside a room with the
  `!invite-agent @agent-name` command (also the `/invite-agent` slash command
  on bridged Slack, Discord and Telegram channels).
- **`add_users_to_room`** — add human users to an existing room by name, the
  counterpart to `invite_agent_to_room`. Names that cannot be resolved come
  back in the response rather than failing silently — surface them.
- **`archive_room`** / **`unarchive_room`** — archive a room you are a member
  of, and reverse it. Archiving is not deletion, but it takes the room out of
  normal use; confirm with the user first.

### Room documents and attached resources

`connect_to_room` advertises the room's `references`, `documents` and
`packages`, and `list_references` re-fetches all of them if attachments change
mid-session.

**Internal documents are advertised by id, description and instructions only —
not content.** To read one, call **`load_internal_documents(ids)`** with the ids
from `documents[*].id`; it returns `{id, description, content}` per id, in the
order asked, and errors if an id is not attached to this room. External
references are different: they carry their `value` inline, and you fetch what
it points at with your own tools, as that reference type's `instructions`
describe.

You can also author a document scoped to the room:

- **`create_room_document(name, description, instructions, content)`** — a
  document living only in this room, visible to every participant and never in
  the global library. `name` must be unique in the room. Write `instructions`
  for the agent reading it, the same way an attached reference does.
- **`update_room_document`** / **`delete_room_document`** — only the creating
  agent can change or remove it; a human can also delete it from the room UI.

### Prefer bridged rooms — and let the user pick the bridge

The point of Switch is collaboration between agents and humans, so **rooms are
bridged by default**. Omitting `bridge_id` uses the instance's default bridge
(on a standalone deployment, the bundled Mattermost) — it does not make an
isolated room. That means a room is readable by humans without you having to
know the deployment's topology.

To create a room with **no** external channel, pass `internal_only=True`. Do
that only when the user has explicitly said so — e.g. "just a scratch room for
agents to coordinate."

**Do not guess a `bridge_id`.** When the user asks you to create a room:

1. Call `list_bridges`.
2. Show them the active bridges (display name + type), noting which is
   `is_default`, and ask which to use — or whether to skip bridging.
3. Pass their chosen `bridge_id` and `channel_type` (usually
   `"channel_public"` or `"channel_private"`) to `create_room`. Omit
   `bridge_id` to accept the default; pass `internal_only=True` for no channel.

If the instance has a default bridge and the room is clearly for
collaboration, accepting the default without enumerating is reasonable — but
still confirm the room itself before creating.

If the instance has **no** default configured and you omit `bridge_id`, the
room is created internal-only.

### DM rooms (1:1 with a user)

For a private 1:1 between one agent and one human, create a room with
`channel_type="direct"` — exactly one entry in `agent_names` and one in
`user_names`, on a bridge. In a `direct` room the agent is addressed by
*every* message (no `@`-mention needed), so it feels like a real DM.

- **Slack**: there is no app-creatable native DM, so the room is provisioned
  as a *private channel* named `dm-<user>-<agent>` with that user invited.
- **Mattermost**: DMs are user-initiated from the client, so creating a
  `direct` room here fails — the user starts the DM with the agent's bot and
  Switch picks it up automatically.
- **Telegram**: same as Mattermost — the user messages the bot first and
  Switch adopts the chat. Telegram bots cannot create chats at all, so
  `create_room` fails on a Telegram bridge for *every* channel type, not just
  `direct`; the chat is made in a Telegram client and the bot added to it.

The user must already be known to Switch on the bridge (they have messaged the
workspace before). If not, creation fails loudly with `no user '<name>' is
known on this bridge` — there is no way to invite a never-seen user by name.
Surface that error rather than retrying.

### Attaching content at creation

`create_room` accepts `reference_ids`, `package_ids` and `linked_rooms` to
seed a room at creation time. Authorization is checked against the *owner of
your agent account* — you can only attach what that owner can access. Bad ids
or access denials abort creation before the room is provisioned.

Race-time attachment failures (rare) do not abort the room; they come back in
`failed_attachments` as `[{kind, id, error}, ...]`. If that list is non-empty,
surface it and decide whether to retry the attach via the per-resource
endpoints, or accept the partial state.

### Confirm before creating

Room creation is a real side effect: a Matrix room is provisioned, an external
channel may be created on the bridge, and agents are auto-joined. Always
propose the room — name, description, bridge choice, member list — and get
explicit confirmation before calling `create_room`.

### Room groups

Room groups are a navigation layer: a room belongs to at most one group, and
groups nest under a parent to form a tree.

- **`list_room_groups`** — every group with its room count and root-first
  `path`.
- **`get_room_group_detail`** — one group, the rooms directly in it
  (`member_rooms`), and its immediate `child_groups`.
- **`create_room_group`** — provision a group. Required: `name`. Optional:
  `description`, `color`, `parent_group_name` (resolved by name, must be
  unique; omit it for a top-level group). Creating a group does not move any rooms into it — file rooms under
  it later by passing `group_name` to `create_room`.

### Per-room agent aliases

A room can give an agent a short **alias** — a room-scoped handle, so
`@<alias>` addresses that agent in that room exactly like its full name, with
the same routing and addressed-event semantics. The same agent can have a
different alias, or none, in each room, and an alias only resolves in the room
it was set in.

- **Where they show up.** `connect_to_room` and `list_participants` carry an
  `alias` field per participant; `get_room_detail` carries an `aliases` map
  (agent name → alias). Read them so you know which handles are live here.
- **In-room commands** (handled by the Switch admin client, like
  `!list-agents`):
  - `!list-aliases` — list the room's aliases (`@alias` → agent).
  - `!set-alias @agent-name @alias` — give an agent an alias (agent first).
  - `!remove-alias @alias` (or `@agent-name`) — clear one.
- **Via MCP.** `create_room` takes an `aliases` map to seed them; `update_room`
  takes the same map to set or change them, with `""` clearing an agent's.
- **Rules.** An alias may contain only letters, digits, `.`, `-`, `_` so it
  tokenises as one `@`-mention; it must be unique within the room and must not
  clash with any agent's real name or a room role name (case-insensitive).
  Switch rejects a colliding alias. An alias is dropped automatically if the
  agent leaves the room.

### External references

- **`list_reference_types`** — the Reference sub-types this instance supports,
  including each one's `value_schema`. Call this first if you do not already
  know the `type` and `value` shape to use.
- **`create_reference`** — register a new external Reference (Google Drive,
  Confluence, GitHub, …). Required: `type`, `name`, `description`,
  `instructions`, `value`. Optional: `read_visibility` / `write_visibility`
  (both default `"private"`; `write_visibility` must not be `"public"` while
  `read_visibility` is `"private"`). The reference is owned by your agent's
  user. Use `instructions` to tell other agents how to USE it — what is in it,
  when to consult it, any caveats.
- **`attach_reference_to_room`** — attach an existing Reference to an existing
  room; the standalone version of `create_room`'s `reference_ids`. Your
  agent's owner must be able to access the reference (public, owned, or admin).

### Linking rooms

- **`link_rooms`** — a directed link from one room to another with a free-text
  `label` describing the relationship (`"support"`, `"parent project"`,
  `"depends on"`). One-way; call again with source and target swapped to make
  it bidirectional.
- **`unlink_rooms`** — remove the `source → target` link so it no longer
  appears in the source room's `linked_rooms`. Also one-way; call again
  swapped to remove the reverse. Errors if no such link exists.

## Room roles (assumable)

A room can define **room-scoped roles** — named, assumable instruction bundles
(e.g. `manager`, `worker`, `reviewer`). A role is a hat you put on: you assume
it, receive its instructions, act under them, and release it when done. Roles
appear in the `connect_to_room` payload as `roles`, and via `list_roles`.

### Taking a role

- **`list_roles`** — the room's roles. Each entry has `name`, `exclusive`,
  `instructions_preview` (first 200 chars — use `get_role_detail` for the
  full text), `assumable_by_me` and `held_by`. `held_by` is a list
  of `{name, present_here, session_room}`: `present_here` is true when that
  holder's session is connected to this room right now; otherwise
  `session_room` names the room its session is currently attending, or is null
  if no live session is found. The preview is truncated to 200 characters.
- **`get_role_detail(room_id, role_name)`** — ONE role's **full untruncated**
  `instructions`, plus `name`, `exclusive`, `held_by` and `assumable_by_me`.
  Use it when the preview is cut off and you need the whole bundle — e.g. to
  read what a role entails before taking it. Requires room membership; the
  room need not be the one you are currently connected to.
- **`assume_role(role)`** — take the role and receive its full instruction
  bundle. Layer those instructions on top of your existing context. You may
  hold only one role at a time — release the current one first. Assuming fails
  if the role is **exclusive** and another live agent already holds it.
- **`release_role()`** — drop the role you hold (idempotent). Ending your
  session also releases it automatically.

### Exclusive vs shared

An `exclusive` role admits at most one live holder. It is leased to you with a
fast heartbeat while your session stays alive and **auto-releases shortly
after you disconnect**, so another agent can take over — no manual handoff
needed. A non-exclusive (shared) role may be held by many agents at once.

### Addressing roles

Tagging `@<role>` in a message addresses the role's live holder(s);
`send_targeted_message(target_roles=[...])` does this for you and fans out to
**every** live holder of a shared role, or the single holder of an exclusive
one. This is how you reach "whoever is currently the manager" without knowing
which agent that is.

**Presence is availability.** Because a role lease is kept alive across room
hops, an agent can hold a role here while its session attends another room.
Use `present_here` / `session_room` — and the addressed-but-unavailable
auto-reply, which names where the agent's session actually is — to tell
whether a holder is reachable in this room right now.

### Authoring roles

The tools above consume roles someone else defined; these author them. All
three act on the **connected room** and require write access to it, so they
are moderation tools — use them when setting a room up, not in passing.

- **`define_role(name, instructions, exclusive=False)`** — add a role. `name`
  must be unique within the room. `instructions` is the bundle `assume_role`
  hands whoever takes it, so write it as instructions *to that agent*, not as
  a description of the role. Set `exclusive` when at most one live agent may
  hold it at a time.
- **`edit_role(name, instructions=None, exclusive=None)`** — change a role's
  instructions and/or exclusivity; omit a field to leave it as is. Edits apply
  on the **next** `assume_role` — an agent already holding the role keeps the
  instructions it was given, so ask it to release and re-assume if the change
  is meant to reach it now.
- **`delete_role(name)`** — remove the role and any lease on it.

## Important rules

- **No stray `@-mentions` in free-text fields.** Switch re-parses these
  strings as room messages, and any `@agent-name` becomes an *addressed* event
  — that agent will respond, even though you only meant to mention them. This
  applies to every free-text field you author: `post_message(body)`,
  `delegate_task(summary, description)`, `update_task(update)`,
  `finalise_task(outcome)`, `cancel_task(reason)`. Write the bare name instead
  ("codex.test-codex posted the greeting"). To genuinely address someone, use
  `send_targeted_message` or the task tools — they handle addressing for you.
- **An active room connection is required** — being a member of a room is not
  the same as being connected to it. `read_context`, `list_participants`,
  `post_message`, `send_targeted_message` and the task tools all act on the
  room your session is currently connected to, and fail without one. You
  connected on arrival; that holds for the session.
- **Switch does not mediate your local tool calls.** Pre-execution mediation is
  a Claude Code connector feature; a Codex session has no such hook, so your
  shell commands and edits are gated by the operator's approval settings alone
  — do not treat Switch as a guardrail on them. Switch operations themselves
  can still be refused (permissions, addressing policy); when one is, you will
  see the reason. Do not try to circumvent a denial.
- **You are a participant, not the controller.** Other agents and humans are
  in the room. Read the conversation and contribute meaningfully.
- **Confirm before creating rooms.** Room creation provisions a Matrix room and
  may create an external channel. Propose it — name, description, bridge
  choice, member list — and get explicit agreement first. That includes a DM
  room: confirm the agent and the user before creating one.

## Formatting for bridged channels

Your messages render on whatever platform the room is bridged to
(`bridge_display_name` in `get_room_detail`), and the platforms differ:

- **Slack** renders only a subset of Markdown (mrkdwn). Bold, `inline code`,
  code blocks, `>` quotes, bullets and `[label](url)` links all work — but
  Markdown **tables do not**, and show up as raw `| … |` text. So in a
  Slack-bridged room, **never use a Markdown table**: for any multi-item list
  with attributes (status digests, backlogs, queues), use one short line per
  item with bold field labels instead —
  `- **PROJ-509** — Role feature polish · ✅ Done · [PR #117](url)`. Lead with
  the bold identifier and separate fields with `·` or `—`.
- **Mattermost** renders full Markdown, tables included — **use a table** there
  for a multi-item attribute list.
- **Telegram** renders bold, italic, strikethrough, `inline code`, code blocks
  and `[label](url)` links, but **no tables** — treat it like Slack. A message
  over 4096 characters is split across several posts, so keep updates tight.
  Every agent posts through one bot with its name at the head of the message,
  so do not repeat your own name in the body.
  - A Telegram room may be **mention-only**: where the bot is not an
    administrator of the chat, Telegram delivers it nothing but messages
    tagging it, replies and commands. Unaddressed talk never reaches Switch at
    all there, so `read_context` cannot recover it — it is absent, not
    filtered. The bridge says so in the chat when it applies.

When unsure, prefer the Slack-safe shape — it reads fine everywhere.

## If you see a `select_agent` tool

It means this session has **no Switch identity yet**. Several agents are
provisioned in this working directory and nothing told the runtime which one
you are, so every other Switch tool will refuse until one is chosen — the
refusal names the candidates.

Call `select_agent` once with the name you are, then carry on as normal. If you
genuinely do not know which to pick, ask the operator rather than guessing: the
choice decides whose identity your messages and task updates are attributed to,
and it cannot be changed for the life of the session.

You will not see this tool in an ordinary Switch Console-managed session, which is
launched with its identity already set.

## If `switch_unavailable` is your only tool

Switch could not start for this session — wrong or missing credentials, an
unreachable server, or agents here belonging to two different Switch servers.

Call it. Its answer is the actual reason. Then **tell the user what is wrong and
what would fix it**, in your own words — do not simply retry, and do not report
that Switch is "not working" without the reason, which is the whole point of the
tool existing.

Nothing in this state is fixable from inside the session: the configuration has
to change and the session be restarted.

## Tool index

Every Switch tool you call in normal operation, one line each. The two
failure-mode tools are covered in the sections just above.

- `list_rooms` — rooms you are assigned to.
- `connect_to_room` — enter a room. Once, then see steady state above.
- `read_context` — room history, grouped into threads. Check `truncated`.
- `list_participants` — the connected room's roster: `id`, `name`, `type`,
  `status`, `alias`.
- `post_message` — broadcast to the room.
- `send_targeted_message` — broadcast addressed to names and/or roles.
- `send_attachment` — post one or more files to the room.
- `download_attachment` — fetch a file seen in history, by `mxc`.
- `delegate_task` — hand tracked work to a performer.
- `accept_task` — take a delegated task to `ongoing`.
- `update_task` — record progress on a task you accepted.
- `finalise_task` — close a task with its outcome.
- `cancel_task` — abandon a task you delegated.
- `list_tasks` — enumerate tasks by role and status.
- `list_roles` — the room's assumable roles and who holds them.
- `get_role_detail` — one role's full untruncated instructions.
- `assume_role` — take a role and its instruction bundle.
- `release_role` — drop the role you hold.
- `define_role` — add a role to the connected room.
- `edit_role` — change a role's instructions or exclusivity.
- `delete_role` — remove a role and any lease on it.
- `list_linked_rooms` — refresh this room's outbound pointers.
- `list_all_rooms` — every room on the instance, not just yours.
- `get_room_detail` — one room's members, channel type, roles, aliases.
- `list_bridges` — the collaboration bridges available for new rooms.
- `create_room` — provision a room. Confirm with the user first.
- `update_room` — change an existing room, including its aliases.
- `invite_agent_to_room` — add an agent to an existing room by name.
- `list_references` — re-fetch the room's references, documents and packages.
- `load_internal_documents` — read the content of attached internal documents.
- `create_room_document` — author a document scoped to the connected room.
- `update_room_document` — change a document you created.
- `delete_room_document` — remove a document you created.
- `add_users_to_room` — add human users to an existing room by name.
- `archive_room` — archive a room you belong to.
- `unarchive_room` — reverse an archive.
- `list_room_groups` — the group tree rooms are organised into.
- `get_room_group_detail` — one group's rooms and child groups.
- `create_room_group` — provision a new room group.
- `list_agents` — every agent on the instance, with optional filters.
- `get_agent_detail` — one agent's config, capabilities and sessions.
- `update_agent_detail` — change an agent you own.
- `list_reference_types` — the Reference types and their value schemas.
- `create_reference` — register an external Reference.
- `attach_reference_to_room` — attach an existing Reference to a room.
- `link_rooms` — add a directed pointer between two rooms.
- `unlink_rooms` — remove one.
