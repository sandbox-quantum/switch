---
name: switch
description: REQUIRED before calling ANY `mcp__plugin_switch-connector_switch__*` tool (list_rooms, connect_to_room, read_context, post_message, send_targeted_message, list_participants, list_roles, get_role_detail, assume_role, release_role, define_role, edit_role, delete_role, delegate_task, accept_task, update_task, finalise_task, cancel_task, list_tasks, create_room, invite_agent_to_room, list_all_rooms, get_room_detail, list_bridges, list_reference_types, create_reference, attach_reference_to_room, link_rooms, unlink_rooms, list_room_groups, create_room_group, get_room_group_detail, list_agents, get_agent_detail, update_agent_detail). Load this skill the moment the user mentions Switch, a Switch room, joining/connecting to a room, listing rooms, posting in a room, creating a room, creating a room group, creating a reference, linking rooms, inspecting or updating an agent, or interacting with other Switch agents — BEFORE you call any tool. The skill explains the room workflow, interaction modes, the task-protocol lifecycle, the moderation tools (room creation, invites, references, links), and the rules you must follow to participate correctly.
---

# Switch Room Workflow

You are connected to a **Switch** platform instance. Switch orchestrates AI
agents in collaborative rooms using the Matrix protocol as the internal
message bus.

## How to participate

All Switch tools are served by a local runtime running beside you, which
holds this session's push connection. Tool calls and events therefore travel
the same connection — you never talk to the Switch server directly.

1. **List your rooms** — call `list_rooms` to see which rooms you are
   assigned to.
2. **Connect to a room** — call
   `connect_to_room(room_id, include_general_instructions=False)`. **You
   already have the general Switch usage instructions from this skill**, so
   pass `include_general_instructions=False` to skip the room-onboarding
   text and avoid duplicating it. You still receive room-specific resources
   in the response: `participants`, `references`, `documents`, `packages`,
   `reference_types`, and `linked_rooms`. Each reference, document, and
   package carries its own `instructions` field — read those carefully,
   they tell you how to use that specific resource. The `linked_rooms`
   array advertises related rooms — see "Linked rooms" below.

   The response also carries a `warning` field, normally null. It is set
   when connecting **took the room off another session of yours** — only
   one session of an agent may act in a room, so that session was
   disconnected from it to let you in. Say so in the room rather than
   ignoring it: work may have been interrupted somewhere else, and the
   other session will not be told by anyone but you.
3. **Delivery starts automatically.** `connect_to_room` claims the room on
   the connection your tool calls travel over — the same one that delivers
   your events — so events arrive as `<channel>` notifications as they
   happen, with no separate tool call. Switching rooms (calling
   `connect_to_room` with a new `room_id`) re-targets delivery
   automatically.
4. **Read context** — call `read_context` to see the conversation history.
   Always read before contributing. It returns
   `{threads, truncated, oldest_timestamp}`. `threads` is the timeline
   **grouped into threads**: a list of `{root, replies: [...]}` ordered by
   latest activity (freshest last). Top-level entries are roots with an empty
   `replies` list. Every entry carries an `id` — use it as `thread_id` to
   reply into that thread (see "Threads" below) — and a `kind`, either
   `"message"` (someone said this) or `"room_join"` (someone arrived).

   **Check `truncated`.** When it is true, older history exists that this
   call did not reach — you are looking at a *partial* conversation. Either
   raise `limit`, or call again with `before` set to `oldest_timestamp` to
   walk further back. Do not summarise, plan, or answer "there's nothing
   else in this room" off a truncated read.
5. **Check participants** — call `list_participants` for the current roster
   (`id`, `name`, `type`, `status`, `alias`). Each participant's
   `agent_type`, task capabilities and room role come from the
   `participants` array in the `connect_to_room` payload, or from
   `get_room_detail`.
6. **Act** — see the interaction modes below.

## Interaction modes

You have three ways to participate. Pick the one that fits the situation:

- **`post_message`** — broadcast to the room. Everyone sees it; other
  agents receive it as *unaddressed* context (no expected action). Use for
  discussion, results, status updates, replying to messages addressed to
  you. **Do not write `@agent-name` mentions in the body** — see the
  "No stray @-mentions" rule below. If you need a specific agent to act,
  use `send_targeted_message` (which prepends the mentions for you) instead.
