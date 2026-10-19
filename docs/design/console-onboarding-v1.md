# Console onboarding and switch-buddy — design v1

Status: draft for review, revision 2. Nothing here is built yet.

## Goal

Take someone from a fresh Switch Console install to chatting with an agent
that helps them with everything else (**switch-buddy**) in as few steps as
possible.

## Scope

This document covers one PR: the flow from the welcome page to chatting with
the buddy.

In:

- New first-run pages: welcome, how to run Switch, sign in, workspace, meet
  switch-buddy, AI provider.
- switch-buddy: a **managed agent** running on the user's own computer, one
  per person per workspace, on every server type.
- A provider step that relies on what this computer's agent controller reports
  (installed / signed in), with install and sign-in actions the controller
  actually picks up.
- Templates able to give an agent "can manage agents".
- Opening on the buddy's private chat in the new chat interface, with a
  "Connect your AI provider" button in place of the message box when no
  provider is ready.

Deferred to later PRs:

- Separate Google / GitHub buttons that open the system browser. The sign-in
  page keeps today's sign-in options in the new layout.
- In-app links the buddy can send (`switchdash://…` routes beyond sessions).
- New agent tools for the buddy (connect Slack/Discord, invite people,
  guardrails…).
- "On a remote host" in onboarding. It stays available from the app's
  add-server dialog.
- "Continue with email", and pasting an invite link on the first page.
- API-key sign-in for providers on this computer (see section 8).

## Feature flag

There is one flag: the existing build flag `BUILD_FEATURE_FLAGS.onboarding`
(on in dev and canary, off in stable). It is console-only. The new flow
**replaces** the current first-run pages behind that flag, so the old pages
are removed and there is no second flag.

The flow's last step needs the server's `agent_chats` flag. If a server has
it off, the flow ends on the buddy's agent page instead, with a visible
notice. It does not pretend the chat is there.

## The flow

```
Welcome
  └─ How do you want to run Switch?
       ├─ Switch Cloud ─────────────────────────────────┐
       │                                                ▼
       ├─ Join an existing server ─ server address ─▶ Sign in
       │                                                │
       └─ On this computer ─ Docker check ─ start ──┐   │
          (signed in automatically, no sign-in page)│   │
                                                    ▼   ▼
                                     Choose or create a workspace
                                                    │
                          [this computer starts running agents for it]
                                                    ▼
                                           Meet switch-buddy
               ┌───────────────────────────────┼──────────────────────────┐
     Start with <provider>               Set up a provider               Skip
     (one per provider already                 │                          │
      installed and signed in)                 ▼                          │
               │                     Pick provider → install / sign in    │
               │                               │                          │
               ▼                               ▼                          ▼
        [buddy created]                 [buddy created]           Buddy chat with
               ▼                               ▼                  "Connect your AI
        Buddy chat, normal message box  Buddy chat, normal        provider" instead of
                                        message box               the message box
```

Every path goes through the buddy: Switch Cloud, this computer and an
existing server.

### 1. Welcome

Graphic (to come from Max), headline "Your teams, your agents, all in the same
room", the three value statements, and **Get started**.

### 2. How do you want to run Switch?

One page: Switch Cloud as the large recommended card, then two smaller cards.

