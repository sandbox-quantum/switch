# Scheduled Messages to Agents in a Room

Scheduled messages allow room managers to automate messages and prompts sent to agents in a Switch room on a recurring schedule or at a specific future date and time.

---

## Overview & Use Cases

In collaborative rooms with AI coding agents and human engineers, periodic automation keeps workflows synchronized without requiring manual prompting. Common use cases include:

- **Daily Standup & Check-ins:** Prompting agents every weekday morning at 09:00 local time to summarize overnight pull request reviews, failed test suites, or pending work items.
- **Automated Health & Status Probes:** Asking coding agents to run integration test suites or dependency security scans every evening.
- **One-off Scheduled Operations:** Scheduling a database migration review or release verification prompt for a deployment window later in the week.

---

## Architecture & How It Works

### 1. Room-Scoped Persistence
Every schedule is anchored to a specific Switch room in PostgreSQL (`room_schedules` table):
- **Tenant & Room Isolation:** Enforces PostgreSQL Row-Level Security (RLS) matching Switch's tenant isolation model.
- **Foreign Keys:** References `rooms(id, tenant_id)` with `CASCADE` on delete, ensuring deleted rooms automatically clean up their schedules.

### 2. Concurrency-Safe Scheduler Daemon
The Switch backend engine runs `RoomScheduleRunner`, an asynchronous daemon that evaluates due tasks periodically:
- **Multi-Pod Concurrency:** Uses PostgreSQL `SELECT ... FOR UPDATE SKIP LOCKED` (`RoomScheduleStore.fetch_due_schedules`), ensuring only one server pod claims and executes any given schedule run.
- **Next Run Projection:** Immediately updates `next_run_at` upon claim using `ZoneInfo` timezone-aware calendar math, preventing duplicate dispatches even under heavy load.

### 3. Agent Presence & Dispatch
- **Delivery Protocol:** Messages are dispatched into the room's platform transport channel via Switch's `SystemActor.send_platform_message()`, sent on behalf of the schedule creator (`on_behalf_of=OnBehalfOf(user.id, user.name)`).
- **Agent Targeting:** The schedule can specify target agents. When delivered, active room agents are tagged (`@{agent.name}`), triggering agent context loading and execution. If target agents have left the room, an informational admin notice is sent to the channel.

### 4. Missed Run Handling
If a server is stopped, offline, or undergoing maintenance when a schedule was due:
- `run_once` (default): Fires one execution upon server restart, then recalculates future occurrences from the current time.
- `skip`: Skips overdue runs if delayed past the late threshold (default 15 minutes), directly projecting `next_run_at` into the future.

---

## Authorization & Permissions

Access control adheres to Switch's standard room management policy:
- **Read Access (`GET /rooms/{id}/schedules`):** Any user with access to view the room can view its configured schedules.
- **Manage Access (`POST`, `PATCH`, `DELETE`, `/pause`, `/resume`):** Restricted to the **room owner** or **tenant administrators** via `require_manage(Principal, room.owner_id)`.

---

## REST API Reference

All schedule endpoints are mounted under the Gateway `/rooms/{room_id}/schedules` path:

### List Room Schedules
```http
GET /rooms/{room_id}/schedules
```
Returns an array of schedule objects for the room.

### Create Schedule
```http
POST /rooms/{room_id}/schedules
Content-Type: application/json

{
  "name": "Daily Standup Prompt",
  "schedule_type": "recurring",
  "cron_expr": "0 9 * * 1-5",
  "timezone": "America/New_York",
  "message": "Please post your progress on open issues.",
  "target_agent_ids": ["018d-agent-id-1", "018d-agent-id-2"],
  "missed_run_policy": "run_once"
}
```

For one-off deliveries:
```http
POST /rooms/{room_id}/schedules
Content-Type: application/json

{
  "name": "Release Verification",
  "schedule_type": "one_off",
  "run_at": "2026-11-06T18:00:00Z",
  "message": "Run release sanity checks on staging."
}
```

### Pause / Resume Schedule
```http
POST /rooms/{room_id}/schedules/{schedule_id}/pause
POST /rooms/{room_id}/schedules/{schedule_id}/resume
```
Pausing freezes execution without modifying the underlying cron or configuration. Resuming recalculates `next_run_at` from the current time.

### Update Schedule
```http
PATCH /rooms/{room_id}/schedules/{schedule_id}
Content-Type: application/json

{
  "cron_expr": "30 9 * * 1-5",
  "message": "Updated prompt message"
}
```

### Delete Schedule
```http
DELETE /rooms/{room_id}/schedules/{schedule_id}
```
Permanently removes the schedule.

---

## Console UI

Room schedules can be managed directly in Switch Console Desktop:
1. Navigate to a room's settings by clicking the room settings cog or header.
2. In the **Room Configuration Panel**, find the **Scheduled Messages** section.
3. Click **New schedule** to configure:
   - Name and description.
   - Frequency: Recurring (via interactive `CronPicker`) or One-off (Date & Time).
   - Timezone (defaults to your browser timezone).
   - Target agents (multi-select picker filtered to current room participants).
   - Prompt message.
4. Manage existing schedules with quick Pause, Resume, Edit, and Delete actions.