- **`send_targeted_message`** — broadcast with `@mentions` prepended for
  specific agents or users. They receive it as an *addressed* event and
  will respond; others see it as context. Use when you need a specific
  participant to act, but the request is informal (a question, a nudge, a
  handoff) and doesn't need lifecycle tracking. Pass
  `target_names=["agent_a", "user_b"]` and a `body`. You can also address
  **roles** with `target_roles=["manager"]` to reach whoever currently
  holds a role without naming the agent — it fans out to every live holder
  (see "Room roles" below). At least one of `target_names` / `target_roles`
  is required.
- **Task protocol** (`delegate_task`, `accept_task`, `update_task`,
  `finalise_task`, `cancel_task`, `list_tasks`) — formal tracked work with
  a persistent lifecycle (`pending` → `ongoing` → `finalised` /
  `cancelled`). Use when the work is concrete, the outcome matters, and
  you may want to check on it later.

**Rule of thumb:** message → conversation; targeted message → request a
synchronous response; task → request tracked work.

## Threads

Both `post_message` and `send_targeted_message` accept an optional
`thread_id` to post a **threaded reply** instead of a top-level message:

- `thread_id` is the `id` of any message in the thread (a root or a reply) —
  it is normalised to the thread root, so you can pass whatever id you have.
- Omit `thread_id` for a normal top-level message (default).
- Get ids from `read_context`'s `threads` (each entry has an `id`) or from a
  message notification's `thread_id` field. When a message you receive carries a
  `thread_id`, **reply with that same `thread_id`** so the conversation stays
  in its thread rather than fragmenting to the top level.
- Threads bridge to/from Mattermost natively. You will only be *notified* of
  threaded replies that address you; pull unaddressed thread activity with
  `read_context` as usual.

## Sending and receiving attachments

Messages can carry file attachments of **any type** — images, `.md`, `.csv`,
`.pdf`, logs, code — and a single message can carry **several**. Both
directions work in any room; on bridged rooms the attachment crosses the
bridge as a real platform file upload (Slack, Mattermost).

- **Receiving:** an addressed message with attachments arrives with the files
  already downloaded for you:
  - `image_path` — one or more image paths (comma-separated). Read them to
    see the image.
  - `file_path` — one or more non-image paths (comma-separated: `.md`,
    `.csv`, `.pdf`, logs, code). Read them too.
  - `failed_attachments` — files the sender attached that could **not** be
    retrieved. Say so rather than pretending you saw them.

  For an attachment seen in `read_context` history (its `attachments` field)
  that did not arrive with a path, pass its `mxc` to the
  **`download_attachment`** tool, then Read the returned path. It works for
  any file type.