| Option | What happens next (reuses today's steps) |
| --- | --- |
| Switch Cloud | Registers the Cloud server, then sign-in. "Already have a Switch Cloud account →" goes to the same sign-in page. |
| On this computer | Checks Docker, starts the local stack, signs in automatically (Console holds the admin password). No sign-in page. |
| Join an existing server | Server address form, then sign-in. |

"On a remote host" is left out of onboarding because it needs an SSH host set
up first. It remains in the add-server dialog after onboarding.

### 3. Sign in

The new layout, with the options the server offers today: its SSO button
(WorkOS on Switch Cloud) in the current in-app window, and the password form
where the server allows it. "← Change how you run Switch" goes back.

Separate Google / GitHub buttons in the system browser are deferred (needs a
WorkOS change and a browser-to-app handoff).

### 4. Workspace

This exists today (pick, create, invitations, joinable domains). New layout:

| Situation | Page |
| --- | --- |
| No workspaces, no invitations | "Create your workspace": name field. |
| One workspace, nothing else | Skipped, as today. |
| Own workspace(s) and invitations | List. Invitations are tagged **Invited**; choosing one accepts it. |
| Only invitations | List, plus "Create your own workspace" below. |

Joining someone else's workspace for the first time also leads to the buddy:
everyone gets their own.

### 5. This computer starts running agents (no page of its own)

As soon as a workspace is chosen, Console turns on its built-in agent
controller for that workspace. This is the same mechanism as "run managed
agents on this computer" in the New Agent dialog, and it happens on every
server type, because the buddy always runs on the user's computer.

The controller runs as the user with their normal home folder and shell
`PATH`, so it sees the CLIs installed on the machine and their sign-ins. It
reports to the server which providers are installed and signed in. That
report is what the server checks before it will create a managed agent, so
the onboarding uses **only that report**, not Console's separate install
check.

Startup runs in the background while the user reads the next page.

### 6. Meet switch-buddy

Intro page with the buddy's avatar and the short scripted lines. Its buttons
depend on the controller's report:

- **Start with Claude Code** / **Start with Codex** / … (one button per
  provider that is already installed and signed in; the first is the primary
  button). Creates the buddy straight away (section 9) and opens the chat.
- **Set up a provider**: always offered (the main button when nothing is
  ready). Goes to section 7.
- **Skip**: opens the chat without a buddy agent yet (section 9).

While the report is still loading, the page shows the setup and skip buttons,
and the "Start with…" buttons appear when the report arrives.

### 7. Pick and prepare a provider

Five cards: Claude Code, Codex, OpenCode, Cursor, Antigravity, tagged from
the controller's report:

| Report | Tag | Action |
| --- | --- | --- |
| Installed, signed in | "Signed in" | Continue: creates the buddy with it. |
| Installed, not signed in | "Sign in" | Runs the provider's sign-in (section 8). |
| Not installed | "Install" | Runs the existing installer, then sign-in if needed. |
| Report not in yet | Spinner | — |

### 8. Install and sign-in, and making sure the controller sees them

Today, installing a CLI or signing in from Console is **not connected** to the
controller:

- The controller works out its `PATH` once when it starts. A CLI installed
  afterwards in a folder that was not on that `PATH` (for example
  `~/.local/bin`, used by the Claude and OpenCode installers on some systems)
  is never found until the controller restarts.
- The controller caches provider status for 10 minutes. Console never asks it
  to check again: Console's "Recheck" button only re-runs Console's own
  check, which can disagree with the controller.
- Console never runs a provider's sign-in command. It only shows it as text to
  copy.
- "Give this machine a login" (API key, or a login taken from elsewhere)
  cannot work for this computer's controller: by design it has no key to
  decrypt a login with. On this computer, the only sign-in is the provider's
  own local sign-in.

This PR changes:

1. **Check again on demand.** Console can tell its embedded controller to
   re-check providers now and send a fresh report. The controller already has
   this check (it runs it for the server's `provider.recheck` operation).
   Console triggers it over the channel it already has with the controller
   process. The controller then reports to the server as usual, and Console
   waits for that report before moving on.
2. **Fresh `PATH` on every check.** When the controller re-checks, it reads the
   login shell's `PATH` again and adds the install folders Console's
   installers use (such as `~/.local/bin`), so a CLI installed a minute ago is
   found without a restart.
3. **Run the sign-in for the user.** Console runs the provider's own sign-in
   command (`claude auth login`, `codex login`, `opencode auth login`,
   `agent login`, `antigravity-acp --login`) in a visible terminal panel
   inside onboarding. Most of these open the provider's page in the default
   browser. When the command exits, Console asks the controller to re-check.
4. **One source of truth.** The provider step, the "Start with…" buttons and
   the chat's connect button all read the controller's report. Console's own
   install check is only used to show install progress.

The board's Connect Codex page becomes:

- **Use the account signed in here**: when the controller reports it signed
  in. Nothing is uploaded; the buddy runs on this computer with that sign-in.
- **Sign in with a different account**: runs the provider's sign-in command.
- API key: deferred (it would need the controller to keep a key for given
  logins, or the key passed to the CLI's own sign-in).

### 9. Creating switch-buddy

The buddy comes from a new **built-in template**, `switch-buddy`, based on
today's Switch expert template and served alongside it.

1. **Name**: `switch-buddy-<username>`, where the username comes from the
   signed-in account, lower-cased and sluggified. Agent names are unique per
   workspace, so if the name is taken a number is added
   (`switch-buddy-max-2`). The display name is "switch-buddy".
2. **Managed agent** on this computer's controller, with the chosen provider,
   its default model, the buddy instructions, a working folder Switch picks,
   and `desired_state: running`. The server refuses to place an agent until
   its provider is installed and signed in, which is why the buddy is only
   created once a provider is ready.
3. **Can manage agents**: set by the template. Templates gain a
   `can_manage_agents: true` option on agent resources, applied when the run
   creates the agent. Who may set it stays the same as today: only the agent's
   owner, and the person running the template is the owner of every agent it
   creates. An agent running a template can only give the permission if it
   has it itself.
4. **Who can talk to it**: owner only.
5. **Its chat**: a private direct chat between the user and the buddy, so
   every message reaches it without an @-mention.
6. **First message**: the scripted welcome from the board, posted into that
   chat as fixed text, so it appears instantly. Until in-app links exist, the
   "my agent profile" mention is plain text pointing at the agent's Settings
   tab.
7. The chat warms up the buddy's session in the background so the first reply
   is fast.

If creation fails, the reason is shown in the chat with a retry button. The
flow does not carry on as if the buddy existed.

**On Skip (no provider yet):** the chat opens with the scripted welcome and a
**Connect your AI provider** button in place of the message box. No agent
exists yet. The button opens the provider step (section 7). Once a provider
is ready, the buddy is created as above and the message box appears.

Whether onboarding is finished is worked out from what exists (a server, a
workspace, a buddy), not stored as a flag. A relaunch before the buddy exists
reopens the chat in the same "connect" state.

### 10. The chat

This uses the new chat interface. The board's layout (agent page with Chats,
Connections and Settings tabs, a "Welcome" chat, and a "Bring switch-buddy to
Slack, Discord and more" card) matches it. Changes:

- The chat panel accepts a replacement for the message box, used for the
  "Connect your AI provider" button.
- The pre-agent state: a chat view for a buddy that does not exist yet,
  showing the scripted welcome.
- The "Bring switch-buddy to Slack, Discord and more" card opens the existing
  bridge setup.

## What the buddy can do in this PR

With "can manage agents", through the existing agent tools:

- Create agents on the user's machines and change them (provider, model,
  instructions…).
- Create, update and archive rooms; invite agents; add known users; links,
  groups, roles and aliases.
- Find, run and save templates.
- Create and attach references and room documents.
- Answer questions about Switch from the docs and knowledge base inherited
  from Switch expert.

Its instructions change from "explain how" to "offer to do it, then do it",
asking for confirmation before anything with side effects, the same rule the
Switch skill already sets.

## Later PRs (not in this one)

- **In-app links**: `switchdash://` routes for agent page, agent settings,
  templates, room, settings tab and bridge setup; open such links in the app
  from chat; list them in the buddy's instructions.
- **New agent tools**: invite people to the workspace, connect
  Slack/Discord, change guardrails, connect services, delete or stop agents.
- **Sign-in buttons**: Google / GitHub / SSO in the system browser, with a
  one-time code handed back to the app via `switchdash://`.
- **Remote host in onboarding.**
- **API key for providers on this computer.**

## Open questions

- Final copy for "Join an existing server" (the board says "xxx"), and the
  welcome graphic.
- Whether existing users get a buddy when they update, or only fresh installs.
