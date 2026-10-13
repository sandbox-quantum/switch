## What this changes

<!-- One or two sentences: what changes for someone using Switch, and why. -->

## How it was tested

<!-- What you ran or tried, and what you saw. -->

---

## Adding or changing an agent CLI

<!--
Only for a pull request that adds support for an agent CLI or changes one.
Otherwise delete this section. How to do each step:
console/docs/new-agent-cli.md
-->

**CLI and version:**

**Real-CLI test summary** (paste what
`pnpm exec vitest run src/<your-cli>/<your-cli>.integration.test.ts` prints at the end):

```
paste here
```

**Video** (link or attachment). It shows:

- [ ] the CLI marked as signed in, in Switch Console
- [ ] creating an agent with it and picking a model
- [ ] the agent replying in a room
- [ ] a shell command asking for permission first

---

## Adding or changing a messaging platform

<!--
Only for a pull request that adds support for a messaging platform or changes
one. Otherwise delete this section. How to do each step:
docs/contributing/new-messaging-platform.md
-->

**Platform:**

**How it connects:** <!-- dials out (Switch connects to the platform) / webhooks (the platform calls Switch) -->

**Adapter test summary** (paste what
`uv run --project core pytest core/tests/switch_core/bridges/collaboration/test_<your-platform>_*.py` prints at the end):

```
paste here
```

**Video** (link or attachment). It shows:

- [ ] the platform in Switch Console's "Connect a messaging app" list, with its own name and icon
- [ ] filling in its connect form and connecting it
- [ ] webhook platforms only: the address from the "connected" step pasted into the platform
- [ ] an agent's message reaching the platform
- [ ] a message sent on the platform reaching the room, and the agent replying
- [ ] an approval card answered from the platform, and Switch showing it was answered from your platform

**Checks:**

- [ ] Nothing changed outside the platform's adapter folder, its line in `platforms.py` and its docs page (or the PR says why)
- [ ] What the platform can't do is declared on the adapter (channel creation, user search, …)
- [ ] The docs page `docs/messaging-platforms/<key>.md` is written
