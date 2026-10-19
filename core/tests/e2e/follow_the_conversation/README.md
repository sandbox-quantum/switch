# End-to-end proof: follow the conversation

This plays every journey of the "follow the conversation" feature in a real
local Mattermost, against switch-core built from this checkout, and checks
each one. It complements the automated tests in
`core/tests/switch_core/delivery/`, which run on every PR. This run needs
Docker, Mattermost and Chrome, so it isn't part of the PR checks. Run it
before a release, or after changing how messages reach agents.

```bash
just init-env              # once, if you have no .env
just down                  # stop your local stack: this run uses the same ports
just e2e-follow-ups        # about 3 minutes
just e2e-follow-ups --video  # also records a captioned demo (needs ffmpeg)
just e2e-follow-ups --keep   # leave it running afterwards to try by hand
```

It exits non-zero if any journey fails. Output goes to
`build/e2e/follow-the-conversation/`:

| File | What it is |
|---|---|
| `report.md` | Every journey: who sent what, who it should reach, who it did, and the server's log line for each message |
| `screens/` | Mattermost screenshots of each room and thread |
| `follow-the-conversation-demo.mp4` | With `--video`: one captioned video of every journey |
| `switch-core.log`, `agents.log` | The server's and the test agents' logs |

## How it works

1. `run.sh` starts its own Postgres and Mattermost (Compose project
   `switch-e2e`, removed afterwards), applies migrations, and starts
   switch-core with the `follow_the_conversation` flag on. The follow-up window
   is set to 20 seconds so the "too late" journey doesn't take 5 minutes.
2. `harness.py setup` registers three test agents:
   - `helper` and `reviewer`, which anyone may instruct
   - `private-bot`, which only its owner may instruct

   It also adds a second Mattermost person, `bob`, and creates the rooms.
3. `harness.py agents` runs the agents. Each opens its event stream and
   receives every message with Switch's own answer to "is this for you?".
   When the answer is yes, the agent replies, and the reply says which rule
   delivered the message.
4. `harness.py run` plays each journey as `user` and `bob`, then checks
   Switch's answer for every agent against the expected one. It collects the
   server's `Follow the conversation:` log line for each message, and writes
   the report.
5. `screenshots.py` and `video.py` drive headless Chrome over the DevTools
   protocol, signed in as `user`.

The journeys mirror `test_conversation_journeys.py`. When you add a rule or a
command, add a journey to both.
