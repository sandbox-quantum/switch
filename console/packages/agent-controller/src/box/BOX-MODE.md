# Box mode

Hosted agents v2 runs each person's agents in a box on a shared cluster. A box runs this package, the same
controller Switch Console and v1 cloud machines run, in **box mode**. Box mode changes nothing anywhere else:
desktop and v1 run upstream's code paths exactly as they were.

## How it turns on

- The box image carries a marker, `/etc/switch/box`, root-owned and read-only on a read-only root filesystem.
- The controller runs in box mode only with `--box` on its command line **and** the marker. Either without the
  other refuses to start, for every command (`resolveControllerBoxMode` in agent-providers' `box-mode.ts`). The box
  entrypoint passes `--box` to `enroll`, `status` and `run`.
- Inside the controller, box mode is a value passed down (`ControllerDeps.box`), never a global or an environment
  variable. The agent host takes it from the marker once, in `shared-daemon`, and passes `{ box }` down to its
  hosts; a host config that says box without the marker refuses to start.

## Where box code lives

- `agent-controller/src/box/`: the controller's box-only modules (live status, rest and wake, the split box's
  launcher, the provider gateway, sealed and given logins, owner markers, the box valve's hub side, and
  `controller-box.ts`, which `runController` calls at fixed points).
- `agent-providers/src/host/box/`: the agent host's box-only modules, exported as the package's `./box` subpath
  (`dist/box.mjs`), never from its main index.
- Box-only code is reached only through a dynamic `import()` inside a box-mode branch. The bundles are single files,
  so it ships inside Switch Console's and the controller release's bundles, but never runs there:
  `scripts/box-bundle.mjs` fails those builds if anything outside a `box/` folder imports it other than dynamically,
  and a test runs the desktop bundles with every box module made to throw if its code runs. The box image's build
  (`deploy/hosted/box/image/build.sh`) refuses a package without the box modules.
- A box module only defines things at import; nothing registers or starts at its top level.

## What a box does differently

Each item below is gated on box mode, with a test for box on and one showing box off is unchanged.

- In rooms: a message a session can't start for is kept and retried, and the room told; people waiting on a deleted
  session are told; "I was restarted while working on this" is posted once after a crash, upgrade or provider exit
  mid-turn; a cut-off conversation starts again on its own; a room post made while Switch is briefly away is held
  and sent again for up to 10 minutes; resets of resting or starting sessions say what happened.
- Behind the scenes: journals are compacted; stale lock files are judged by process start time, and nothing is
  killed on a guess; log lines carry timestamps; status reports each session as active, waking or parked, with
  memory figures; a login change waits for a mid-turn session; a restarted agent host gets the room events it
  missed; a reset the agent can't take is told to the room; login-check copies left by a stopped check are cleared
  at start, and a check that runs too long is ended with its whole process group; leftover folders of removed
  agents are deleted after two checks; controller and agent host messages are capped at 1 MiB; a recorded process
  id that answers EPERM counts as alive; no device id is sent.
- Only the providers the box image carries are offered: Claude Code, Codex, OpenCode, Cursor and Antigravity
  (`providersFor` in `providers.ts`). Every other provider stays registered, for desktop and v1.
- A browser sign-in (`provider.login` with `method: "browser"`) runs only for Claude Code and Codex
  (`BOX_BROWSER_SIGN_IN` in `gateway-logins.ts`): the setup token or ChatGPT sign-in it ends with is kept sealed and
  goes through the provider gateway like a pasted one. The others are refused, as the gateway fronts none of their
  sign-ins.
- A Codex ChatGPT sign-in (browser or a pasted sign-in file) is held by the gateway (`chatgpt-tokens.ts`), which
  renews the access token before it expires and once when the backend refuses it, one refresh at a time for every
  agent, and keeps each rotation with Switch, sealed again, in place of the revision it came from. Codex reads its
  base URL from configuration only, so a gateway-backed Codex login reaches its sessions as a `switch_gateway`
  provider in their configuration plus the agent's token in `OPENAI_API_KEY`; a split box's sign-in check of it is
  answered by the gateway, as Codex's own check can't carry that configuration.
- Updates come only from rolling the box image, which is pinned by digest: a box runs `--updated-by-console`, and
  Switch sends such a controller no release.

## Known risks

- Posts held while Switch is away rely on Switch honouring the post's resend key (`X-Switch-Client-Txn-Id`). Every
  Switch that runs hosted agents v2 does.
- Each provider's own variables in the controller's environment reach every agent (`PROVIDER_ENV_VARS`), so a box
  controller's environment must hold only what is meant for its agents.
- A Codex ChatGPT sign-in needs the gateway's way out to reach `chatgpt.com` and `auth.openai.com`. The hosted
  egress lists' `ai-providers` part names both, with the other hosts the gateway calls, and a split box gives that
  part to the controller's login only. Lists made anywhere else must name them for the controller's login too.
  Vertex AI's regional hosts (`<region>-aiplatform.googleapis.com`) are not in that part: only its global host is.
