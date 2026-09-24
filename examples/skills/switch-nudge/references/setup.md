# Set up Switch Nudge

Switch Nudge sends one addressed reminder later. A dedicated sender identity
posts into the chosen thread. The recipient can schedule the same ID again.
There is no automatic repetition, acknowledgement, renewal or recovery nudge.

Requirements: Python 3.10+, macOS or Linux, and a compatible Switch MCP runtime.
The default runtime command is `npx --yes @sandboxaq/switch-agent-runtime@0.4.3`,
the version pinned by the connector when this helper was built. It requires
Node and npx and may download that official package on first use. An existing
local runtime can be configured instead. The helper needs no Switch server changes.

## Install the skill and command

Copy this `switch-nudge` directory into your client's discoverable skills
location. One shared installation location is `~/.agents/skills/switch-nudge`.
Expose it to other clients with their normal skill installation or symlink
mechanism. Install the real command so the examples printed in reminders run:

```
mkdir -p ~/.local/bin
ln -s /absolute/path/to/switch-nudge/scripts/nudge ~/.local/bin/nudge
```

Ensure `~/.local/bin` is on the agent host's PATH. Do not overwrite an unrelated
existing `nudge` command. The launcher resolves its own symlink to find the
Python helper. It can also be invoked directly as `<skill>/scripts/nudge`.

## Reuse an existing watcher setup

There is no need to rename the existing Switch sender or create new credentials.
If `~/.local/state/switch-nudge/config.json` is absent and the previous
`~/.local/state/switch-watch/config.json` exists, Nudge uses the old directory.
Keep using that directory consistently. A custom `--state-dir` also works.

Stop the old worker before migration. Nudge refuses to convert state while a
worker holds its lock. On first state access, it saves `watcher-state-backup.json`
and converts records without posting anything:

- An old pending timer becomes a one-shot nudge at its existing next check time,
  still subject to its old expiry until explicitly rescheduled.
- An old reminder awaiting acknowledgement becomes `sent`; nothing is replayed.
- Stopped and expired registrations stay ended.
- Interrupted sends become `uncertain` and require inspection.

Rescheduling a migrated ID sets one new due time and removes its legacy lease.
The old start/ack/touch/renew/stop commands no longer apply. Read the new skill in
existing agent sessions. Keep historical copies outside discoverable skill folders
so agents do not choose the retired workflow.

## Create a sender identity if needed

Create a dedicated Switch agent identity, for example `nudge.example`, with
LLM-session auto-start disabled. Do not launch an LLM under that identity.
An existing `watcher` identity works unchanged.

You can use Switch's normal setup or the bundled registration helper:

```
python3 <skill>/scripts/register.py \
  --endpoint https://YOUR-SWITCH-API --name nudge.example \
  --output ~/.config/switch-nudge/sender.json
```

The helper prompts privately for a registration token from the Switch gateway's
API keys page, or reads `SWITCH_REGISTRATION_TOKEN`. It registers a Codex-type
identity with `auto_session: false`; it never launches Codex. Registration is a
remote write. The returned credentials are saved with mode 600 and existing
files are never overwritten. An uncertain registration is not automatically
retried; inspect the saved response and server state first.

Add the sender to each relevant room and permit it under each target agent's
addressing policy. Room membership alone does not prove permission. The target
needs a reachable session or an existing controller able to start one.

## Configure and check

Reuse the sender's existing `.switch/agents/<name>.json` or registration output.
The credential file must be owned by this OS user with mode 600. Only its path
is saved in configuration, not a second copy of the token.

```
nudge configure --credentials ~/.config/switch-nudge/sender.json --sender nudge.example
nudge check --room ROOM_ID --target assistant.example
```

`check` opens the sender's connection and verifies membership without posting.
It may make the sender appear online. Addressing permission is only proven by
an actual targeted send. Run check when no worker is running so it does not
compete for the sender's connection.

To use a local runtime rather than npx:

```
nudge configure --credentials ~/.config/switch-nudge/sender.json --sender nudge.example \
  --runtime-json '["node", "/absolute/path/to/switch-agent-runtime/dist/bin.mjs"]'
```

Use HTTPS for a remote API, or HTTP on loopback. Never pass a token on the
command line, print it, or commit it. The helper strips inherited Switch identity,
connection and session variables before starting its own MCP runtime.

## Try one reminder

```
nudge schedule --room ROOM_ID --target assistant.example --thread THREAD_ID \
  --label 'Nudge test' --in 60s
nudge status
```

Use the returned ID for subsequent commands. Confirm that the reminder arrives
in the chosen thread and the recipient responds. The reminder contains a
backticked command to schedule the same ID again. If no command is run, there
will be no second reminder. Cancel a rescheduled timer with `nudge cancel ID`.

Offline tests cover sender isolation, one-shot delivery, cancellation,
rescheduling and migration. They do not prove your server's compatibility,
addressing policy or model wake-up. Use this small live trial for those checks.

## Remote execution and recovery

Install the skill, command and sender configuration on the host where the agent
runs. Your laptop can be off when both helper and agent run remotely. An agent
on a different host must run control commands through an existing remote
execution route; this helper does not expose a remote control API.

Use one sender identity per helper installation. Multiple registrations on that
host share one worker; multiple hosts using the same identity may contend for
its connection. Do not use the target's own credentials, since Switch filters
an identity's own messages.

One detached Python worker serves the host's scheduled nudges. It opens the
sender's MCP connection for delivery and closes it afterward. The worker exits
when no scheduled nudges remain. In `status`, `worker_running` checks the process
lock; a saved PID alone does not prove the worker is alive.

The worker can still be stopped by host reaping, logout policy, reboot or a
crash. No launchd or systemd service is installed. `nudge run` resumes pending
timers in the foreground and can run under an existing supervisor. Use
restart-on-failure if supervising it; normal exit means no timers remain.

An interrupted send becomes uncertain rather than being replayed. Clock changes
and host sleep can delay delivery. Overdue pending timers can send when the
worker resumes, so check whether they are still useful before restarting it.
No reminder is retried just because it received no response. The helper cannot
wake a stopped model session unless existing Switch startup settings permit it.

For a custom state directory, put `--state-dir PATH` before the subcommand.
The reminder includes that path in its reschedule command. Agents using the same
OS account share that account's access to the helper.

State lives in `~/.local/state/switch-nudge`, or the reused legacy directory,
with mode 700 on the directory and 600 on files. Use the same OS user and state
directory for all control commands. Do not use a saved PID to kill a process.
To retire the tool, cancel all pending nudges and confirm the worker has exited.
Revoking the sender's server identity or room membership is a separate action.