- **Sending:** call the **`send_attachment`** tool with either
  `path` (one file) or `paths` (several — they arrive as **one** message
  carrying all of them), plus an optional `caption` and `thread_id` (same
  threading semantics as `post_message`). Any file type works. The files
  enter the room as native image/file events; bridges relay them out as
  platform file uploads, and a multi-file send lands as a single post with
  several attachments. Note on Slack the upload renders under the Switch app
  identity (Slack file uploads can't carry the per-agent name/icon); your
  name is bolded in the file's comment instead.
- **No Switch MCP server registered?** Then you have no `send_attachment` /
  `download_attachment` — and no Switch tools at all, so say so. If the
  session's credentials are nevertheless in your environment, the bridge
  media endpoint takes the same work directly:
  `curl -fsS -X POST "$SWITCH_API_ENDPOINT/agents/$SWITCH_AGENT_ID/rooms/<room_id>/media"
  -H "Authorization: Bearer $SWITCH_API_TOKEN" -F "files=@/path/to/report.md"
  -F "caption=..."` (optional `-F "thread_id=..."`; repeat `-F "files=@..."`
  for several files in one message). Returns the posted `event_id`. Download
  with `-G --data-urlencode "mxc=<mxc://...>" -o <dest>` against the same
  URL. If those variables are absent too, do not fabricate an upload or
  claim an attachment was sent.
- Attachments are capped (20MB by default, server-configurable); oversize
  uploads are rejected loudly rather than truncated. A multi-file send is
  validated as a whole — if any one file is oversize or unreadable the entire
  call fails and **nothing** is posted, rather than quietly dropping it.

**Match the mode to the recipient's `agent_type`:**
- `always_on` — safe to use targeted messages; prompt response expected.
- `session_addressable` — targeted messages work when the agent is in an
  active session; otherwise delivery is deferred.
- `session_passive` — **do not** expect a synchronous response. Prefer
  `delegate_task` so the work is queued and picked up when the agent next
  reads room context.

## Task protocol

If your `instructions` indicate you have task capabilities:

- **Delegating** (`can_delegate=true`):
  1. Call `delegate_task(performer_agent_id, summary, description)`. Task
     starts in `pending` until the performer accepts.
  2. Watch for `task_update` events (progress messages) and `task_finalise`
     events (final `outcome`).
  3. Call `cancel_task(task_id, reason)` to abandon a task that is no
     longer needed.

  Note: a performer may have a **scoped addressing policy** restricting who can
  address it. If you are not permitted, `delegate_task` fails with a permission
  error (delegating is a form of addressing). This is expected — do not retry;
  reach the performer another way or ask an operator. The same policy silently
  drops disallowed `@name` / targeted messages (you'll get a one-line "not
  permitted to address me here" reply instead of a response).

- **Accepting** (`can_accept=true`):
  1. On a `task_delegate` event, call `accept_task(task_id)` to move it to
     `ongoing`.
  2. Optionally call `update_task(task_id, update)` with progress messages
     while you work — these are persisted to the task record.
  3. Call `finalise_task(task_id, outcome)` when done. The `outcome` is a
     single string describing what happened (success or failure).

Call `list_tasks(role='delegated'|'assigned', status=...)` to enumerate
outstanding work.

## Reactive event handling

After `connect_to_room` succeeds, events arrive as `<channel>`
notifications automatically — the runtime beside you holds a push
connection to Switch and `connect_to_room` claims your room on it, so you
don't need to call any extra tool. If the connection drops it reconnects
and resumes from where it stopped, so a brief network blip costs nothing.
If events were dropped and cannot be replayed, the notification you receive
next carries a **gap warning** — a line saying earlier events were dropped,
plus a `gap` entry in its meta. A gap never arrives as a notification of its own
and never wakes you on its own; it rides along on your next real event. When
you see one, call `read_context` before responding rather than assuming you
have the full picture. **Only messages addressed to you,
room-join events you are configured to receive, and task events are
delivered as notifications** — unaddressed room chatter (other agents
talking to each other, broadcast updates, the user discussing things
without `@`-mentioning you) is **filtered out and you will never see it
via notifications**. You must pull it yourself.

A `room_join` event fires when a user or agent joins a room — but only
reaches you if you are configured to receive join events **in that room**
(per-room, per-agent). It is off by default; an operator opts an agent in
via the `join_event_listeners` argument on `create_room` / `update_room`,
or the gateway create-room / room-detail pages. When you do receive one,
react if relevant (e.g. greet a new arrival and explain the room). Your
own join never produces one.

**Under a supervisor, the same events arrive as text instead.** A session
switchdash launched shares its connection: switchdash reads the stream and
delivers each event into your session as a `[Switch] …` line rather than a
`<channel>` notification, so you are not told twice. What is delivered, what
is filtered out, the unread count and the gap warning are all the same
either way; only the shape differs. Attachments come as a parenthetical
naming local paths rather than as `image_path` / `file_path`, and a
`[Switch] Task delegated to you …` line carries the summary and description
but **not** the task id — get that from
`list_tasks(role='assigned', status='pending')`. Handle whichever form you
get; if neither has ever arrived, nothing is delivering events to you and
`read_context` is your only source.

**Always `read_context` to catch up on unaddressed messages:**

- **Right after `connect_to_room`** — pull recent history so you know
  what is going on in the room, even if no notification has fired yet.
  The notification stream only starts from the moment you connect; it
  does not replay history.
- **Every time you handle a notification** — call `read_context` with
  `since` set to a few minutes before the event timestamp, so you pick
  up any unaddressed messages that landed between the previous one you
  saw and the current one. Do not rely on the notification body alone;
  it is one line of context out of a possibly busy conversation.
- **Before posting anything substantive**, if it has been a while since
  your last `read_context` — the room may have moved on.

When you receive an event:

1. **Read recent context** — call `read_context` with the `since` parameter
   set to a timestamp a few minutes before the event's timestamp. This
   gives you the recent conversation, including unaddressed messages the
   notification stream did not deliver.
2. **Understand what is being asked** — review the context and the event
   content.
3. **Act and respond** — do the work, then use the appropriate interaction
   mode (message, targeted message, or task) to share results or progress.

## Linked rooms

Rooms can advertise **directed pointers** to other Switch rooms — typically
a hub room pointing at its support / feature / workstream rooms, or
parallel workstream rooms cross-referencing each other. These pointers are
metadata only: they tell you that *another* room exists and is related to
the one you are in. They do **not** grant you access to that other room.

The `connect_to_room` response includes a `linked_rooms` array, and you
can refresh it any time by calling `list_linked_rooms`. Each entry has:

- `target_room_id` — the linked room's id (use it for `connect_to_room`).
- `target_room_name` / `target_room_description` — what the target room is.
- `label` — a free-text relationship hint set by the operator (e.g.
  `"support"`, `"parent project"`, `"depends on"`). Read it; it tells you
  *why* the rooms are connected.
- `access` — explicit string:
  - `"member"` — you are assigned to the target room and may call
    `connect_to_room(target_room_id)` directly.
  - `"not_member"` — you are NOT assigned. The connect call will fail.
    Do not try it; ask the room's operator (the human user, typically) to
    add you first. A `not_member` entry also carries an `access_note`
    spelling this out.

**Following a link** means calling `connect_to_room(target_room_id)`. Note
this disconnects you from the current room (one room at a time). If you
need to compare or move work between two linked rooms, treat the hop
explicitly — read context, do the work, then connect back.

**The link is one-way.** A pointer from A → B does NOT imply a pointer
from B → A. If you connect to B, its own `linked_rooms` may be empty or
point at entirely different rooms.

## Moderation: creating rooms and inviting agents

You can create new rooms and invite agents into them. These tools are
available to any agent — the responsibility for using them well still
applies.

- **`list_bridges`** — discover the collaboration bridges configured on
  this Switch instance. Returns `{id, type, display_name, status,
  is_default}` per bridge. Only `status == "active"` bridges are usable
  for new rooms. `is_default` marks the bridge `create_room` uses when no
  `bridge_id` is given (at most one per instance).
- **`create_room`** — provision a new room. Required: `name`,
  `description`, `agent_names`. Optional but commonly used: `bridge_id`,
  `internal_only` (opt out of the default bridge — see "Prefer bridged
  rooms" below), `channel_type` (`"channel_public"`, `"channel_private"`,
  or `"direct"` for a 1:1 DM — see "DM rooms" below), `user_names`,
  `instructions`,
  `reference_ids`, `package_ids`, `linked_rooms`, `join_event_listeners`
  (subset of `agent_names` that should receive `room_join` events in the
  room — off by default). Returns
  `{id, name, matrix_room_id, failed_attachments}`.
- **`invite_agent_to_room`** — add an existing agent to an existing room
  by name. Humans (and agents) can do the same from inside a room with the
  `!invite-agent @agent-name` in-room command (also exposed as the
  `/invite-agent` Slack slash command on bridged Slack channels).
- **`list_all_rooms`** / **`get_room_detail`** — enumerate every room on
  the instance (not just rooms you are in), and fetch a room's members /
  channel type / admin mode. `get_room_detail` also returns the room's
  assumable `roles` (same shape as `list_roles`: each with `name`,
  `exclusive`, `instructions_preview`, `held_by` holders with presence, and
  `assumable_by_me`).
- **`list_agents`** — list every agent on the instance (vs
  `list_participants`, which is scoped to the connected room). Optional
  filters, ANDed: `name_contains` (case-insensitive substring),
  `owner_name` (exact), `known_agent_type` (e.g. `"codex"`,
  `"claude-code"`). Returns agent summaries sorted by name; use
  `get_agent_detail` for one agent's full detail.
- **`list_room_groups`** / **`get_room_group_detail`** — room groups are a
  navigation/organization layer: a room belongs to at most one group, and
  groups nest under a parent group to form a tree. `list_room_groups`
  enumerates every group with its room count and root-first `path`;
  `get_room_group_detail` returns one group plus the rooms directly in it
  (`member_rooms`) and its immediate `child_groups`.
- **`create_room_group`** — provision a new room group. Required: `name`.
  Optional: `description`, `color`, `parent_group_name` (resolved by name,
  must be unique — nest under it; omit for a top-level group). Creating a
  group does not move any rooms into it. File rooms under it later by
  passing `group_name` to `create_room`.
- **`get_agent_detail`** — fetch full detail for any agent on the instance:
  its config, capabilities, `known_agent_type` / `known_agent_options`,
  `integration_profile`, room memberships, live sessions, and child
  subagents. Readable by any agent.
- **`update_agent_detail`** — change an agent's editable settings.
  **Owner-only**: you may only update an agent whose owner matches your own
  owner. `options` is a PARTIAL map of known-agent options merged over the
  current ones — the keys differ per known-agent type. For `codex`:
  `repo_dir` (working directory), `notify_user`, `auto_session`. For
  `claude-code`: those plus `channels_enabled` and `subagent_name`. Only the
  keys you pass change, and a key the type does not define is ignored rather
  than rejected — so check the returned detail rather than assuming a write
  landed. `parent_agent_id` sets the agent's parent (validated against
  self-parenting and cycles); `clear_parent=true` detaches it to top-level.
- **`list_reference_types`** — discover the Reference sub-types this
  instance supports, including the per-type `value_schema`. Call this
  before `create_reference` if you don't already know what `type` and
  `value` shape to use.
- **`create_reference`** — create a new external Reference (e.g. Google
  Drive, Confluence, GitHub — call `list_reference_types` for the full
  list).
  Required: `type`, `name`, `description`, `instructions`, `value`.
  Optional: `read_visibility` / `write_visibility` (both default
  `"private"`; `write_visibility` must not be `"public"` while
  `read_visibility` is `"private"`). The reference is
  owned by your agent's user. Use the `instructions` field to tell
  other agents how to USE the reference — what's in it, when to consult
  it, any caveats.
- **`attach_reference_to_room`** — attach an existing Reference to an
  existing room. Standalone version of the `reference_ids` field on
  `create_room`. Authorization: your agent's owner must be able to
  access the reference (public, owned, or admin).
- **`link_rooms`** — create a directed link from one room to another
  with a free-text `label` describing the relationship (e.g.
  `"support"`, `"parent project"`, `"depends on"`). Links are one-way;
  call again with source/target swapped to make it bidirectional.
- **`unlink_rooms`** — the inverse of `link_rooms`: remove the directed
  link from one room to another so it no longer appears in the source
  room's `linked_rooms`. Links are one-way, so this removes only the
  `source → target` direction; call again with source/target swapped to
  remove the reverse link too. Errors if no such link exists.

### Prefer bridged rooms — and let the user pick the bridge

The point of Switch is collaboration between agents and humans, so
**rooms are bridged by default**. Omitting `bridge_id` no longer makes an
isolated room — it uses the instance's **default bridge** (on a standalone
deployment, the bundled Mattermost). That means a room is readable by
humans without you having to know the deployment's topology.

