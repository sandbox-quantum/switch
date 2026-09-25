# Switch templates: the language

A template is one YAML document that says what to create: an agent, a room,
or several of each, with the values the deployer may change declared up
front. Switch Console reads it on the Templates page, builds one form from
its `params:` block, and creates everything in one pass. Nothing the form
fills in comes from anywhere but the document: every default, every choice
of what to ask and what to fold away, and every fallback order is written in
the template.

This page is the reference. `switch-expert/template.yaml` at the repository
root is the worked example, and `examples/` holds more.

## Contents

1. [A first template](#a-first-template)
2. [Document structure](#document-structure)
3. [Params](#params)
4. [Placeholders and builtins](#placeholders-and-builtins)
5. [The agent block](#the-agent-block)
6. [The room block](#the-room-block)
7. [Groups](#groups)
8. [Kickoff](#kickoff)
9. [Where an agent works](#where-an-agent-works)
10. [The form block](#the-form-block)
11. [Agents and saved templates](#agents-and-saved-templates)
12. [Validation](#validation)
13. [Versioning](#versioning)

## A first template

```yaml
version: 1
params:
  name:
    type: string
    label: Agent name
    default: jq expert
  bridge:
    type: bridge
    default: [$first]
  provider:
    type: provider
    default: [claude, codex, opencode]
    input: advanced
agent:
  display_name: "{name}"
  provider: "{provider}"
  repo: https://github.com/jqlang/jq
  addressing: anyone
  instructions: |
    You help people write and debug jq filters. Read the jq source in
    `jq/` inside your directory rather than answering from memory.
room:
  name: "Ask {agent}"
  bridge: "{bridge}"
  agents: ["{agent}"]
  users: ["{$creator}"]
kickoff: "@{agent} hi, introduce yourself in two lines."
```

The form for this template shows two inputs, the agent's name and the
messaging app, both filled in, and an Advanced fold with the provider. One
click creates the agent, then the room with the agent and the deployer in
it, then posts the kickoff.

## Document structure

A document has these top-level keys. All are optional except that it must
describe at least one thing to create.

| Key | What it is | Created by |
|---|---|---|
| `version` | The format version, an integer. `1` today. | |
| `params` | The inputs of the form, each with a type and a policy. | |
| `agent` | One agent to create. | Switch Console |
| `agents` | A list of agents to create. | Switch Console |
| `room` | One room to create. | The server |
| `group`, `rooms`, `links` | A room group, its rooms, and links between them. | The server |
| `kickoff` | A message posted into the room once it exists. | The server |
| `form` | How the form folds things away. | Switch Console |

There is only one kind of template. A listing shows a document as an agent,
room or group template by looking at which keys it has, so a saved document
with `agents:` and `room:` is listed as a group. Nothing about the language
changes with the kind.

Two engines read the document. Switch Console creates the agents, because an
agent runs on a machine the Console can reach and the server cannot, and
resolves the params only it can answer (where an agent runs, which coding
agent runs it, in which directory). The server creates the rooms from the
rest, through `POST /rooms/from-yaml`, and resolves the params that name
things it has (messaging apps, agents, rooms, users). Both read the same
document under the same rules.

## Params

### Configuration model

```yaml
params:
  <name>:
    type:         string | number | boolean | enum | agent | bridge | room | user
                  | provider | location | directory
    description:  text
    label:        text
    default:      value, or a list of candidates
    required:     true | false
    input:        ask | advanced | fixed
    enum:         [choices]          # enum only
    multiline:    true | false       # string only
    pattern:      regular expression # string only
    min:          number             # number only
    max:          number             # number only
```

A param is referred to as `{name}` anywhere else in the document. The key
is the name; keep it a plain identifier.

### Specification

**`type`**. Data type: one of the names below. Default: `string`.

| Type | Value | Who resolves it |
|---|---|---|
| `string` | Text. | |
| `number` | An integer or decimal. | |
| `boolean` | `true` or `false`. | |
| `enum` | One of the strings in `enum:`. | |
| `agent` | The name of an agent the server has. | The server checks it exists. |
| `bridge` | The display name of a messaging app set up on the server. | The server checks it exists. |
| `room` | The name of a room on the server. | The server checks it exists. |
| `user` | A username on the room's messaging app. | The server looks it up on the app. |
| `provider` | A coding agent id: `claude`, `codex` or `opencode`. | Switch Console; never sent to the server. |
| `location` | Where an agent runs: `local`, or an SSH host name the Console knows. | Switch Console; never sent to the server. |
| `directory` | An agent's working directory, on the machine it runs on. | Switch Console; never sent to the server. |

**`description`**. Data type: text. Shown under the input.

**`label`**. Data type: text. The name of the input on the form, when the
key is not a good one ("Agent name" for `name`). Without it the form shows
the key, or a stock label for `bridge`, `provider`, `location`, `directory`
and `room`.

**`default`**. Data type: a value of the param's type, or for `agent`,
`bridge`, `room`, `provider` and `location` a list of candidates. Default:
none. A single value fills the input before the deployer touches it. A list
is a fallback chain, tried in order: the first candidate the server (or,
for `provider` and `location`, the Console) has wins. Two words are
special inside a chain:

- `$first`: the first thing of that type. For a bridge, the server's default
  messaging app; for an agent or a room, the first by name; for a provider,
  the first coding agent installed where the agent runs; for a location,
  this computer.
- `$new`: for a `room` param only, the room this document's own `room:`
  block describes. See [Where an agent works](#where-an-agent-works).

```yaml
bridge:
  type: bridge
  default: [Slack, Mattermost, $first]   # Slack if set up, else Mattermost, else the default app
```

A chain with no hit leaves the input empty. With `required: true` that
blocks creation, and the message names the candidates that were tried.

**`required`**. Data type: boolean. Default: `true` when there is no default
or the default is a chain, `false` when there is a single default value.
Whether the value may be empty when the template is used. Only a `string`,
a `bridge` or a `room` param may be optional without a default: an empty
string is substituted, a room whose `bridge:` reads an empty bridge param
is created on the server's default messaging app, and an empty room param
drops out of the list it was written in, which for an agent's `join` means
no room. Every other type needs a default to be optional.

**`input`**. Data type: `ask`, `advanced` or `fixed`. Default: `ask`. How the
form shows the param.

- `ask`: a visible input, filled from the default when there is one.
- `advanced`: filled from the default and folded away, one line with a
  Change button. The deployer who accepts the value never sees the control.
  Without a default, or when the value is empty or wrong, it opens by itself.
- `fixed`: shown, not editable. The value is the default. This exists so
  an author can name and describe a value instead of burying a literal in
  the document, and loosen it later by changing one word. Needs a default.

**`enum`**. Data type: list of strings. The choices of an `enum` param. The
default, when given, must be one of them.

**`multiline`**. Data type: boolean. Default: `false`. A `string` param
carrying long text (a brief, instructions) renders as a text area, which
keeps pasted newlines.

**`pattern`**. Data type: a regular expression. A `string` param's whole
value must match it. Checked on the form as the deployer types and again
by the server.

**`min`**, **`max`**. Data type: number. Inclusive bounds of a `number`
param. Checked on the form and by the server.

### What the form does with a param

The form has an agent section per agent the template creates, then a room
section. A param is shown in the section of the block that reads it: one
written into an agent's fields sits with that agent, one written into the
room sits with the room, and a `room` param always sits with the room since
it says where the agent works. A `provider`, `location` or `directory`
param that no agent binds applies to every agent.

The Create button stays disabled while a required param is empty or a
value breaks its `pattern` or bounds, and says which.

## Placeholders and builtins

Any string in the document may contain `{name}` for a declared param. When
a whole field is one placeholder the typed value is substituted (so a
boolean param can fill a boolean field); inside longer text the value is
written as text. A `{word}` that names no param is left as written.

Some placeholders are filled in without being declared:

| Placeholder | Value | Filled by |
|---|---|---|
| `{$creator}` | The deployer, as the room's messaging app knows them: the account they linked there. On a room with no messaging app, their gateway name. | The server |
| `{$creator_email}` | The deployer's email. | The server |
| `{$date}` | Today's date, `YYYY-MM-DD`. | The server |
| `{$timestamp}` | The current Unix time. | The server |
| `{$agents_dir}` | The directory the Console keeps agents under, on the machine the agent runs on. | Switch Console |
| `{agent}` | In a document with a single `agent:`, that agent's identifier. | Switch Console |

A template that puts `{$creator}` in a bridged room needs the deployer to
have linked their account on that messaging app; the form says so and
offers to link it.

## The agent block

```yaml
agent:
  name:          identifier
  display_name:  text
  description:   text
  instructions:  text
  provider:      claude | codex | opencode | "{param}"
  location:      local | ssh host | "{param}"
  directory:     path | "{param}"
  repo:          URL
  sources:       [ {label, url} or url ]
  addressing:    owner | owner-agents | anyone
  join:          [ room name or "{param}" ]
```

`agents:` is a list of the same block, for a template that creates a team.
In that form a room refers to each agent by the text written as its `name`
(`"{team}-triager"`), and the form lets the deployer point each entry at an
agent the server already has instead of creating it.

**`name`**. The identifier the agent is created under and addressed by:
lowercase letters, digits, `.`, `-` and `_`, starting with a letter or
digit. When omitted, the Console derives it from `display_name` the same
way it derives an identifier from a name typed in its own dialog. A name
that an agent on the server already has blocks creation with a message;
nothing is renamed behind the deployer's back.

**`display_name`**. How the agent is shown to people. Write it as `{param}`
to let the deployer change it.

**`description`**. What the agent is for, shown to others.

**`instructions`**. The agent's brief. Required, except that the Console
reads the bundled Switch expert's from `AGENT.md` next to its template. A
template stored on a server or pasted into the Console carries it inline.

**`provider`**. The coding agent that runs it. A literal fixes it; `{param}`
of type `provider` lets the template say how much choice the deployer has.
When the field is absent and no `provider` param is declared, the form asks,
with nothing selected: the Console never picks one on its own.

**`location`**. Where it runs. `local` is this computer; otherwise an SSH
host the Console knows. When absent and no `location` param is declared,
the agent runs on this computer.

**`directory`**. Its working directory on that machine. `{$agents_dir}` and
`{agent}` are useful here. When absent and no `directory` param is declared,
the agent gets `{$agents_dir}/{agent}`, shown on the form under Advanced.

**`repo`**. A repository the agent works from. The Console clones it
(shallow) into the directory before the agent first runs; if that fails
the agent is still created and clones it itself.

**`sources`**. Pages the agent should read. Shown to the deployer; the agent
fetches them itself.

**`addressing`**. Who may talk to the agent: `owner` (the default), the
deployer only; `owner-agents`, the deployer and their other agents;
`anyone`, every member of its rooms. Set right after the agent is created.

**`join`**. Rooms the agent is added to once it exists, by name or through
a `room` param. See the next section but one.

## The room block

```yaml
room:
  name:            text
  description:     text
  instructions:    text
  bridge:          messaging app display name, or "{param}"
  channel_type:    channel_public | channel_private
  read_visibility: public | ...
  write_visibility: public | ...
  agents:          [ agent names ]
  users:           [ usernames ]
  roles:           [ ... ]
  references:      [ ... ]
  docs:            [ ... ]
  aliases:         { agent name: alias }
```

The same shape `POST /rooms/from-yaml` accepts and `GET /rooms/{id}/yaml`
exports, so an exported room is a valid template once you add `params:`.
`examples/room-templates/red-blue-workroom.template.yaml` documents every
field in place.

`agents:` names agents that exist on the server, plus the ones this
document creates by the text written as their `name`. `users:` names people
by their username on the room's messaging app; `{$creator}` puts the
deployer in. Without `bridge:` the room is created on the server's default
messaging app; on a server with none, it is a Switch-only room.

## Groups

```yaml
group:
  name: text
  description: text
  color: text
rooms:
  - <room block>
    kickoff: text
links:
  - { from: room name, to: room name, label: text }
```

`group:` with `rooms:` replaces `room:` for several rooms. Each room may
carry its own `kickoff:`; a top-level `kickoff:` on a group document is an
error, since it would not say which room it belongs to. `links:` are
optional and connect rooms of the group by name.

## Kickoff

```yaml
kickoff: |
  @{agent} hi. Introduce yourself in two lines.
```

Posted into the room on behalf of the deployer once the room exists and
its members have joined. An agent starts working when a message addresses
it, so mention the agent here or it sits in the room without answering.
Needs a `room:`; on a group document it goes inside each room entry.

**When an agent runs the template.** The kickoff speaks for that agent, not
its owner, so the agents it mentions wake only if their addressing admits
it. The server checks this before creating anything: if a mentioned agent
would ignore the kickoff, nothing is created and the agent is told which
one and why. The kickoff also carries the run so far, the rooms that led to
this one and who made them, so the agents it wakes can see what already
happened.

**Runs.** Every room an agent creates is recorded in a run: the room it was
working in, and the room the run started from. A template a person runs is
a run of its own; an agent creating a room from an ordinary room, such as a
lobby, starts a new run with that room. Runs are listed in Switch Console
under Templates, Recently used, as a tree, and the owner of an agent in the
run, the person who ran its template, or an admin can stop one. A stopped
run keeps its rooms; agents just cannot create more in it. An agent creates
one room at a time, and when it asks for a room with the same kickoff as one
it already made further up the same path, the run is paused. Continuing it
wakes that agent where it stopped, so the run carries on.

## Where an agent works

Three shapes cover the cases, each one line of template.

**The described room, no choice.** A `room:` block with no `room` param.
The room is always created with the agent in it.

```yaml
room: { name: "Ask {agent}", agents: ["{agent}"] }
```

**A room the deployer picks.** A `room` param the agent `join`s.

```yaml
params:
  where: { type: room, label: Room }
agent:
  join: ["{where}"]
```

**A choice, with the described room as the default.** Both, with `$new`
in the param's chain. The form offers the template's room as "New room"
alongside the rooms that exist.

```yaml
params:
  where: { type: room, default: [$new] }
agent:
  join: ["{where}"]
room: { name: "Ask {agent}", agents: ["{agent}"] }
```

When a `join` param exists, the template's room is created only when the
param resolves to `$new`. A document with neither `room:` nor `join:`
creates the agent and stops.

On the form, a `room` param an agent joins is a switch with the param's
label, on when its chain resolved to a room and off otherwise. The room
choice and the room's own params (its messaging app, its members) sit
under the switch and only while it is on. With `required: false` and no
default the switch starts off, and turning it on offers the template's
room first; the Switch expert ships that way. With `default: [$new]` it
starts on.

```yaml
params:
  where:
    type: room
    label: Start it in a room
    required: false
```

## The form block

```yaml
form:
  advanced:
    label: Advanced
    open: false
```

Every `input: advanced` and `input: fixed` param of an agent, and the
agent's directory when the template names none, sit together in one fold
under the agent's asked inputs. `label` names the fold; `open` says whether
it starts open. Folded, it shows its values on one line with a Change
button, and it opens by itself when something inside it is empty or wrong.
The block is the Console's; the server ignores it.

## Agents and saved templates

Agents can use the templates saved on a workspace through their Switch
tools: `list_templates`, `get_template`, `run_template`, `save_template`,
`update_template` and `delete_template`. `get_template_guide` gives an agent
a condensed version of this document and the schema the server checks
documents against (`core/switch_core/template_guide.py`; keep it in step).

- **What an agent sees.** Every shared template, and its owner's private
  ones. An owner's admin rights do not carry over to their agents.
- **Running.** A room or group template runs the way it does from the
  Console, through the same checks as an agent's own rooms (see
  [Kickoff](#kickoff)). An agent cannot create agents, so an agent or team
  template runs only when every agent it describes is replaced by one that
  already exists: `run_template` takes `agents: {slot: existing agent}`,
  and `get_template` lists the slots. The `agent:`/`agents:` block and the
  Console-only params are dropped, and the room half runs.
- **Saving.** An agent saves for its owner, `private` or `shared` (everyone
  reads it, only the saver changes it), and the template records which
  agent saved it. A name the owner already uses is refused.
- **Changing and deleting.** Only the agent that saved a template may change
  or delete it; not its owner's templates, and not another agent's.

A refusal tells the agent why, and is listed in Switch Console under
Templates, so the owner can see what their agents were asked to do and
could not.

## Validation

The server checks a document on upload and before provisioning, and the
Console runs the same check as the deployer types. Three findings refuse a
document outright: not YAML, empty, or not a mapping. Everything else is a
warning or an error the deployer sees against the field: an unknown param
type, a default that is not one of the enum's choices, a `$new` in a
document with no room, a placeholder no param declares, a param nothing
uses.

A param field this server does not know is a warning, not an error, since a
registry holds documents written for newer versions of Switch than the one
reading them.

## Versioning

`version: 1` names the format described here. The key is accepted and
checked as an integer; the server does not yet change how it reads a
document by its version, and a document without one is read the same way.
