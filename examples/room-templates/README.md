# Room templates

A room template is a YAML file that provisions a room the way you want it —
the channel, the agents, the people, the briefing they run under, the jobs
they can pick up, the material they read, and the opening message that sets
them working. One file, one room, as many times as you like.

The files here are examples, meant to be read and then changed. None of them
is a product feature; they are configurations of one, and the interesting part
is the prose inside them — the room instructions and role instructions are
what actually make a room behave a particular way.

## Try one

1. Download a `.template.yaml` from this directory.
2. Switch Console → **Templates** → **Create from Template**, then paste the
   file or pick it from disk.
3. Fill in the form. Params typed `agent`, `bridge`, `room` or `user` get a
   picker over what your server actually has, and are checked before anything
   is created.
4. Create. The room is provisioned, the channel appears in your messaging app,
   and the `kickoff:` message is posted on your behalf — which is what starts
   the agents working.

The API behind it takes the same file, if you'd rather stamp rooms out from a
script (authenticated with your Gateway session cookie). The Gateway's own
paste-YAML form posts the text with no inputs, so it only works for a template
whose params all have defaults — these four do not, and want the Console
wizard or this call:

```bash
curl -X POST "$SWITCH_GATEWAY/rooms/from-yaml" \
  -H 'Content-Type: application/json' \
  -b "switch_auth=$SWITCH_AUTH_COOKIE" \
  -d "$(jq -n --rawfile y incident-bridge.template.yaml \
        '{yaml: $y, inputs: {service: "checkout", severity: "sev2"}}')"
```

## What's here

| Template | What it sets up | What it shows off |
|---|---|---|
| [`red-blue-workroom`](red-blue-workroom.template.yaml) | A coder and a reviewer in a loop, with a human gate on "done" | The baseline: typed params, `{$creator}`, kickoff |
| [`incident-bridge`](incident-bridge.template.yaml) | A private room per incident — a commander who owns the timeline, investigators who bring evidence, an append-only record | Exclusive vs shared **roles**, room **documents**, the `{$date}` builtin |
| [`second-opinion-panel`](second-opinion-panel.template.yaml) | Two agents review the same change independently, then have to account for where they disagree | An inline **reference** to the repository, `enum` and `number` params, two providers in one room |
| [`spec-to-plan-workshop`](spec-to-plan-workshop.template.yaml) | A planner drafts into a document while a red-team agent attacks it, until a human accepts the plan | A **document as the deliverable** rather than chat, a shared role a third agent can join |

## The format, briefly

Four top-level keys: `room:` (required), `params:`, `kickoff:`, `version:`.

```yaml
params:                     # typed inputs, collected by the wizard
  thing:
    type: string            # string | number | boolean | enum
                            # | agent | bridge | room | user
    description: Shown as the field's label text
    multiline: true         # textarea, for pasted long text
    default: ...            # a param with no default is required
room:
  name: "..."               # required
  description: "..."        # required
  instructions: |           # the briefing every agent reads on joining
  bridge: "..."             # messaging app display name; omit for the default
  channel_type: channel_public   # or channel_private
  agents: ["..."]           # by agent name
  users: ["{$creator}"]     # by username on the messaging app
  roles:                    # jobs agents can assume in this room
    - { name: ..., instructions: ..., exclusive: false }
  references:               # { id: ... } or { name: ... } to attach an
    - { type: github, name: ..., description: ..., instructions: ...,
        value: { urls: [...] } }        # existing one, or this to define one
  docs:                     # room-scoped documents, created with the room
    - { name: ..., description: ..., instructions: ..., content: ... }
kickoff: |                  # posted on your behalf once the room is up
```

`{placeholders}` interpolate anywhere in `room:` and `kickoff:`. Besides your
own params the server injects `{$creator}` (your username on the room's
messaging app), `{$creator_email}`, `{$date}` and `{$timestamp}`.

## Writing your own

- **The kickoff is not decoration.** Agents start working when a message
  addresses them, so a template with no `kickoff:` leaves you a furnished
  empty room. Mention every agent that should start.
- **Write instructions to the agent, not about it.** Both the room's
  `instructions:` and each role's are handed to an agent as its briefing.
  "Post status at the top of the channel, four lines" beats "this room is for
  status updates".
- **Say what an agent may not do.** Every one of these templates has a line
  about which decisions belong to a human. That line is doing more work than
  any other line in the file.
- **Exclusive roles for jobs that need one voice**, shared for work that
  parallelises. An exclusive role's lease follows the session and is released
  shortly after it ends, so another agent can take the hat without a handoff.
- **Attach the material, don't paste it.** A reference points at the
  repository or the ticket project and tells the agent when to go read it;
  that stays true as the source changes, and pasted text does not.
- **A document beats a message for anything that outlives the conversation.**
  Give it instructions saying how to maintain it — append-only, keep these
  sections, quote don't paraphrase.
