"""The template language, as an agent needs it to write a document.

A condensed ``docs/TEMPLATES.md``, served by the ``get_template_guide``
operation next to the JSON schema of the documents this server accepts. It
covers what the server creates (rooms and groups) and how an agent uses the
agent and team templates the Console creates. Keep it in step with the docs
when the language changes; the schema half follows the code by itself.
"""

TEMPLATE_GUIDE = """\
# Switch templates, for agents

A template is one YAML document. You pass it to create_room_from_yaml, save
it with save_template, or run a saved one with run_template.

## Top-level keys

- version: the format version, 1.
- params: the inputs, each written as {name} anywhere else in the document.
- room: one room to create.
- group + rooms (+ links): a room group, its rooms, and links between them.
- kickoff: a message posted into the room once it exists (single room only;
  in a group, put kickoff inside each room entry).
- agent / agents: agents to create. Only Switch Console creates agents. To
  run such a template yourself, fill every agent it describes with an agent
  that already exists: run_template(agents={slot name: agent name}).

## A room

room:
  name: text
  description: text              # required
  instructions: text             # standing brief for the room's agents
  bridge: messaging app display name, or "{param}"
  channel_type: channel_public | channel_private
  agents: [agent names that exist on the server]
  users: [usernames on the room's messaging app; "{$creator}" is the deployer]
  aliases: {agent name: alias}   # @alias addresses that agent in this room

Without bridge the room goes on the server's default messaging app. users
needs the room to be on a messaging app.

## A group

group: {name: text, description: text}
rooms:
  - {name: ..., description: ..., agents: [...], kickoff: "@agent start"}
links:
  - {from: room name, to: room name, label: text}

## Params

params:
  <name>:
    type: string | number | boolean | enum | agent | bridge | room | user
    description: text
    default: a value, or for agent/bridge/room a list of candidates tried in
             order, where $first means the first one the server has
    required: true | false       # default: true unless there is a default
    enum: [choices]              # enum only
    pattern: regex               # string only, whole value must match
    min: number, max: number     # number only

provider, location and directory params are the Console's; the server
ignores them. Give values in the inputs argument; a required param with no
default and no input is refused with its name.

## Placeholders

{param} is replaced by the param's value; a field that is exactly one
placeholder keeps the value's type. Built in: {$creator} (the deployer, as
the messaging app knows them), {$creator_email}, {$date} (YYYY-MM-DD),
{$timestamp}. A {word} that names nothing is left as written.

## Kickoff

An agent starts working when a message addresses it, so mention each agent
the room needs: kickoff: "@helper start on the brief."
When you create the room, the kickoff speaks for you, not your owner: an
agent that does not accept messages from you makes the request fail before
anything is created. The kickoff also carries the run so far. Asking again
for a room with the same kickoff you already used further up the same path
pauses the run until your owner lets it continue.

## Example

version: 1
params:
  topic: {type: string, description: What the room is about}
room:
  name: "{topic} review"
  description: "Reviewing {topic}"
  agents: [reviewer]
  users: ["{$creator}"]
kickoff: "@reviewer read the brief and list three risks in {topic}."
"""
