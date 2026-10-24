# Engineering wiki

Working notes for scoped changes: requirements, acceptance criteria, design,
conventions and decisions. Code is authoritative where this page and the code
disagree.

## Codex keyring login in isolated session homes (issue #1048)

### Problem

Each Codex session runs with its own `CODEX_HOME` under the agent's
`provider-home/` directory (`prepareCodexSessionHome`,
`console/packages/agent-providers/src/codex/home.ts`). Preparation copies the
execution machine's `config.toml` and `auth.json`. When the machine's login is
stored in the OS keyring (`cli_auth_credentials_store = "keyring"`, or `auto`
resolving to the keyring) there is no `auth.json`, and Codex keys keyring
entries by `CODEX_HOME`, so the session home has no login. `account/read`
returns `account: null` with `requiresOpenaiAuth: true`, and the session failed
with "Sign in on the execution machine with codex login." although the user is
signed in.

### Scope (current PRD)

Improve the diagnosis only, which the issue lists as the minimum acceptable
outcome. Keyring logins remain unusable in isolated session homes.

In scope:
- The existing missing-required-login error in the Codex adapter explains the
  possible keyring cause, the isolated-home limitation and an optional
  workaround.

Out of scope:
- Copying or bridging keyring credentials into session homes.
- Reading session or source config to detect the credential store.
- Readiness-check changes, new protocol probes, platform or version gates.

### Acceptance criteria

1. Only `account === null && requiresOpenaiAuth === true` changes; the session
   still fails before `thread/start`, and failed-start cleanup is unchanged.
2. The message keeps the `codex login` instruction, states conditionally that a
   keyring (or `auto`→keyring) login may be unavailable to the isolated session,
   and gives the optional workaround: if credential policy permits, set
   `cli_auth_credentials_store = "file"` in the execution machine's Codex
   config, sign in again with the same login method and `CODEX_HOME`, then start
   a new Switch session. It discloses that file storage keeps credentials in
   plaintext `auth.json`.
3. The message is static: no paths, config, environment or credential values.
4. A recognized account (API key or ChatGPT) starts even when
   `requiresOpenaiAuth` is true; a null account starts when
   `requiresOpenaiAuth` is false.
5. No additional I/O or protocol calls on any path.

### Design

`CODEX_SIGN_IN_REQUIRED` in `codex/codex-adapter.ts` holds the message; the
existing `account/read` check throws it. Covered by fake app-server tests in
`codex/codex-adapter.test.ts` (message content, request sequence ending at
`account/read`, process disposal, no session left registered, secret-marker
exclusion, recognized-account and auth-free success).

### Conventions

- Error text that may reach a room is static and never interpolates config,
  paths or credentials.
- Keyring behaviour is described conditionally: copied config does not
  establish the effective (possibly enforced) credential policy.

### ADR-001: Diagnose, do not bridge, keyring logins (Accepted, 2026-10-24)

Context: Codex 0.164.0 stores keyring logins under service `Codex Auth` with an
account derived from the canonical `CODEX_HOME`
([storage.rs](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/login/src/auth/storage.rs)).
An isolated session home therefore has no entry. Its effective store can also
be set by enforced requirements
([config loader](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/loader/mod.rs)).

Options:
1. Share the source `CODEX_HOME` with sessions — rejected; loses config and
   rollout isolation.
2. Export keyring credentials to a session `auth.json` — rejected; silently
   changes the user's storage policy to plaintext.
3. Seed a per-session keyring entry from the source entry — deferred. On macOS,
   entries written with the `security` tool prompt for Keychain consent when
   Codex reads them, and the source entry cannot be read without a prompt, so
   the tested approach is not usable unattended. It would also need effective
   policy resolution and keyring cleanup on session deletion.
4. Explain the limitation in the existing error — chosen.

Decision: option 4.

Consequences: users with keyring storage get an accurate explanation and an
optional workaround instead of a misleading instruction; keyring support
remains a follow-up.

### Decision history

- 2026-10-24 — Bridge options evaluated against Codex 0.164.0 source; a
  disposable-entry test on macOS with placeholder credentials showed the
  `security`-seeded entry approach prompts for Keychain consent. Scope set to
  the diagnostic (ADR-001).