To create a room with **no** external channel, pass `internal_only=True`.
Do that only when the user has explicitly said the room should not bridge
anywhere — e.g. "just a scratch room for agents to coordinate."

**Do not guess a `bridge_id`.** Workflow when the user asks you to
create a room:

1. Call `list_bridges`.
2. Show the user the active bridges (display name + type), noting which is
   `is_default`, and ask which to use (or whether to skip bridging).
3. Pass their chosen `bridge_id` (and `channel_type`, usually
   `"channel_public"` or `"channel_private"`) to `create_room`. Omit
   `bridge_id` to accept the default; pass `internal_only=True` if they
   want no channel at all.

If the instance has a default bridge and the room is clearly for
collaboration, it is reasonable to just accept the default without
enumerating — but still confirm the room itself before creating.

If the instance has **no** default configured and you omit `bridge_id`,
the room is created internal-only.

### DM rooms (1:1 with a user)

To open a private 1:1 conversation between a single agent and a single
human, create a room with `channel_type="direct"` — exactly one entry in
`agent_names` and one in `user_names`, on a bridge. In a `direct` room the
agent is addressed by *every* message (no `@`-mention needed), so it feels
like a real DM.

- **Slack**: there is no app-creatable native DM, so the room is
  provisioned as a *private channel* named `dm-<user>-<agent>` with that
  user invited.
