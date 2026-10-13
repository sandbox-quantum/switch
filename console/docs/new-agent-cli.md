# Adding support for a new agent CLI

This page is the short version: what to do, in order, and what your pull
request has to show. The technical details are in
[Add an agent provider](add-an-agent-provider.md).

## Before you start

- **Check the CLI speaks ACP** (the [Agent Client Protocol](https://agentclientprotocol.com)).
  Most do: look for an `acp` command or an ACP mode in its docs. If it does,
  you write a small file describing the CLI and reuse everything else. If it
  doesn't, the work is much bigger; ask first.
- **Have the CLI installed and logged in on your computer**, with an account
  that can make model calls. You'll need it to test.

## 1. Write the code

Follow [Add an agent provider](add-an-agent-provider.md). For an ACP CLI you
add:

- a file that says how to start the CLI and what's special about it;
- a plugin with its name, icon and how to install it;
- one line in each of two lists, and one line on the server.

You shouldn't need to change anything else. If you do, say why in your pull
request.

## 2. Run the automatic tests

From `console/`:

```bash
pnpm -r --filter './packages/**' run build
pnpm -r run typecheck && pnpm -r run lint && pnpm -r run test
```

These use a fake CLI, so they're quick and free. They also run on your pull
request.

## 3. Test with the real CLI

The automatic tests can't run your CLI for real: that needs your account and
spends real model calls. So you run this check yourself, once:

```bash
cd console/packages/agent-providers
pnpm exec vitest run src/<your-cli>/<your-cli>.integration.test.ts
```

It runs 10 checks against the real CLI: a simple reply, writing a file,
asking for permission, stopping a turn, remembering a conversation, and so
on. Copy the summary it prints at the end. You'll paste it into your pull
request.

If a check can't pass because the CLI really can't do that thing, mark it as
skipped in the test file with the reason. Don't leave it failing.

## 4. Try it in Switch Console

Run Switch Console from your branch and record your screen while you do this:

1. Open the agent setup and show your CLI marked as **signed in**.
2. Create an agent with it and pick a model.
3. Talk to the agent in a room and get a reply.
4. Ask it to run a shell command, and show that it asks your permission first.

Keep the video short; a couple of minutes is plenty.

## 5. Open the pull request

The pull request template asks for two things:

- **the real-CLI test summary** from step 3;
- **the video** from step 4.

Fill in both. We review a new CLI from those two things, so a pull request
without them waits.
