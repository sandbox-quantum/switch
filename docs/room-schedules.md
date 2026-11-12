# Room schedules

A schedule posts a message in a room, addressed to some of its agents, at a set
time: once, or on a repeating rule. For example, "every weekday at 9:00, ask
the triage agent for a summary of new issues". The agents get it like any other
mention and answer in the room.

Schedules are kept on the Switch server and fire whether or not anyone has
Switch Console open.

## Setting one up

In Switch Console, open the room's settings and find **Schedules**. Choose the
agents, write the message, and pick when it is sent:

- **Repeats**: a day, a weekday, a day of the month and a time, read in the
  schedule's timezone. Through the API any five-field cron rule works, such as
  `0 9 * * 1-5` for weekdays at 9:00.
- **Once**: a date and time, on the clocks of the schedule's timezone: 09:00
  with `Asia/Tokyo` goes at nine in Tokyo, wherever it was entered.

The timezone defaults to your computer's. Each schedule shows when it runs next.
The message can be up to 4000 characters. Nothing stops a rule from running
every minute (`* * * * *`); each run is a mention the agents answer, so pick the
interval with that in mind.

## Who it speaks for

A schedule's message is posted on behalf of its author: whoever last set what
it says, to which agents, or when. Each agent answers it as it would answer that
person, under its own addressing policy, the same way a template's kickoff
works. An agent that only answers its owner will not act on a schedule someone
else wrote.

Editing a schedule makes you its author, so nobody can make a schedule speak
for someone else. Deleting an account deletes the schedules it is the author
of.

## Who can change them

Anyone who can see the room can see its schedules. Changing them (adding,
editing, pausing, resuming, deleting) takes the right to manage the room: its
owner or a workspace admin. Being able to write in the room is not enough, even
if it is open for writing.

Each run checks that again for the schedule's author. If they may no longer
manage the room (an admin who lost the role, a room handed to a new owner), the
schedule is paused and the room is told. Someone who may manage it can edit it,
which makes them the author, and resume it.

## Schedules an agent sets up

Agents manage schedules through their Switch tools: `list_room_schedules`,
`create_room_schedule`, `update_room_schedule`, `pause_room_schedule` and
`delete_room_schedule`. They go through the same checks as Console, with these
differences:

- A schedule an agent sets up is posted as that agent, under its owner's
  authority, so each agent it names answers it as it would answer that agent.
  An agent that only answers its owner does not act on it. An agent may name
  itself, for a reminder of its own.
- The agent has to be in the room, and its owner has to be allowed to manage
  it. An agent nobody owns cannot set up schedules.
- An agent can change only the schedules it set up itself. A person who
  manages the room can change any schedule; editing an agent's makes it theirs.
- If the agent leaves the room, its schedules there are paused and the room is
  told. Deleting the agent deletes them.

Console shows which agent set up a schedule.

## What happens when

- **On time.** One server process at a time checks for due schedules every few
  seconds, and each run is claimed in the database before it is posted, so it
  goes once however many processes are running.
- **Clock changes.** A time the clocks skip (02:30 on the night they go forward)
  runs at the first moment after the gap. A time they repeat runs once.
- **Missed runs.** If the server was not running when a run was due, the run is
  sent once when it is back, with a note saying when it was meant for. Earlier
  missed runs of the same schedule are not sent: the next run is worked out from
  then.
- **A server stopping mid-run.** If the server stops after taking a run and
  before posting it, that run is skipped rather than risk sending it twice.
- **Paused.** A paused schedule sends nothing. Resuming starts again from now;
  runs that fell due while it was paused are not sent.
- **One-off.** Sent once, then kept, marked as sent, until you delete it.
- **Agents that leave.** A run is addressed only to the schedule's agents still
  in the room. If none are left, the schedule is paused and the room is told.

## API

All under `/gateway`, with a signed-in session.

| Route | Needs | Does |
| --- | --- | --- |
| `GET /rooms/{room_id}/schedules` | read the room | The room's schedules, oldest first |
| `POST /rooms/{room_id}/schedules` | manage the room | Add one. Body: `agent_ids`, `text`, and either `cron` or `run_at` (with its offset), plus `timezone` |
| `PUT /rooms/{room_id}/schedules/{schedule_id}` | manage the room | Replace what it says, to whom and when; you become its author |
| `PUT /rooms/{room_id}/schedules/{schedule_id}/paused` | manage the room | `{"paused": true}` or `false` |
| `DELETE /rooms/{room_id}/schedules/{schedule_id}` | manage the room | Delete it |

A schedule that cannot be kept as given (an unknown timezone, a rule that is
not cron, a one-off in the past, an agent not in the room) is refused with
`422` and the reason.