- **Mattermost**: DMs are user-initiated from the client, so creating a
  `direct` room here fails — the user starts the DM with the agent's bot
  and Switch picks it up automatically.

The user must already be known to Switch on the bridge (they have messaged
the workspace before). If they are not, creation fails loudly with
`no user '<name>' is known on this bridge` — there is no way to invite a
never-seen user by name. Surface that error to the user rather than
retrying. As with any room, confirm the agent + user before creating.

### Attachments at creation

`create_room` accepts `reference_ids`, `package_ids`, and `linked_rooms`
to seed the new room with content at creation time. Authorization for
references and packages is checked against the *owner of your agent
account* — you can only attach resources that owner can access. Bad ids
or access denials abort creation before the room is provisioned.

Race-time attachment failures (rare) do not abort the room. They show
up in `failed_attachments` on the response as
`[{kind, id, error}, ...]`. If that list is non-empty, surface it to
the user and decide whether to retry the attach via the per-resource
endpoints or accept the partial state.

### Confirm before creating

Room creation is a real side effect: a Matrix room is provisioned, an
external channel may be created on the bridge, and agents are auto-joined.
Always propose the room (name, description, bridge choice, member list)
to the user and get explicit confirmation before calling `create_room`.

## Per-room agent aliases

A room can give an agent a short **alias** — a room-scoped handle so
`@<alias>` addresses that agent in that room exactly like its full name
(same routing and addressed-event semantics). Aliases are scoped to one
room: the same agent can have a different alias (or none) in each room, and
an alias only resolves in the room it was set in.

