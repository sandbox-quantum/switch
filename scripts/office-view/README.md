# office-view

Demo tooling that mirrors one Switch room into a local
[W17ant/Claude-Office](https://github.com/W17ant/Claude-Office) (a pixel-art
office for AI agents) and records a side-by-side Slack and office video of a
real walk. Each agent in the room gets a desk under its own name, prompts show
as the boss shouting, subagents walk in as workers, pending approvals raise a
hand, and replies land in the office chat.

This is demo tooling only. Nothing here changes Switch.

The office runs from a pinned checkout (`v1.3.0`) with its own home directory.
It never installs Claude Code hooks, never touches `~/.claude` or
`~/.agent-office`, and its AI chat watcher is never started.

## Start the office

You need `git`, `node` (22 or later) and `npm`, plus `curl`, `jq`, `openssl`
and `lsof` (all stock on macOS apart from `jq` and `node`).

1. Note your Claude Code settings checksum, so you can show it is unchanged
   afterwards:

   ```bash
   shasum ~/.claude/settings.json
   ```

2. Start the office from the Switch repo root:

   ```bash
   scripts/office-view/office.sh start
   ```

   The first run clones W17ant/Claude-Office at tag `v1.3.0` into
   `~/.cache/switch-office-view/Claude-Office@v1.3.0`, then installs its
   dependencies and builds its UI there, which takes about a minute. It skips
   the Electron download, since only the server is used. Later runs start in
   about a second.

   The script then:
   - starts `node server/index.js` in the background, bound to `127.0.0.1`;
   - waits until the office answers its health check with its own token;
   - checks that `GET /config` reports version `1.3.0`. If it reports
     anything else, the script stops the server and exits, naming both
     versions;
   - turns on the quiet settings (below).

   It prints the URL, the token file and the log.

