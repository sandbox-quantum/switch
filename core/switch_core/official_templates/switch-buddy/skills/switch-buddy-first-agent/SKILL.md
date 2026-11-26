---
name: switch-buddy-first-agent
description: Proposing and creating a user's first focused agent, setting up its private room and schedule, introducing it in the room, getting the first real answer, and creating new rooms from templates.
---

# Their first agent & creating rooms

## Their first agent

The goal: one useful agent giving a real answer on their work, in a simple room, before
introducing multi-agent workflows.

1. **Offer one focused agent first.** Unless they already agreed to the single agent you
   named at the interview checkpoint, offer one to three focused single-agent ideas
   tailored to their answers (an agent template from `list_templates` that fits, or one
   you design with a clear name, purpose and instructions) as the options of one question
   form, each option a name and one line on what it does for their actual work. Start with
   one agent in one room, not a multi-agent room template; you can hint at richer
   multi-agent setups once this one is working. Ask once, never the same suggestions as
   prose first. Every list of suggestions, rooms or agents, ends with **Something else**
   and **Skip for now**. In a question form, Something else is the form's own typed
   answer, so the form holds at most three suggestions and Skip for now, always as its
   last option. Something else: ask what they'd like and design it with them. Skip for
   now: the skip line, then stop suggesting; they can ask you any time.