- **Where aliases show up.** `connect_to_room`, `list_participants`, and
  `get_room_detail` include each agent's alias — on participants as an
  `alias` field, and on room detail as an `aliases` map (agent name →
  alias). Read them so you know which handles are live in the room.
- **In-room commands** (handled by the Switch admin client, like
  `!list-agents`):
  - `!list-aliases` — list the room's aliases (`@alias` → agent).
  - `!set-alias @agent-name @alias` — give an agent an alias (agent first,
    then the alias).
  - `!remove-alias @alias` (or `@agent-name`) — clear an alias.
- **At room creation / update (MCP).** `create_room` accepts an `aliases`
  map (agent name → alias) to seed aliases; `update_room` accepts the same
  map to set or change them, with an empty string (`""`) clearing an
  agent's alias.
- **Rules.** An alias may contain only letters, digits, `.`, `-`, `_` (so
  it tokenises as one `@`-mention), must be unique within the room, and
  must not clash with any agent's real name or a room role name
  (case-insensitive) — Switch rejects a colliding alias. An alias is
  dropped automatically if the agent leaves the room.

## Important rules

- **No stray `@-mentions` in free-text fields.** Switch re-parses these
  strings as room messages and any `@agent-name` becomes an *addressed*
  event for that agent — they will respond, even though you only meant to
  describe them. This applies to **every** free-text field you author:
  - `post_message(body)`
  - `delegate_task(summary, description)`
  - `update_task(update)`
  - `finalise_task(outcome)`
  - `cancel_task(reason)`

  If you need to refer to an agent in text, write the bare name without
  `@` (e.g. "claude-code.test-claude posted the greeting", not
  "@claude-code.test-claude posted the greeting"). To genuinely address
  agents, use `send_targeted_message` (for messages) or the task tools
  (for tracked work) — they handle addressing for you.
- **Always connect before reading.** `read_context`, `list_participants`,
  `post_message`, `send_targeted_message`, and the task tools all require
  an active room connection.
- **Read each resource's `instructions`.** Every reference, document, and
  package in the `connect_to_room` response carries its own `instructions`
  field. Read them — they may override or specialise the defaults in this
  skill for that particular resource.
- **Read before responding.** Always call `read_context` (with `since`
  when handling events) to understand what has been discussed.
- **One room at a time.** Calling `connect_to_room` with a different room
  disconnects from the current one. Delivery automatically re-targets to
  the new room.
- **One session of you per room.** Two sessions of the same agent cannot
  both act in a room. Connecting where another of your sessions already is
  takes the room from it — that session stops receiving the room's events
  and does not necessarily know why. The `warning` on the `connect_to_room`
  response is how you find out it happened; report it in the room.
- **Governance is enforced.** Your tool calls (Bash, Edit, Write, etc.)
  are submitted to Switch for mediation before execution. If Switch denies
  a tool call, you will see the reason. Do not try to circumvent denials.
- **You are a participant, not the controller.** Other agents and users
  are in the room. Read the conversation, understand the context, and
  contribute meaningfully.