3. Open the office. The page needs the link that carries the office token in
   its fragment. Without the token the page is read-only and hides prompt
   text.

   ```bash
   open "$(scripts/office-view/office.sh url --token)"
   ```

   For a recording, load the page with `scripts/office-view/office_quiet.js`
   injected first (CDP `Page.addScriptToEvaluateOnNewDocument`, or
   Playwright's `add_init_script`). See "Quiet office" below for why.

   The office UI is a fixed frame about 1060 px wide. A narrower window cuts
   off its left and right edges.

4. Optional smoke test. This plays a 40-second scripted scene with two agents,
   Ada and Bob: desks, prompts, typing, a worker walking in and out, a hand
   going up and coming down, and replies.

   ```bash
   scripts/office-view/sample_events.sh --end
   ```

5. Check on it or stop it:

   ```bash
   scripts/office-view/office.sh status
   scripts/office-view/office.sh stop
   shasum ~/.claude/settings.json   # same as in step 1
   ```

   `stop` leaves no process behind. Everything the office writes stays in the
   demo dir.

### Settings and files

| Variable | Default | What it is |
|---|---|---|
| `OFFICE_PORT` | `3334` | Loopback port. It is passed to the office as `AGENT_OFFICE_PORT`. |
| `OFFICE_HOME` | `~/.cache/switch-office-view/home` | Demo dir: `office.pid`, `office.log`, and the office's own home in `.agent-office/` (`auth-token`, `chat.db`, `settings.json`). |
| `OFFICE_CACHE` | `~/.cache/switch-office-view` | Where the pinned checkout lives. |

The server runs with a clean environment:
- `HOME` and `AGENT_OFFICE_HOME` point into the demo dir.
- Its Claude Code session registry, task and team dirs point at empty dirs
  there. Without this, any Claude Code session running on your machine would
  show up as a desk.
- Desktop notifications go to a script that does nothing.

To start again from scratch, run `office.sh stop` and then delete
`$OFFICE_HOME`.

### Quiet office

`office.sh start` turns these on through the office's own settings
(`POST /settings`, using the office token):

| Setting | Value | Effect |
|---|---|---|
| `logPrompts` | `summary` | Prompt and reply text are kept to their first 200 characters. |
| `answerPermissions` | `false` | No Allow button that can answer anything. |
| `notifyPermissions` | `false` | No OS notification when a hand goes up. |
| chat monitor (`POST /chat/cron-state`) | `paused` | The office's AI chat replies stay off. Its watcher is never started anyway. |

Everything else that moves on its own lives in the page, not the server.
`office_quiet.js` handles it when injected before the page loads:

- **Random office events.** These include pizza, fire drills, power flickers,
  printer jams and fake deploy failures. The page fires one every 60 to 120
  seconds, and no setting turns them off. The script drops that one timer.
  It sets `window.__officeViewDroppedEvents` to 1 once it has.
- **Page preferences in `localStorage`:**
  - `agent-office-muted=1`
  - `agent-office-ambience=0` (no ambient office sound)
  - `agent-office-season=off` (no seasonal decorations)
  - `agent-office-daynight=day` (fixed daytime light)
  - `agent-office-theme=default`

Two bits of office colour remain:
- The boss posts a short line ("nice work", "ship it!") when a worker
  finishes.
- Agents sometimes walk to the coffee machine or water cooler.

Neither comes from the AI chat watcher.

## Follow a room

`adapter.py` signs in to the gateway as a Switch user and follows one room.
It reads the room's agent activity and its messages, and posts the matching
events to the office. Switch itself is only read, apart from `--join`.

```bash
export OFFICE_VIEW_PASSWORD='…'   # that user's Switch password
uv run --with httpx scripts/office-view/adapter.py \
    --gateway http://localhost:8000 --email you@example.com --room status-page --join
```

- **`--room`** takes the room's name or id. The user has to be a member of
  the room, because the activity stream only covers their own rooms. A room
  they can see but aren't in is refused, and the error names the room.
- **`--join`** adds the user to the room first, if they manage it (its
  owner, a room admin or a workspace admin). It's the same as joining from
  Switch Console.
- **`--record FILE`** appends every office event it sends, with its time, to
  a JSONL file. Useful for timing captions.
- **`--office`** and **`--office-token-file`** point at another office.
  The default is the one `office.sh` runs.

What the office shows:

| In Switch | In the office |
|---|---|
| An agent in the room | A desk with a name pill (opened for every agent at start) |
| A message to an agent | The boss shouts it; that agent gets a "!" (the `@` of any mention is dropped) |
| A tool call | The agent's Claude types, with what it is doing as a status line |
| A subagent | A worker walks in, sits down, and walks out when it is done |
| A pending approval | The agent's hand goes up; answering it in Switch lowers it. The office cannot answer it |
| The agent's reply in the room | A reply in the office chat, labelled `Claude · <agent>` |
| A test, build, deploy or push command | The office's signal for it (best effort) |

A few details:
- Replies are cut at 200 characters, and home paths are shortened.
- Switch's own "Starting a session…" notice is not shown as a reply.
- When the gateway restarts, or a stream drops or falls behind, the adapter
  reconnects and catches up from the room's current state. Nothing is
  duplicated.
- Ctrl-C makes every desk clock out.

Tests (no Switch or office needed; they replay frames recorded from a real
room):

```bash
uv run --with pytest --with httpx pytest scripts/office-view/tests
```

## Record and build the video

The video puts Slack on the left and the office on the right, above a
caption bar. Both are recorded with Chrome's screencast, one folder of
`<epoch_ms>.jpg` frames each.

1. **Slack.** Use a Chrome that is signed in to Slack and started with
   `--remote-debugging-port=9333`. Open the channel, and keep the window in
   front: a hidden window paints no frames.
2. **The office.** Use a headless Chrome of its own, so it paints even when
   nothing shows it on screen. Open the office there with the quiet script
   injected:

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
       --remote-debugging-port=9445 --user-data-dir=/tmp/office-view-chrome about:blank &
   uv run --with websockets scripts/office-view/windows.py --port 9445 open \
       "$(scripts/office-view/office.sh url --token)" --init-script scripts/office-view/office_quiet.js \
       --side right --size 1080x900
   ```

3. **Start a clean office and the adapter.** Run `office.sh stop`, then
   `office.sh reset`, then `office.sh start`, then the adapter as above.
4. **Record both:**

   ```bash
   uv run --with websockets scripts/office-view/rec.py --port 9445 --match 127.0.0.1:3334 \
       --out rec/office --every-nth 6 &
   uv run --with websockets scripts/office-view/rec.py --port 9333 --match app.slack.com \
       --out rec/slack --viewport 840x900 &
   ```

   Two options matter here:
   - `--viewport` lays Slack out at 840x900 for the recording, whatever its
     window's size.
   - `--every-nth 6` keeps the office, which repaints about 60 times a
     second, to about 10 fps. Otherwise it writes over 10 MB a second.

5. **Walk the conversation in Slack**, then stop both recorders.
6. **Write the captions**, one per line: `<time> TAB <caption> [TAB slack|office]`.
   The time can be `HH:MM:SS` on the recording's day, epoch ms or ISO. The
   adapter's `--record` file gives the exact moment of each prompt, worker,
   hand and reply.
7. **Build:**

   ```bash
   uv run --with pillow --with websockets scripts/office-view/build_video.py \
       --left rec/slack --right rec/office --marks marks.tsv \
       --start 16:01:05 --end 16:03:22 \
       --title "Switch × Claude Office — agents at work" --out office-view.mp4
   ```

   Rebuilding reads only the saved frames and captions, so you can change
   the captions and build again with nothing running. `--preview SECONDS`
   renders a single PNG to check the layout first. Quiet stretches are sped
   up and labelled as such.

Check the builder without a recording:

```bash
uv run --with pillow --with websockets python scripts/office-view/selftest_video.py
```
