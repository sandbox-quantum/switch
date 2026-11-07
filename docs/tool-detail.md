# Tool calls in the room

When an agent works, the room sees each tool call it makes by name: "Ran
`pytest`", "Read config.toml". A room can also be allowed to see what each call
was given and what it gave back, so someone reviewing the agent's work can
answer "what did it actually run?" without leaving the chat.

It is off unless someone turns it on, because a room can include people outside
the team and secrets are masked by pattern, which can miss one.

## Turning it on

In Switch Console, open the room's settings and switch on **Tool calls**. Only
the room's owner or a workspace admin can change it, even in a room anyone may
write in. It applies to every agent in the room.

A change applies from the agent's next message in the room. The agent is told,
in what `connect_to_room` answers, that its tool calls can be seen there.

The Switch server enforces it. It keeps a call's detail only while the room has
it on, checked as the call is recorded, so a session host still holding an
older answer cannot put detail into a room that has since turned it off. It
draws the detail only while the room still has it on, so turning it off also
takes it out of anything Switch draws after: a turn's card redrawn, or a
**Show activity** reply asked for later. What a platform has already delivered,
such as a reply someone has open, stays as it was.

## Where it is shown

Never posted into the channel by itself. A reader opens it:

- **Slack:** in the call's card, inside the turn's plan, which is collapsed
  until someone opens it.
- **Mattermost and Discord:** in the turn's **Show activity** reply, which only
  the person who asked sees, and only if they are in the channel.

Teams and Telegram show the call by its name alone.

## What is shown

The call's input, its output and its exit code, as far as the agent's provider
reports them: at most 2,000 characters in all, and at most 500 of them for the
input, each part cut at the end of a line with a note saying how much more was
not shown. Console still shows the whole of what the session host keeps.

## What is masked

Before anything leaves the machine the agent runs on, the session host
replaces:

- every service token it issued to the session, in each form it can be written;
- the secrets it hands the agent and its MCP servers: the value of each
  secret-named environment variable, and the credential in each MCP server's
  authentication header;
- everything the desktop log masks (`@switch-console/shared/secret-redaction`),
  which is one set for both: values given to names ending in `password`,
  `secret`, `token`, `api_key`, `access_key`, `secret_key`, `private_key` or
  `credential`, in environment variables, JSON, YAML and command-line flags,
  quoted values whole; `Authorization` and `Bearer` values; the password in a
  URL such as `postgres://user:password@host`; JSON Web Tokens; PEM private key
  blocks; and keys known by their prefix (`sk-` keys, Slack's `xox…-`, AWS
  `AKIA`/`ASIA`, Google `AIza`, GitHub, GitLab, npm and Stripe keys).

The session host keeps only the head and the tail of a long output. Each is
masked on its own, and the partial line at each cut is dropped, so a secret
split by a cut leaves no piece behind. A private key block that a cut left open
is masked up to the cut. A string the host cut short in a call's input is shown
as a note. If masking fails, the call is shown by its name alone.

This is a heuristic. A secret in a shape none of these match is shown as it
is, so keep secrets out of commands and output in a room where this is on.

## Where it is kept

With the turn's activity on the Switch server, for as long as that activity
is kept (seven days), so a room's messages can be redrawn. It is not written to
the session's own journal. A session host restarted in the middle of a turn
shows nothing more for that turn.

## With older versions

A Switch server that predates this refuses a call's detail, and the session
host sends the call again without it. A session host that predates it sends
none. Either way the room sees the call by its name alone.
