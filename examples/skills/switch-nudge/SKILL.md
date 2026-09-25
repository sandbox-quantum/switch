---
name: switch-nudge
description: Schedule a one-shot Switch reminder, reschedule it for later, inspect delivery, or cancel it. Use when an agent needs to return to a conversation later without keeping its turn open.
---

# Switch Nudge

Arrange to be nudged later, then end the turn. The helper sends one addressed
message in a Switch thread. It does not interpret conversation, monitor activity,
or repeat automatically. If another check is needed, schedule the same ID again.

Read [setup](references/setup.md) when configuring a host or registering the sender. The helper uses a dedicated Switch sender and
the existing MCP runtime. No Switch server change or model for the sender is
needed. Keep credentials out of messages, command arguments and control records.

## Schedule a nudge

Use the installed `nudge` command. If it is not on PATH, run
`<this-skill>/scripts/nudge`, and finish the command installation in the setup
guide so the command printed in reminders works too.

```
nudge schedule --room ROOM_ID --target AGENT_NAME --thread THREAD_ID \
  --label 'Check deployment' --in 15m
```

Use a real Switch room ID, the recipient's exact agent name and an existing
thread's message ID. Do not use display names or a Matrix room ID. Keep the label
short and descriptive. `--top-level` explicitly permits a channel-level reminder
instead of `--thread`; prefer the existing work thread.

Save the returned ID, host, state directory, due time and purpose in the task's
persistent context. `status` reports worker health; successful registration does
not prove delivery. End the turn while waiting rather than sleeping or polling.
Delays range from 60 seconds to seven days.

## On receiving a nudge

Read recent room history and current task state before deciding what to do.
Deduplicate the registration ID and sequence against reminders already handled.
Follow newer instructions, including any cancellation or change of direction.
The sequence counts delivery attempts, not successful work.

Handle the check. If another check is needed, reschedule using the command in
the message, changing the delay when useful:

```
nudge schedule NUDGE_ID --in 15m
```

This retains the recipient, thread and label and replaces the next scheduled
time. It never adds a second pending timer to that registration. It also works
while the sender is still finishing the previous delivery. A completed send does
not overwrite a new schedule. Do not reschedule from an old duplicate reminder.

If no further check is needed, do nothing. The nudge has already finished.
There is no acknowledgement command and no recovery reminder. Use `cancel` when
there is a pending timer to remove, or to close the registration explicitly.

## Inspect or cancel

```
nudge status
nudge status NUDGE_ID
nudge cancel NUDGE_ID
nudge cancel all
```

`scheduled` means the timer is pending. `sent` means Switch returned a posting
receipt, not that the recipient has acted. `cancelled` registrations cannot be
rescheduled; create a new registration if needed. One pending registration per
target and thread prevents accidental duplicates. Different threads can carry
independent reminders.

`blocked` means delivery could not proceed. `uncertain` means the helper cannot
confirm whether a send completed. Inspect the room and fix the cause before
using `schedule NUDGE_ID --in 15m --retry-after-check`. There are no automatic
retries. Do not turn an unknown outcome into a duplicate message.

A send already in flight may land after cancellation. A late reminder does not
reverse a cancellation. Check current state before acting on it.

## Execution host

Run reschedule and cancel commands on the host holding the registration, using
its state directory. Put `--state-dir PATH` before the subcommand when needed.
Do not assume a reminder can wake a stopped session. For worker failures or
remote-host setup, read [execution and recovery](references/setup.md#remote-execution-and-recovery).