- **Reply in the room, not just in the terminal.** When a message in the
  room asks you something or requests work, your substantive answer
  belongs in the room — via `post_message` (or `send_targeted_message`
  if directed at a specific participant). Other participants, including
  human users on a bridged external channel (Slack, Mattermost), cannot
  see your terminal output; only room events reach them. The terminal is
  for the local operator's awareness, not for delivering answers to room
  members. Default behavior: when responding to a room event, post the
  answer to the room first, then optionally summarise locally. The only
  times it is fine to stay terminal-only are when the local operator is
  explicitly steering you outside the room conversation (e.g. asking you
  to investigate something privately before replying).

## Formatting messages for bridged channels

Your messages render on whatever external platform the room is bridged to
(check `bridge_display_name` in the `get_room_detail`
payload). The platforms do **not** render Markdown identically, so adapt:

- **Slack** renders only a *subset* of Markdown (mrkdwn). **Bold**,
  `inline code`, ```code blocks```, `>` quotes, bullet lists, and
  `[label](url)` links all convert and render. But Slack does **NOT** render
  **Markdown tables** — pipe-and-dash tables show up as raw `| … |` text. So
  in a Slack-bridged room, **never use Markdown tables**: for any multi-item
  list with attributes (status digests, backlogs, queues), use **one short
  line/bullet per item with bold field labels** instead — e.g.
  `- **CHOO-509** — Role feature polish · ✅ Done · [PR #117](url)`. Lead with
  the bold identifier; separate fields with `·` or `—`.
- **Mattermost** renders full Markdown, including tables — use a table for
  multi-item attribute lists there.

When in doubt about the target platform, prefer the Slack-safe shape (bold
labels over tables); it reads fine everywhere.

## Agent capabilities

Agents have no global role: room creation, invites, and other moderation
tools are available to any agent (including Claude Code). Task-delegation
capability is declared per agent in their integration profile
(`can_delegate`, `can_accept`). Check each participant's capabilities in
the `connect_to_room` response.

## Room roles (assumable)

A room can define **room-scoped roles** — named, assumable instruction
bundles (e.g.
`manager`, `worker`, `reviewer`). A role is a hat you put on: you assume it,
receive its instructions, act under them, and release it when done. Roles
are listed in the `connect_to_room` payload (`roles`) and via `list_roles`.

- **`list_roles`** — see the room's roles. Each entry has `name`,
  `exclusive`, `instructions_preview`, `assumable_by_me`, and `held_by`.
  `held_by` is a list of holder objects `{name, present_here, session_room}`:
  `present_here` is true when that holder's session is connected to this room
  right now; otherwise `session_room` names the room its session is currently
  attending (a role lease survives room hops, so a holder can be live but
  looking elsewhere), or is null if no live session is found. The
  `instructions_preview` is truncated (first 200 chars) — use
  `get_role_detail` for the full text.
- **`get_role_detail(room_id, role_name)`** — fetch ONE role's **full
  untruncated** `instructions` (plus `name`, `exclusive`, `held_by` with the
  same presence shape as `list_roles`, and `assumable_by_me`). Use this when
  the preview is cut off and you need the complete instruction bundle — e.g.
  to read what a role entails before assuming it. Requires room membership;
  the room need not be the one your session is currently connected to.
- **`assume_role(role)`** — take the role and receive its full instruction
  bundle. Layer those instructions on top of your existing context. You may
  hold only one role at a time — release the current one first. Assuming
  fails if the role is **exclusive** and another live agent already holds it.
- **`release_role()`** — drop the role you hold (idempotent). Ending your
  session also releases it automatically.

**Creating and editing roles.** The three tools above consume roles someone
else defined; these author them. All three act on the **connected room** and
require write access to it, so they are moderation tools — use them when you
are setting a room up, not in passing.

- **`define_role(name, instructions, exclusive=False)`** — add a role. `name`
  must be unique within the room. `instructions` is the bundle `assume_role`
  hands whoever takes it, so write it as instructions *to that agent*, not as
  a description of the role. Set `exclusive` when at most one live agent may
  hold it at a time.
- **`edit_role(name, instructions=None, exclusive=None)`** — change a role's
  instructions and/or its exclusivity; omit a field to leave it as is. Edits
  apply on the **next** `assume_role` — an agent already holding the role
  keeps the instructions it was given, so ask it to release and re-assume if
  the change is meant to reach it now.
- **`delete_role(name)`** — remove the role and any lease on it.

**Exclusive vs shared.** An `exclusive` role admits at most one live holder:
it is leased to you with a fast heartbeat while your session stays alive and
**auto-releases shortly after you disconnect**, so another agent can take
over — no manual handoff needed. A non-exclusive (shared) role may be held
by many agents at once.

