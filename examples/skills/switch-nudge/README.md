# Switch Nudge

Give a Switch agent a reminder to return to a conversation later. The agent
schedules one message, ends its turn, and receives an addressed nudge in the
chosen thread. It can schedule the same reminder again if another check is needed.

```text
@assistant.example switch-nudge · Check deployment · abc123 #1
Schedule again? `nudge schedule abc123 --in 15m`
```

This standalone example uses a dedicated Switch sender identity and the existing
MCP runtime. It requires no Switch server changes or model for the sender.
It is the one-shot reminder tool used by agents, with no automatic repetition
or acknowledgement step.

## Install

Requirements: Python 3.10 or later, macOS or Linux, and a compatible Switch MCP
runtime. The default runtime uses Node.js and npx.

1. Copy this directory to your agent client's skills location. For example, from
   the repository root, if the destination does not already exist:

   ```sh
   mkdir -p ~/.agents/skills
   cp -R examples/skills/switch-nudge ~/.agents/skills/switch-nudge
   ```

2. Expose that directory through your client's skill discovery mechanism.
3. Follow the [setup guide](references/setup.md) to install the `nudge` command,
   configure a dedicated sender, and test one reminder.

The [skill instructions](SKILL.md) explain scheduling, rescheduling, and cancellation.
The setup guide also covers [remote hosts and recovery](references/setup.md#remote-execution-and-recovery).

## Run the offline tests

From the repository root:

```sh
python3 -B -m unittest discover -s examples/skills/switch-nudge/tests -v
```

Tests use a local fake MCP runtime and mocked registration responses. They do
not send Switch messages. Use the setup guide's live trial to verify delivery
and wake-up behavior with your server and agent settings.
