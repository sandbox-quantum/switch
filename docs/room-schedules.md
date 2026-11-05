# Schedule a message to room agents

Open a room's **Configuration** tab and choose **New schedule**. Enter the task,
choose agents currently in the room, and select a one-off time or a recurring
rule. The next run shown after saving comes from the server.

A room's owner and workspace administrators can create, edit, pause, resume,
and delete schedules. Other people who can read the room can see its schedules.
Public write access alone does not grant permission to create recurring work.

## Times and repeats

One-off inputs use the timezone of the computer running Console. Recurring rules
use five-field cron and the IANA timezone entered below the picker, for example
`0 9 * * 1-5` in `Asia/Kolkata` for weekday mornings. Choose **Enter a cron rule**
for expressions beyond the picker's presets. Next-run dates are displayed
in the schedule's chosen timezone. The server rejects invalid zones and rules.

Recurring times follow local wall time. A time that does not exist during a
daylight-saving transition is skipped. A repeated local time runs at its first
occurrence only.

If the server was down, it sends one overdue occurrence and advances to the next
future time. It does not replay every missed occurrence. Pausing suppresses runs;
resuming a recurring schedule starts from now. Resuming an overdue one-off sends
it once. Edit its date to run a completed one-off again.

## Execution and permissions

Schedules are stored and fired on the Switch server, even while Console is
closed. The message is posted by Switch on behalf of the person who last edited
or resumed the schedule. Each target agent still applies its addressing policy
to that person. A schedule cannot bypass an agent's owner-only policy.

An agent's execution host must be available to answer. Posting a scheduled
message does not itself bring an offline computer or agent host online.

At firing, Switch rechecks the author's current authority and the room's current
agent membership. It skips targets that have left. A schedule with no remaining
targets, an archived room, or an author who can no longer manage the room is
paused with a reason shown in Configuration. Correct the cause and resume it.
Deleting the author's account removes their schedules.

Edits and pauses serialize with a firing already in progress. A message committed
before a pause or deletion is accepted remains in the room.

## Reliability

The message, its routed agent events, the run receipt, and the next scheduled
time are written in one PostgreSQL transaction. The receipt records the committed
room post. As with ordinary mentions, Switch can log an individual agent's routing
failure and still accept the room post. Recovery after a missed notification
applies to agent events successfully stored by the router.

Failure before the commit leaves
the occurrence due. After commit, another worker sees the advanced schedule and
does not create the occurrence again. All server replicas may run the scheduler;
row locks ensure only one claims each due occurrence.

This guarantee covers the durable scheduled message in Switch. External chat
delivery and arbitrary actions performed by an agent follow their own retry and
recovery rules.