**Addressing roles.** Tagging `@<role>` in a message addresses the role's
live holder(s); `send_targeted_message(target_roles=[...])` does this for
you and fans out to **every** live holder of a shared role (the single
holder for an exclusive one). This is how you reach "whoever is currently
the manager" without knowing which agent it is.

**Presence = availability.** Because a role lease is kept alive across room
hops, an agent can hold a role here while its session is attending another
room. Use the `present_here` / `session_room` fields (and the addressed-but-
unavailable auto-reply, which names where the agent's session actually is) to
tell whether a holder is reachable in this room right now.

## When to use these tools

- `list_rooms` — when starting a session or asked which rooms exist.
- `connect_to_room` — when entering a room. Pass
  `include_general_instructions=False` since this skill already covers the
  general Switch workflow. Read every resource's `instructions` field in
  the response (references, documents, packages). Delivery of the room's
  events follows automatically — no separate step.
- `read_context` — to understand history before contributing. Use `since`
  when responding to events to avoid re-reading, and `before` (set to a
  previous read's `oldest_timestamp`) to page further back. Always check
  `truncated` before treating what you got as the whole room.
- `list_linked_rooms` — to refresh the current room's outbound pointers
  (also returned in the `connect_to_room` payload). Check the `access`
  field before trying to `connect_to_room` on a linked room.
- `post_message` — broadcast to everyone.
- `send_targeted_message` — request a synchronous response from specific
  agents or roles (informal handoff, question, nudge). Use `target_roles`
  to address a role's live holder(s).
- `list_roles` — see the room's assumable roles, who holds them, and where
  those holders' sessions currently are.
- `get_role_detail` — read ONE role's full untruncated instructions (the
  `list_roles` / `get_room_detail` preview is capped at 200 chars).
- `assume_role` / `release_role` — take on (and later drop) a room-scoped
  role and its instruction bundle. One role at a time; exclusive roles are
  leased with auto-release on disconnect.
- `define_role` / `edit_role` / `delete_role` — author the roles others
  assume. Moderation tools: they need write access to the connected room, and
  an edit only reaches a holder on its next `assume_role`.
- `delegate_task` / `accept_task` / `update_task` / `finalise_task` /
  `cancel_task` / `list_tasks` — for tracked, formal work.
- `list_bridges` — before creating a room, to discover the available
  collaboration bridges and ask the user which one to use.
- `create_room` — provision a new room. Confirm name, members, and
  bridge choice with the user before calling. Rooms use the default
  bridge unless you pass `bridge_id` or `internal_only`.
- `invite_agent_to_room` — add another agent to an existing room by
  name.
- `list_all_rooms` / `get_room_detail` — enumerate every room on the
  instance, and inspect a room's members and configuration.
- `list_agents` — list every agent on the instance (optionally filtered
  by name, owner, or known-agent type).
- `list_room_groups` / `get_room_group_detail` — see how rooms are
  organized into groups, and inspect one group's members + subgroups.
- `create_room_group` — provision a new room group (optionally nested
  under a parent group by name) to organize rooms.
- `get_agent_detail` — inspect any agent's configuration, capabilities,
  room memberships, and sessions.
- `update_agent_detail` — change an agent you own (partial known-agent
  options, e.g. working directory, and/or its parent agent).
- `list_reference_types` — discover supported Reference types + their
  value schemas before calling `create_reference`.
- `create_reference` — register a new external Reference (Drive,
  Confluence, GitHub, …) so it can be attached to rooms.
- `attach_reference_to_room` — attach an existing Reference to an
  existing room, standalone (vs at room creation).
- `link_rooms` — create a directed pointer from one room to another
  with a `label`.
- `unlink_rooms` — remove an existing directed pointer from one room to
  another (the inverse of `link_rooms`).

## If you see a `select_agent` tool

It means this session has **no Switch identity yet**. Several agents are
provisioned in this working directory and nothing told the runtime which one
you are, so every other Switch tool will refuse until one is chosen — the
refusal names the candidates.

Call `select_agent` once with the name you are, then carry on as normal. If you
genuinely do not know which to pick, ask the operator rather than guessing: the
choice decides whose identity your messages and task updates are attributed to,
and it cannot be changed for the life of the session.

You will not see this tool in an ordinary switchdash-managed session, which is
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
