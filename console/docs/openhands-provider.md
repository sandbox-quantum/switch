# OpenHands provider

Switch runs the local OpenHands CLI through native `openhands acp` over stdio.
Console and the headless controller use the same provider registration and ACP
session host. No OpenHands Cloud workspace is started.

## Setup on the execution machine

Install the CLI with [uv](https://docs.astral.sh/uv/getting-started/installation/):

```bash
uv tool install --python 3.12 openhands
openhands acp --help
```

Linux and macOS are supported. On Windows, run the controller inside WSL.
Configure OpenHands with `openhands login`, or run `openhands` and use `/settings`
for your own LLM provider.

The readiness check reads `~/.openhands/agent_settings.json` without starting
OpenHands, opening a browser or calling ACP `authenticate`. It reports whether a
saved model is configured; it cannot verify that a remote API credential is valid.
A cloud API token or an ambient vendor API key alone is not a saved local agent
configuration.

`OPENHANDS_PERSISTENCE_DIR` and `OPENHANDS_CONVERSATIONS_DIR` can select an existing
profile and its conversation store on the execution machine. Switch passes these
through its provider environment allowlist. It does not copy credentials or change
the user's saved settings.

## Model and permission behavior

Verified with OpenHands CLI 1.16.0:

- ACP does not advertise a model catalogue. Its `session/set_model` handler
  returns success without changing the model. Switch exposes the saved model
  as the available choice and rejects another selection. Configure a different
  model with `/settings`, then start a new session.
- The provider uses a small subclass solely to guard that model behavior;
  the shared ACP adapter handles all protocol, turn and permission operations.
  Its runtime factory selects the subclass.
- Native `always-ask` mode stays enabled. Explicit Switch full-access approval
  answers each request with `allow_once`; no `--always-approve` or `--llm-approve`
  flag bypasses Switch's decisions.
- OpenHands batches permission requests as kind `other`, without the originating
  MCP server. Switch therefore asks about these batches in approval-required,
  auto and edit-only modes, including room-context tools. It cannot safely infer
  that a batch contains only edits or trusted MCP calls.
- Native tools run with the execution user's filesystem permissions. Selecting a
  working directory is not an operating-system sandbox. Switch passes the
  resolved session directory to ACP and sets `OPENHANDS_WORK_DIR` consistently.
- Mid-turn messages queue; interruption uses `session/cancel`; process recovery
  loads the native session through `session/load`.
- Structured user-input requests are unsupported. Tool and assistant updates use
  the existing transcript and activity-card handling.

The upstream implementations are
[local authentication and workspace setup](https://github.com/OpenHands/OpenHands-CLI/blob/main/openhands_cli/acp_impl/agent/local_agent.py),
[model selection](https://github.com/OpenHands/OpenHands-CLI/blob/main/openhands_cli/acp_impl/agent/base_agent.py)
and [batched confirmations](https://github.com/OpenHands/OpenHands-CLI/blob/main/openhands_cli/acp_impl/confirmation.py).

## Verification

```bash
cd console/packages/agent-providers
pnpm exec vitest run src/openhands/openhands-acp.test.ts
pnpm exec vitest run src/openhands/openhands.integration.test.ts --reporter=verbose
```

The real-CLI tests include two account-free checks: the initialize handshake and
signed-out rejection, and a credential-free local session that verifies the
persisted model and working directory and loads after a process restart. They do
not make LLM calls. Their temporary profile has no tools or credentials.

The ten prompt conformance scenarios require a configured account and skip with
a setup reason when it is missing. Two scenarios have upstream limitations even
with an account: structured user input and automatically approving a registered
MCP server whose identity OpenHands omits. Other prompt scenarios, room replies,
chat approvals and the Console recording must be verified with a real account
before marking the provider PR ready for review.
