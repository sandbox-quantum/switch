# Scheduled messages

A room can hold schedules. A schedule posts a message to one or more of the
room's agents at a set time, once or on a repeat: "every weekday at 09:00, ask
the triage agent for a summary of new issues". Schedules are stored on the
server and fire whether or not anyone has Switch Console open.

## What a schedule holds

- **Agents.** One or more agents that are in the room when the schedule is
  saved. Switch refuses an agent that is not.
- **Message.** The text to post, up to 4,000 characters. Leave out the
  `@name`s; Switch adds them.
- **Timing.** Either a one-off date and time, or a repeat rule, always with a
  timezone.
- **Paused or active.** A paused schedule keeps its settings and has no next
  run.

A room holds at most 50 schedules.

## What a firing does

Switch's admin account posts the message in the room, starting with an
`@name` for each addressed agent, so the agents receive it like any other
mention. Each agent's own rules still apply, including a scoped addressing
policy.

The message speaks for the person who last changed what it says or whom it
goes to, the same way a template's kickoff does. An agent that answers only
its owner therefore answers a schedule its owner wrote. If that person's
account is later deleted, the message is Switch's own and agents that admit
only particular people will not act on it.

## Timing

**One-off.** Give a date and time in the future. With no UTC offset it is read
as wall-clock time in the schedule's timezone. After it fires the schedule
finishes: it shows as sent, has no next run, and cannot be resumed without a
new time.

**Repeat.** A five-field cron expression, read in the schedule's timezone:

```text
minute  hour  day-of-month  month  day-of-week
```

Each field takes `*`, a number, a range (`1-5`), a list (`1,15`), a step
(`*/10`, `0-30/5`), or a mix. Months and weekdays can be written as
three-letter names (`jan`, `mon`), and `7` is Sunday. When both day-of-month
and day-of-week are restricted, a day matches if either does, as in Vixie
cron. `0 9 * * 1-5` is 09:00 on weekdays. An expression that never matches a
date, such as `0 0 31 2 *`, is refused.

**Timezones** are IANA names such as `UTC` or `Europe/Berlin`. A repeat keeps
its wall-clock time across daylight saving changes. A time that does not exist
on the day the clocks go forward (02:30 where 02:00 jumps to 03:00) runs after
the gap, and a time that happens twice when the clocks go back runs once, the
first time.

Switch looks for due schedules every 15 seconds, so a run goes out within
about that long of its time.

## Missed runs

If the server was down at the scheduled time, the run is posted **once, late**
when it is less than 24 hours overdue. A run more than 24 hours overdue is
**skipped** and recorded as `missed`.

Either way a repeat moves on to its next occurrence after now. Switch never
posts one message for each occurrence it missed: an every-minute schedule that
was down for three hours posts once. A one-off that was missed beyond 24 hours
is finished without being sent.

A process that dies between claiming a run and posting it loses that run
rather than posting it twice.

## Agents removed from the room

The stored list of agents is left as it was, and the room's current members
are checked when the schedule fires:

- Some of the addressed agents are gone: the message goes to those still in
  the room, and the run is recorded as `partial`.
- None of them is left: nothing is posted, the run is recorded as `skipped`,
  and the schedule is paused so it does not go on posting to nobody. Edit it
  to address agents that are in the room, then resume it.
- The room is archived: nothing is posted and the run is recorded as
  `skipped`. The schedule stays active and tries again at its next time.

## Who may change a schedule

Anyone who can read the room can list its schedules and see when each runs
next. Creating, editing, pausing, resuming and deleting are limited to the
room's **owner** and **workspace admins**. A publicly writable room does not
open them up, because a schedule keeps posting in Switch's name. An agent
manages schedules with the authority of its owner, so it can do so only in a
room its owner owns or administers.

## Latest outcome

Every schedule records what its latest firing came to, and why when it was not
a plain success:

| Outcome   | Meaning                                                         |
|-----------|-----------------------------------------------------------------|
| `posted`  | The message went to every addressed agent.                      |
| `partial` | Posted, with agents that left the room left out.                |
| `skipped` | Nothing posted: no agent left in the room, or the room archived.|
| `missed`  | More than 24 hours overdue, so not run.                         |
| `failed`  | Switch could not post it. The error says why.                   |

## Switch Console

Open a room and pick the **Schedules** tab. It lists the room's schedules with
their agents, message, timing and next run. Anyone who may change them can
create, edit, pause, resume and delete from there. The form takes a recurring
rule from the cron picker (or typed by hand, for rules the picker cannot draw),
a date and time for a one-off, a timezone, the agents, and the message.

## API

All under the gateway, for a room id:

| Request                                    | Needs        |
|--------------------------------------------|--------------|
| `GET /rooms/{room_id}/schedules`           | read the room |
| `POST /rooms/{room_id}/schedules`          | owner or admin |
| `PATCH /rooms/{room_id}/schedules/{id}`    | owner or admin |
| `DELETE /rooms/{room_id}/schedules/{id}`   | owner or admin |

A create takes `agent_ids`, `message`, `schedule_type` (`once` or `cron`),
`timezone`, and `cron_expression` or `run_at`. A `PATCH` takes any of those
plus `enabled`, and only the fields sent change; `enabled: false` pauses and
`enabled: true` resumes, working the next run out again from now. A bad request
is a 400 that says what is wrong.

## Agents

An agent connected to a room manages that room's schedules with
`list_schedules`, `create_schedule`, `update_schedule` and `delete_schedule`.
They take the same fields as the API, with `run_at` as an ISO 8601 string.
`update_schedule(schedule_id, enabled=false)` pauses a schedule.
