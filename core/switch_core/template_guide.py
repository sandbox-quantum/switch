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
  that already exists: run_template(agents={slot name: agent name}). See
  "An agent" below for what each entry must say.

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

## An agent (created by Switch Console)

agent:                           # or agents: [ ...the same block... ]
  instructions: text             # REQUIRED. The agent's brief.
  provider: claude | codex | opencode | "{param}"   # REQUIRED (see below)
  location: local | ssh host | "{param}"            # REQUIRED (see below)
  directory: path | "{param}"                       # REQUIRED (see below)
  name: identifier               # optional; derived from display_name.
                                 # Lowercase letters, digits, . - _
  display_name: text             # optional; how people see it
  description: text              # optional; what it is for
  repo: URL                      # optional; cloned into its directory
  sources: [{label, url} or url] # optional; pages it should read
  addressing: owner | owner-agents | anyone   # optional; default owner
  join: [room name or "{param}"] # optional; rooms it is added to
  allow_existing: true | false   # optional; default false

provider, location and directory: Switch Console fills in nothing the
document does not say, so every agent must say all three. Write each on the
entry, as a literal or "{param}", or declare a param of that type that no
entry's field reads, which then applies to every agent. A param can offer a
choice with a default: provider default [claude, codex, opencode] takes the
first one installed; location default local is the deployer's computer;
directory default "{$agents_dir}/{agent}" gives the agent a folder of its
own. A template missing one is refused by save_template unless you pass
bypass_warnings=true, and the Console will not create the agent from it.

allow_existing: true lets the deployer fill this entry with an agent the
server already has instead of creating one. Leave it out unless the person
asked for that.

In a single agent: document the room refers to the agent as {agent}; in
agents: a room refers to each one by the text written as its name.

Before saving an agent template, settle with the person who asked: which
coding agent runs each agent, on which machine, in which directory (fixed,
or a param with a default they can change), who may talk to it
(addressing), and whether an existing agent may stand in for it.

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
    required: true | false       # default: false with a single default value,
                                 # true with none or with a list of candidates
    enum: [choices]              # enum only
    pattern: regex               # string only, whole value must match
    min: number, max: number     # number only
    label: text                  # the input's name on the form
    input: ask | advanced | fixed  # shown, folded away, or not editable
    multiline: true | false      # string only, a text area

An agent template may also declare params of type provider, location and
directory; see "An agent".

provider, location and directory params are the Console's. run_template
drops them from an agent or team template. In a room or group document with
no agents, leave them out, since the server reads them as text and requires
a value like any other param. Give values in the inputs argument; a required param
with no value is refused with its name.

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
