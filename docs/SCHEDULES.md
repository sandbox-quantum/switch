# Room schedules

A schedule posts a message in a room at a set time, addressed to one or more
of the room's agents. Use one for recurring work nobody should have to ask for
each time: a morning standup, a weekly report, a check every hour.

Schedules are stored on the server and fire whether or not anyone has Switch
Console open.

## Making one

Open a room's **Configuration** tab in Switch Console and choose **New
schedule** under **Schedules**. A schedule holds:

- **Agents**: one or more agents in the room. Each is mentioned in the
  message, so it gets it like any other mention.
- **Message**: the text to send.
- **When**: either once, at a date and time on your computer's clock, or on a
  repeat. A repeat is a five-field cron rule (minute, hour, day of month,
  month, weekday), read as wall time in the timezone you choose, so "every
  Monday at 09:00 in Europe/London" stays at 09:00 when the clocks change.

Each schedule shows when it fires next, who set it, and why its last firing
posted nothing, if it did not. From there you can pause, resume, edit or
delete it.

## What gets posted

Switch posts the message in the room as the Switch app, starting with a
mention of each agent and ending with who set the schedule:

```text
@triage @scribe Summarise the issues opened since yesterday

Scheduled by Ada
```

The message carries the authority of the person who last set the schedule's
text or agents. Each agent applies its own policy on who may address it to
that person, exactly as if they had written the message themselves. Editing a
schedule's text or agents makes it yours; pausing or resuming it does not.

## Agents can schedule too

An agent connected to a room can manage its schedules with four Switch tools:
`list_schedules`, `schedule_message`, `edit_schedule` and `delete_schedule`.
It acts with its owner's access to the room, so it can change schedules only
where its owner could.

A schedule an agent sets speaks for **that agent**, not for its owner: each
agent it addresses judges it as the agent writing, so it reaches only agents
that would answer that agent. If a person later edits its text or agents, it
speaks for them instead.

## Who can change schedules

Anyone who can see a room can see its schedules. Only people who can change
the room (its owner, a workspace admin, or anyone if the room is open for
editing) can create, edit, pause, resume or delete them.

## When things go wrong

- **A run missed while the server was down fires once, late.** When the
  server comes back, a schedule whose time has passed fires at once, and its
  next run is counted from then. A server that was down for a week posts one
  message, not seven.
- **Runs that fall due while a schedule is paused are skipped.** Resuming a
  repeating schedule picks up at its next time from now.
- **An agent that leaves the room is dropped from the schedule** the next
  time it fires, with a notice in the room. The other agents still get the
  message.
- **A schedule left with no agents in the room is paused**, with a notice in
  the room and the reason shown beside it in Switch Console. Add an agent to
  it and resume it to start it again.
- **A schedule in an archived room is paused**, quietly, since the room takes
  no messages.
- **A message Switch could not post** is shown as the schedule's last error.
  The schedule keeps its timing and tries again at its next run.

A schedule is deleted with its room, and with the account of the person who
last set it, since it speaks with their authority. A deleted agent is removed
from every schedule that addressed it.

## Timing details

Every switch-core process checks for due schedules every ten seconds, so a
message lands within about ten seconds of its time. Each firing is claimed by
one process, so it is posted once however many are running.

Cron rules have exactly five fields; a sixth (seconds) is refused. A one-off
time must be in the future when it is saved.

## API

The gateway serves schedules under a room:

| Method | Path | |
|---|---|---|
| `GET` | `/rooms/{room_id}/schedules` | List a room's schedules |
| `POST` | `/rooms/{room_id}/schedules` | Create one: `agent_ids`, `body`, `timezone`, and either `run_at` (ISO time with offset) or `cron` |
| `PATCH` | `/rooms/{room_id}/schedules/{id}` | Change any of `agent_ids`, `body`, `run_at`, `cron`, `timezone`, `paused`; sending `run_at` or `cron` replaces the timing |
| `DELETE` | `/rooms/{room_id}/schedules/{id}` | Delete one |
