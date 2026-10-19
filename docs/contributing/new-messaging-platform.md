# Adding support for a new messaging platform

This page is the short version: what to do, in order, and what your pull
request has to show. The technical details are in
[Add a messaging platform](add-a-messaging-platform.md).

## Before you start

- **Find out how the platform delivers messages.** Either Switch connects to
  it and is handed messages on that connection (a socket, long polling), or the
  platform calls a web address for every message (a webhook). Both work; the
  webhook kind also needs Switch reachable from the internet over https, and
  for testing a tunnel such as ngrok is enough.
- **Have a test account on the platform** where you can create a bot or app
  and add it to a chat. You'll need it to test.
- **Make it work on several pods.** switch-core can run as several pods; read
  [Works on several pods](add-a-messaging-platform.md#works-on-several-pods)
  before you write the adapter.

## 1. Write the code

Follow [Add a messaging platform](add-a-messaging-platform.md). You add:

- a folder with the adapter, its connection settings and its logo;
- one line in `core/switch_core/bridges/collaboration/platforms.py`;
- a docs page, `docs/messaging-platforms/<key>.md`.

You shouldn't need to change anything else: Switch Console, telemetry and the
server learn the platform's name, logo and abilities from your adapter. If you
do change something else, say why in your pull request.

## 2. Run the automatic tests

From the repository root:

```bash
just check && just typecheck
uv run --project core pytest core/tests/switch_core/bridges/collaboration/test_<your-platform>_*.py
```

Your tests mock the platform, so they're quick and free. The whole suite also
runs on your pull request. Copy the summary your tests print at the end; you'll
paste it into your pull request.

## 3. Try it for real

The tests can't talk to the real platform. So run Switch from your branch
(`just up`, then `just run`; see [CONTRIBUTING](../../CONTRIBUTING.md#development-setup)),
point Switch Console at it, connect your platform with your test account, and
record your screen while you do this:

1. Open **Connect a messaging app** and show your platform in the list with its
   own name and logo.
2. Fill in its connect form and connect it.
3. Webhook platforms only: copy the address shown once it's connected, and
   paste it into the platform's settings.
4. Create a room on it, or add the bot to a chat, and have an agent post a
   message. Show it arriving on the platform.
5. Send a message on the platform and show it reaching the room, with the agent
   replying.
6. Get the agent to ask for approval (for example, to run a shell command),
   answer the card on the platform, and show Switch recording that it was
   answered from your platform.

Keep the video short; a couple of minutes is plenty. If the platform can't do
one of these (say, it has no buttons for approval cards), show what happens
instead and say so in the pull request.

## 4. Open the pull request

The pull request template's **Adding or changing a messaging platform**
section asks for:

- **the adapter test summary** from step 2;
- **the video** from step 3;
- three checks: nothing changed outside your platform's folder, its line and
  its docs page; what the platform can't do is declared; the docs page is
  written.

Fill in all of it. We review a new platform from those, so a pull request
without them waits.
