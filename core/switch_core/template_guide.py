"""The template language, as an agent needs it to write a document.

A condensed ``docs/TEMPLATES.md``, served by the ``get_template_guide``
operation next to the JSON schema of the room documents this server accepts.
It teaches version 2 (resources with a key and a type), which is what an
agent should write, and what it needs to read a version 1 document it finds.
Keep it in step with the docs when the language changes.
"""

TEMPLATE_GUIDE = """\
# Switch templates, for agents

A template is one YAML document that says what to create: agents, rooms, a
group of rooms. You run one you write with create_room_from_yaml, save it
with save_template, or run a saved one with run_template. Write new
templates in version 2, described here; "Version 1" at the end is for
reading older ones.

## The shape

version: 2
params:      # the inputs, each written as {name} anywhere below
  <name>: {type: ..., default: ..., ...}
resources:   # what the template creates, each under a key with a type
  <key>:     # letters, digits and _
    type: agent | room | group
    if: "{param}" | "{param} == value" | "{param} != value"   # optional
    ...the fields of that type
form:        # optional: how the form folds things away
  advanced: {label: Advanced, open: false}

Resources refer to each other by key: a room's agents: [lead] lists the
agent whose key is lead, and {lead.name} anywhere is the name that resource
is created under (an agent's name, or the identifier its display_name
gives). A reference to a resource whose if: does not hold is refused.

## if:, the one conditional

- On a resource: it is created only while the condition holds.
- On a param: it is asked only while the condition holds. A param that is
  not asked reads as empty, and drops out of the lists it was written in.
- In a field's value, as a list: the first entry whose if holds is taken,
  and an entry with no if always holds:
    addressing:
      - {if: "{start_in} == new_room", value: {anyone_in: [lead_room]}}
      - {value: anyone}

A condition reads one param: "{param}" (true when it has a value) or
"{param} == value" / "{param} != value".

## An agent (type: agent)

  instructions: text             # REQUIRED. The agent's brief.
  provider: claude | codex | opencode | antigravity | cursor | "{param}"   # REQUIRED
  machine: machine name or id | "{param}"           # REQUIRED: where it runs
  directory: path | "{param}"                       # REQUIRED
  name: identifier               # optional; else derived from display_name.
                                 # Lowercase letters, digits, . - _
  display_name: text             # optional; how people see it
  icon_url: https URL            # optional; its picture, else one drawn from its name
  description: text              # optional; what it is for
  model: text | "{param}"        # optional; the provider's default if absent
  advanced_config: {key: value}  # optional; see get_advanced_config(provider)
  isolation: shared | isolated   # optional; default shared
  auto_mode: true | false        # optional; default true. The provider's own
                                 # review: safe actions run, risky ones ask
  auto_approve: true | false     # optional; default false. Bypass: no
                                 # permission checks at all; overrides auto_mode
  can_manage_agents: true | false  # optional; default false. It may create
                                 # agents on the deployer's machines
  addressing: owner | owner-agents | anyone | {anyone_in: [room keys]}
                                 # optional; default owner-agents (the deployer
                                 # and the deployer's agents)
  connections:                   # optional; the deployer's connections it gets
    - {service: github, access: read | write, repos: [owner/name]}
    - atlassian                  #   or just the service's name
  repo: URL                      # optional; it clones it into its directory
                                 # (a private one needs a github connection)
  join: [existing room name or "{param}"]   # optional; rooms it is added to
  sources: [{label, url} or url] # optional; pages it should read
  allow_existing: true | false   # optional; an existing agent may stand in

Each agent is created as a managed agent of the deployer (your owner, when
you run it) on the machine it names, before the rooms. That needs agent
management on the server and, for you, the "can manage agents" capability;
the machine must be online with the provider installed and signed in. The
whole run is checked before anything is created; every problem comes back
with its reason code, and agents made before a later failure are deleted.

provider, machine and directory are never filled in for you: say each on the
agent, as a value or "{param}". A param offers a choice with a default:
machine default [$first] is the first online machine that can run the agents'
providers; provider default [claude, codex] the first ready on its machine;
directory "{$agents_dir}/{lead.name}" the agent's own folder on its machine.

connections are the deployer's own, granted to the new agent: they must have
connected each, with write access to grant write. anyone_in admits anyone in
those rooms of the run as well as the deployer. join adds the agent to rooms
that already exist; each must be one the deployer may add agents to.
allow_existing: true lets run_template(agents={key: existing agent name}) put
an agent that exists in the slot instead; leave it out unless asked.

Before saving an agent template, settle with the person who asked: which
coding agent runs each agent, on which machine, in which directory, what it
may reach (connections), who may talk to it (addressing), and whether an
existing agent may stand in for it.

## A room (type: room)

  name: text                     # REQUIRED
  description: text              # REQUIRED
  instructions: text             # standing brief for the room's agents
  bridge: messaging app display name, or "{param}"
  channel_type: channel_public | channel_private
  agents: [agent keys, or names of agents that exist]
  users: [usernames on its messaging app; "{$creator}" is the deployer]
  aliases: {agent key or name: alias}   # @alias addresses it in this room
  sessions: {agent key or name: home | shared | isolated}
                                 # home: the agent's shared session is based
                                 # here; shared: this room answers from it;
                                 # isolated: this room gets its own session
  kickoff: text                  # posted once the room exists
  group: <group key>             # when the template has a group

Without bridge the room goes on the server's default messaging app; users
needs one (make them depend on it: [{if: "{bridge}", value: [...]},
{value: []}]). Several rooms go in one group.

## A group (type: group)

  name: text
  description: text
  links: [{from: room key, to: room key, label: text}]

## Params

  <name>:
    type: string | number | boolean | enum | agent | bridge | room | user
          | provider | machine | directory
    description: text
    label: text                  # the input's name on the form
    default: a value, or for agent/bridge/room/provider/machine a list of
             candidates tried in order, $first meaning the first that works
    required: true | false       # default: false with a single default value,
                                 # true with none or with a list of candidates
    input: ask | advanced | fixed  # shown, folded away, or not editable
    enum: [choices]              # enum only
    pattern: regex               # string only, whole value must match
    min: number, max: number     # number only
    multiline: true | false      # string only, a text area
    if: condition                # asked only while it holds

Give values in run_template's inputs argument; a required param with no value
is refused with its name.

## Placeholders

{param} is replaced by the param's value; a field that is exactly one
placeholder keeps the value's type. {key.name} is a resource's name. Built
in: {$creator} (the deployer, as the messaging app knows them),
{$creator_email}, {$date} (YYYY-MM-DD), {$timestamp}, and {$agents_dir} (the
folder an agent's machine keeps agents in). A {word} that names nothing is
left as written.

## Kickoff

An agent starts working when a message addresses it, so a room's kickoff
mentions each agent it needs: kickoff: "@{lead.name} start on the brief."
When you run the template, the kickoff speaks for you, not your owner: an
agent that would not accept messages from you makes the run fail before
anything is created (leave a new agent on the default, owner-agents, or give
it anyone_in its room; owner shuts you out). Asking again for a room with the same kickoff you already used
further up the same path pauses the run until your owner lets it continue.

## Example

version: 2
params:
  topic: {type: string, description: What the room is about}
resources:
  review:
    type: room
    name: "{topic} review"
    description: "Reviewing {topic}"
    agents: [reviewer]
    users: ["{$creator}"]
    kickoff: "@reviewer read the brief and list three risks in {topic}."

## Version 1

Older templates have no resources: and say what a block is by where it sits.
A top-level agent: or agents: list holds agents (each with location: local |
ssh host instead of machine: on a Console that runs them itself), room: one
room with a top-level kickoff:, and group: with rooms: and links: a group. A
room lists agents by the text written as their name, and in a single agent:
document {agent} is its name. They still run as they are; write new ones in
version 2.
"""
