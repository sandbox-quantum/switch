# Box-only agent packages

`agent-controller-box`, `agent-providers-box` and `switch-agent-runtime-box` are the hosted agents (v2) versions of
upstream's `agent-controller`, `agent-providers` and `switch-agent-runtime`. Only the box image is built from them.
They are private workspace packages: nothing outside the three depends on them, and the public registry is never
asked for them.

Upstream's packages beside them stay byte for byte as upstream main `1a0d5002f`, so the desktop app and v1 cloud
machines run upstream's code whatever the hosted switch says. `switch-agent-runtime-box/src/upstream-packages.test.ts`
fails on any change to those four packages (`agent-controller`, `agent-providers`, `switch-agent-runtime`,
`shared`), and on any package outside the box ones depending on a box package.

The box copies are synced to upstream `1a0d5002f`, the same commit `upstream-packages.json` pins. Move the pin
only together with a port of upstream's changes into the box copies, never on its own.

## What the box versions change

What people see in rooms:

1. A session that can't start keeps the message: the room is told "I've kept your message…", the start is retried
   every 30 to 120 seconds, and after 10 minutes (or with 20 waiting) the room gets one "send it again" line.
   (`agent-host.ts`, `start-failure.ts`)
2. A deleted session tells the people still waiting on it, instead of dropping their messages silently.
   (`agent-host.ts`)
3. "I was restarted while working on this…" is posted once after a crash, upgrade or provider exit mid-turn, after
   checking the room so it's never posted twice. (`session-host.ts`, `restart-rounds.ts`)
4. A cut-off conversation starts again on its own, without waiting for the next message. (`agent-host.ts`)
5. A room post made while Switch is briefly unreachable is held and resent for up to 10 minutes; "lost" is said only
   if it never got through. (`watcher-tools.ts`, `held-replies.ts`, `hosted.ts`)
6. `!reset` on a resting session says it's done and goes back to rest. (`agent-host.ts`, `shared-host.ts`)
7. Resets wait up to about 35 seconds for a session still starting, and a reset that fails says so.
   (`agent-host.ts`, `room-control-followup.ts`)
8. A fresh conversation starts without the usual notice when the old one never had a message sent.
   (`session-host.ts`)

Behind the scenes:

9. The agent's journal is compacted at start and past 1,000 records. (`journal.ts`, `agent-host.ts`)
10. Stale lock files from before a reboot are replaced; nothing is ever killed on a guess. (`process-fence.ts`,
    `supervisor.ts`, `ownership-lock.ts`)
11. Log lines carry timestamps. (`log-stamp.ts`, `shared-daemon.ts`)
12. The health file, and the status sent to Core, report each session as active, waking or parked.
    (`watcher-tools.ts`, `status.ts`)
13. A login change waits up to 10 minutes for a mid-turn session before restarting the agent. (`reconcile.ts`)
14. A restarted agent host gets the room events it missed. (`agent-hub.ts`)
15. A reset the agent can't take is told to the room through Core, and skipped quietly on an older Core.
    (`agent-hub.ts`, `api.ts`)
16. Login-check copies are removed after each check and at start. (`runtime.ts`, `systemd-runtime.ts`)
17. The provider sign-in check is killed as a process group on timeout. (`runtime.ts`)
18. A one-time owner-marker key file is written in the controller's data folder. (`owner-marker.ts`)
19. Status adds memory figures, and is sent sooner when a session wakes or parks. (`status.ts`, `controller.ts`)
20. Leftover folders of removed agents are deleted after two checks 10 minutes apart. (`reconcile.ts`)
21. Messages between controller and agent host are capped at 1 MiB. (`hub-socket.ts`)

Where the box keeps its own rule over upstream's:

22. A recorded process id that answers EPERM is neither alive nor gone (`process-alive.ts`). Upstream reads it as
    gone, but on a box the controller and the agents run as different users, so a live agent host answers EPERM too.
    Listing sessions counts it as alive, as before. (`process-alive.ts`, `session-list.ts`)

Plus the box features themselves: the split box (launcher, credential gateway, sealed logins), the box valve and
memory guard, resting and parking, the live status file, and the sign-in-after-wake and control-port fixes.

## Known risks

- Item 5 relies on Core honouring the post's resend id (`X-Switch-Client-Txn-Id`). This branch's Core does; upstream's
  doesn't, so a box talking to an upstream Core could post a reply twice when an answer is lost. Boxes only run
  against the team's Core.
- After items 1, 3 and 9 have written their new journal records, an upstream build can't read those journals, so a
  box can't be rolled back to upstream's packages without clearing them.
- Upstream fixes to the four upstream packages reach these copies only when they are synced by hand. Each rebase
  lists upstream's changes to those packages since the last sync. The last sync took upstream from `0f7f96732` to
  `1a0d5002f`.
- Some box files had been copied from upstream earlier than the recorded base (the controller's relay and stream from
  30 October, Claude's result mapping from 2 November), so the last sync took them from those points instead.