2. **Create what they pick**, after a yes to one proposal message: break the proposal into
   2–3 short blocks separated by blank lines (what the agent does first, then the setup
   details) rather than one dense bullet wall. Name the agent, its focused instructions,
   where it runs (`.switch/skills/switch-buddy-hosting/SKILL.md`), its AI provider
   (default to yours, and if `list_machines` shows other ready providers on that machine,
   name them so they can pick another before creation), defaults for its folder and asking
   before risky actions in plain words ("it'll ask you before anything risky"), never a
   parameter's name or "bypass" / "auto mode", **the private room you'll create for it**
   (name, where it lives, who's in it), and the concrete example question you'll ask it.
   Never bundle multiple setup questions (machine, repo, timezone, folder) into one
   message: ask one question at a time, or propose sensible defaults they can approve in
   one yes. For a recurring job (daily PR check, morning digest, weekly brief), **offer a
   concrete schedule right in the proposal** (e.g. weekdays at 9am, tweakable later;
   confirm their time zone rather than assuming UTC; set it up in step 5 once the room
   exists). Before proposing, check the services its job needs (Jira, GitHub, Google…)
   against `get_my_context`: offer to grant connected ones with `set_agent_service` after
   creation; for a missing one, say so and link where to connect it
   (`.switch/skills/switch-buddy-connectors/SKILL.md`; read it only if you need more). A
   project name alone leaves the agent guessing: if they haven't said what the product or
   project actually is, ask for one line (what it is, who it's for) and put it in the
   agent's instructions and first question (step 5).
   Then `create_agent` (or `run_template` if they explicitly picked an agent or room
   template) — include a line in its instructions to say upfront when a request takes real
   work (e.g. "On it — checking GitHub and Jira now, this might take a few minutes.") —
   grant approved services with `set_agent_service`, and check `list_managed_agents`
   before saying it is ready.
3. **Link the agent only in Switch Console:** in an unbridged Console chat, link
   `switchdash://open/agent/<agent-id>`. On messaging apps, skip it.
4. **Create a simple private room**, unless a room template already made one (then go to
   step 5). Put them, the new agent and you in it (both in `agent_names`):
   - **No messaging app:** a Switch Console group chat: `create_room` with
     `internal_only` and `include_owner` true, `channel_type` "channel_private",
     `read_visibility` and `write_visibility` "private". It is in their chats in Switch
     Console; they @-mention the agent there.
   - **Telegram:** they make a group with the bot, link their account if it isn't linked,
     then send `/invite_agent @<agent-name>` and `/invite_agent @<your-name>`, and talk to
     the agent there by name (in a mention-only group, by replying to the bot's message).
     Read `.switch/skills/switch-buddy-channels/SKILL.md` § "Telegram private channel"
     first.
   - **Teams:** they may send `!invite-agent @<agent-name>` and
     `!invite-agent @<your-name>`. Read `.switch/skills/switch-buddy-channels/SKILL.md`
     § "Teams private channel" first.
   - **Otherwise:** `create_room` with the chat's `bridge_id` (`get_room_detail` of the
     room `list_rooms` marks `connected`), `channel_type` "channel_private",
     `read_visibility` and `write_visibility` "private", their username in `user_names`
     (`.switch/skills/switch-buddy-channels/SKILL.md` § "Adding people to a room").
5. **Join, introduce the room, and get the first real answer.** Stay in the first rooms
   you create so you can help steer them. For a room from `run_template`, its room does
   not include you: right after `run_template`, add yourself with `invite_agent_to_room`
   (your own name, the `room_id` it returned) — even when the template has a `kickoff`. A
   room they made is yours to enter once `list_rooms` shows it; until then wait for them.
   `connect_to_room` the new room and post a short welcome (use `send_targeted_message`
   targeting the owner's username on bridged channels so they get a notification, or
   `post_message` if unbridged): what the room and agent are for, a concrete "try this
   now" prompt wrapped in inline backticks so the real `@` doesn't wake the agent (e.g.
   `` `@<agent-name> what's waiting on me today?` ``), and how to reach you for changes or
   questions (write your actual bare name, e.g. `switch-buddy-…`, never "my name"; if
   teammates are in the room, note you answer the owner by default). If a template's
   `kickoff` already posted above, refer to it cleanly. If they approved a schedule, set
   it up now with `create_room_schedule` (if refused, say so plainly and link the room in
   Switch Console so they can add it there).
   Then, unless a template's `kickoff` already ran with the agent `listening` true, ask
   the agent the first question with `send_targeted_message`: when it has connected tools
   or a local folder, ask on their real data; when it has no data yet, don't ask it to
   list what it needs — have it produce a useful starter artifact from what you know
   (categories, template, or practice run) and end with "paste a few examples and I'll run
   with it." `connect_to_room` this chat again. Keep the reply warm and tight: say the
   room is ready and the first answer will land there (use its reported name; on Slack,
   write `<#<external_channel_id>>` for a clickable `#channel`), note you can add
   teammates, more agents or templates later, put a short return reminder as its own
   paragraph ("Come back to this chat any time to tweak it or ask about Switch."), leave a
   blank line, and end with the room link on its own final line:
   - With `channel_url` (`create_room` / `get_room_detail`):
     `**[Open <room name> →](<channel_url>)**` (opens straight in their app).
   - Unbridged Console chat (or no `channel_url`):
     `**[Open <room name> →](switchdash://open/room/<room-id>)**`.
   Never end the turn on "creating it now": come back with what was made and the link.

## Creating a new room

When they ask for a new room (Switch Console's home chips "Create a new room" and "Create
a room for my team" send just that):

1. Unless this chat already says what they work on, ask the work question first.
2. One form, "Start from a template?": up to three official room templates that fit (see
   "Room templates by work" below), only ones `list_templates` lists, each a name and one
   line, plus "Start from scratch". None listed: leave the form out.
3. A template: `get_template` it, then confirm in one proposal (the room's name, the
   agents it adds, where it lives), asking only for the inputs it requires; `run_template`
   after a yes. Then join and introduce the room (step 5 above). "Start from scratch": ask
   what it's for and which agents should be in it, then create it (`channel_type`
   "channel_private", `read_visibility` and `write_visibility` "private") and introduce it.
4. A refusal: say why, once, in plain words. One ending "or choose a public channel" is
   about their linked account. Offer the two ways out: link it in
   [Messaging apps](switchdash://open/settings?tab=messaging-apps) and try again, or a
   public room from scratch (`create_room` with `channel_type` "channel_public"). A
   template can't be made public: never offer that. Never retry into the same refusal. Any
   other refusal of a template (you can't manage agents, say): go on as for "Start from
   scratch".

Call a room private only if you created it with `channel_type` "channel_private",
`read_visibility` and `write_visibility` "private", or ran an official room template whose
room came back private, and say who can see it: them, its agents, and workspace admins.

If `run_template` gives an agent `listening` false, it may have missed a `kickoff`: once
it is running, ask the first question there yourself.

## Room templates by work

The official room templates to offer for a new room, best first, by id. Offer only those
`list_templates` lists: a workspace admin may have removed some.

| Their answer | Room templates |
|---|---|
| Engineering | official:sprint-room, official:code-review-room, official:incident-war-room |
| Product | official:product-trio-room, official:user-research-lab, official:launch-war-room |
| Design | official:design-review-studio, official:user-research-lab, official:brand-messaging-room |
| Sales | official:deal-room, official:pipeline-review-room, official:sales-enablement-room |
| Marketing | official:campaign-war-room, official:content-pipeline, official:launch-war-room |
| Other, or skipped | official:product-trio-room, official:launch-war-room, official:okr-tracker |
