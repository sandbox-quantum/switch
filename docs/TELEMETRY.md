# Switch Console telemetry — what we collect, where it goes, and why it cannot be traced to a person

**Audience:** InfoSec.
**Scope:** the Switch Console desktop app. Switch server-side logging is out of
scope and needs its own pass.
**Claim:** the data we transmit is anonymous. No field identifies a person, and
no combination of the fields we transmit can be resolved back to one.

Sections 1–6 describe the Console as it is today, verified against the source.
Section 7 describes the relay, which lives in a separate repository.

---

## 1. What Switch is, in two lines

Switch runs AI coding agents (Claude Code, Codex, …) and connects them to chat
channels like Slack and Mattermost so people and agents work in shared rooms.
**Switch Console** is the desktop app used to drive it: create agents, start
sessions, connect to a server, set up rooms and bridges.

Telemetry here is product-usage analytics from that desktop app — *how the app is
used*, never *what is done with it*.

---

## 2. A real event, in full

This is the complete wire payload for one event — nothing is omitted or
abbreviated:

```json
{
  "resource": {
    "service.name": "switch-console",
    "service.version": "0.9.14",
    "flint.client_id": "3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83",
    "os.type": "darwin",
    "os.version": "23.6.0"
  },
  "event.name": "session_started",
  "timeUnixNano": "1789572278158000000",
  "severityText": "INFO",
  "attributes": {
    "build": "stable",
    "agent_type": "claude",
    "location": "local",
    "outcome": "success",
    "failure_reason": "none",
    "entry_point": "command_palette",
    "start_source": "user",
    "has_initial_prompt": true,
    "connected_to_room": false
  }
}
```

Read it as: *an installation identified only by a random UUID, on macOS, started
a Claude session locally from the command palette; it had some initial prompt
text, and was not connected to a room.* Nothing in it says who, where, on what
machine, in what repository, or what the prompt said.

---

## 3. Every field we collect, with example values

### 3.1 Attached to every event

| Field | What it is | Example values |
|---|---|---|
| `service.name` | constant | `switch-console` |
| `service.version` | app version | `0.9.14`, `1.0.2` |
| `build` | release channel | `dev`, `canary`, `stable` |
| `os.type` | OS family | `darwin`, `windows`, `linux`, `other` |
| `os.version` | OS release string | `23.6.0`, `10.0.22631`, `6.1.0-53-cloud-amd64` |
| `flint.client_id` | random install UUID | `3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83` |
| `event.name` | the event | `session_started` |
| timestamp | event time | `1789572278158000000` |

That is the entire ambient set. No hostname, no username, no account, no machine
id, no IP field, no Switch identity.

### 3.2 Values shared across events

| Field | Complete set of possible values |
|---|---|
| `outcome` | `success`, `failure` (on `session_ended`: `normal`, `failed`) |
| `agent_type` | the AI provider, from a fixed registry: `claude`, `codex`, `gemini`, `cursor`, `copilot`, `opencode`, `grok`, `devin`, `qwen`, `droid`, `amp`, `goose`, `cline`, `continue`, `mistral`, `kiro`, `junie`, … and `unknown`. **Never an agent's name.** |
| `location` | `local`, `remote`, `unknown`. **Never a path, directory or project name.** |
| `server_kind` | `local`, `remote_managed`, `external`. **Never a server name or URL.** |
| `bridge_platform` | `slack`, `mattermost`, `discord`, `teams`, `telegram`, `other`, `unknown`. **Never a workspace or channel name.** |
| `entry_point` | `command_palette`, `sidebar`, `server_page`, `onboarding`, `agent_page`, `session_list`, `room_row`, `unknown` |
| `target` | `local`, `remote`, `unknown` |

### 3.3 Every event and its fields

**App lifecycle**

| Event | Fields, with example values |
|---|---|
| `app_launched` | *(no fields)* |
| `renderer_crashed` | *(no fields)* |
| `update_checked` | `trigger`: `user` / `startup` / `scheduled` · `result`: `available` / `up_to_date` / `failed` |
| `update_downloaded` | `outcome`: `success` / `failure` |
| `update_install_started` | `outcome`: `success` / `failure` |
| `telemetry_consent_changed` | `source`: `first_run` / `settings` |
| `setting_changed` | `setting_key`, one of exactly 15: `theme`, `notifications`, `terminal`, `defaultAgent`, `sessions`, `location`, `localLocation`, `openIn`, `interface`, `browser`, `browserPreview`, `changesViewMode`, `remote`, `onboarding`, `telemetry`. **The new value is never sent** — we learn that someone changed their theme, not to what. |
| `search_performed` | `status`: `ok` / `recents` / `query-too-short` / `failed` · `result_count`: `0`, `3`, `17`. **The query is never sent.** |

**Navigation and onboarding**

| Event | Fields, with example values |
|---|---|
| `view_opened` | `view_id`, one of exactly 10: `home`, `location`, `session`, `room`, `settings`, `server`, `serverAgents`, `serverRooms`, `remoteHosts`, `remoteHost` |
| `command_executed` | `command_id`, one of 28 known commands: `app.settings`, `app.newSession`, `app.addServer`, `app.toggleTheme`, `session.newTerminal`, `session.gitPush`, … · `invoked_by`: `palette` / `shortcut` |
| `deeplink_opened` | `resolved`: `true` / `false` · `cold_start`: `true` / `false`. **The URL is never sent.** |
| `onboarding_step_started` | `step_id`, one of exactly 4: `addServer`, `agentProviders`, `onboardAgents`, `createRoom` |
| `onboarding_checklist_dismissed` | *(no fields)* |
| `onboarding_completed` | *(no fields)* |
| `add_server_step` | `step`: `choose` / `local` / `remoteHost` / `external` / `signIn` / `linkAccounts` · `choice`: `none` / `local` / `remoteHost` / `external` |

**Agents and sessions**

| Event | Fields, with example values |
|---|---|
| `agent_created` | `agent_type`: `codex` · `location`: `remote` · `outcome`: `failure` · `failure_reason`: `none` / `unauthenticated` / `name_conflict` / `credentials_conflict` / `invalid_name` / `not_configured` / `agent_not_on_server` / `error` · `entry_point`: `sidebar` |
| `agent_removed` | `agent_type` · `location` · `delete_in_switch`: `true` · `trigger`: `user` / `server_teardown` · `outcome` · `failure_reason`: `none` / `not_linked_to_switch` / `gateway_unauthorized` / `gateway_http` / `gateway_network` / `error` |
| `agent_reset` | `agent_type` · `outcome` · `failure_reason`: `none` / `agent_not_found` / `not_remote` / `connect` / `error` |
| `agent_cli_action` | `agent_type` · `target`: `local` / `remote` · `install_method`: `homebrew` / `npm` / `winget` / `powershell` / `apt` / `curl` / `pip` / `cargo` / `installer-macos` / `installer-windows` / `installer-linux` / `other` / `unspecified` · `action`: `install` / `update` / `uninstall` · `outcome` · `failure_reason`: `none` / `unknown_dependency` / `no_install_command` / `no_update_strategy` / `no_uninstall_strategy` / `no_uninstall_command` / `permission_denied` / `command_failed` / `pty_open_failed` / `not_detected_after_install` / `not_detected_after_update` / `still_present` / `error` · `duration_ms`: `8421` |
| `session_started` | `agent_type`: `claude` · `location`: `local` · `outcome`: `success` · `failure_reason`: `none` / `agent_not_found` / `already_exists` / `spawn_failed` · `entry_point`: `command_palette` · `start_source`: `user` / `auto` / `adopted` / `unknown` · `has_initial_prompt`: `true` (**a boolean — never the prompt**) · `connected_to_room`: `false` |
| `session_ended` | `agent_type` · `location` · `outcome`: `normal` / `failed` |
| `session_attached` | `agent_type` · `outcome` |
| `session_provision_retried` | `agent_type` · `location` · `trigger`: `auto` / `retry_button` · `outcome` |

Note the shape of `failure_reason` everywhere: a short enumerated code such as
`permission_denied` or `docker_daemon_down`. It is **never** an exception message,
a stack trace, or a command's stderr — those are mapped to `error` if they don't
match a known code.

**Connector**

| Event | Fields, with example values |
|---|---|
| `connector_installed` | `agent_type`: `claude` · `target`: `local` · `outcome`: `success` · `failure_reason`: `none` / `unsupported` / `marketplace_failed` / `install_command_failed` / `update_command_failed` / `uninstall_command_failed` / `files_write_failed` / `files_unimplemented` · `duration_ms`: `8421` |
| `connector_updated` | `agent_type` · `target`: `remote` · `outcome` · `was_reinstall`: `false` · `failure_reason` (same set) · `duration_ms` |
| `connector_uninstalled` | `agent_type` · `target`: `local` · `outcome` · `failure_reason` (same set) · `duration_ms` |

`duration_ms` is how long the operation took, in whole milliseconds, measured on
a monotonic clock around the operation itself. It is the only field in the
catalogue that is not drawn from a fixed set of values, so to be explicit: it is
an elapsed time and nothing else. It names no path, host, command or repository,
and at this resolution it does not distinguish one machine from another.

**Servers and sign-in**

| Event | Fields, with example values |
|---|---|
| `server_added` | `server_kind`: `remote_managed` · `outcome`: `success` |
| `server_removed` | `server_kind`: `external` |
| `server_sign_in` | `auth_method`: `password` / `oidc` · `server_kind` · `outcome` · `failure_reason`: `none` / `invalid_credentials` / `cancelled` / `failed` / `unreachable` |
| `server_sign_out` | `server_kind`: `local` |
| `managed_server_action` | `action`: `start` / `stop` / `reset` · `target`: `local` / `remote` · `outcome` · `failure_reason`: `none` / `docker_not_installed` / `docker_daemon_down` / `version_downgrade` / `matrix_migration_failed` / `error` · `docker_available`: `available` / `unavailable` / `unknown` |

No server name, URL, hostname or username appears in any of these. A failed
sign-in records `invalid_credentials` — not the username tried, not the server.

**Rooms and bridges**

| Event | Fields, with example values |
|---|---|
| `bridge_connected` | `bridge_platform`: `slack` · `outcome`: `failure` · `failure_reason`: `none` / `unauthenticated` / `forbidden` / `invalid` / `error` |
| `bridge_disconnected` | `bridge_platform`: `mattermost` · `outcome` |
| `bridge_identity_claimed` | `bridge_platform` · `outcome` |
| `room_created` | `server_kind`: `local` · `bridge_platform`: `slack` · `agent_count`: `3` · `has_instructions`: `true` · `outcome` · `failure_reason`: `none` / `unauthenticated` / `bridge_unavailable` / `invalid` / `unreachable` / `error` |
| `room_deleted` | `server_kind` · `outcome` |
| `room_agents_added` | `agent_count`: `2` · `direction`: `agents_to_room` / `room_to_agents` |

A room creation tells us *"someone made a Slack-bridged room with 3 agents and it
worked"*. It does not tell us the room name, the channel, the workspace, or which
agents.

**Remote hosts**

| Event | Fields, with example values |
|---|---|
| `host_setup_step` | `step_kind`: `core-dependency` / `agent-cli` / `agent-plugin` / `unknown` · `agent_type` · `action`: `install` / `update` / `skip` · `outcome` |
| `host_onboarded` | `outcome`: `success` · `picked_from_ssh_config`: `true` (**a boolean — the SSH host is never sent**) |
| `host_removed` | `outcome` |

### 3.4 What is never sent, at all

Prompts · code · file paths · working directories · repository names · project
or location names · room names or ids · agent names or ids · server names or
URLs · hostnames · SSH hosts · usernames · emails · account or tenant ids ·
Switch user ids · IP or MAC addresses in the payload · error messages · stack
traces · log content · search queries · setting values · deeplink URLs.

---

## 4. How it is collected — why free text cannot leak

Not a policy; three independent mechanisms in the code, each of which alone
would stop a leak.

1. **The catalogue is closed at the type level.** Every event property is
   declared as a boolean, a number, or one of a fixed list of literal values —
   the lists reproduced in full above. A free-text property cannot be declared.
   A compile-time assertion fails the build if an event declares a property that
   is not on the runtime allowlist.
2. **A send-time allowlist rebuilds the payload.** At transmission, only the
   properties named for that specific event are copied across; anything else
   present on the object is dropped. A value that is not a string, finite number
   or boolean causes the whole event to be discarded rather than sent. This
   closes the "someone spread an extra object in" hole.
3. **External values are narrowed before they are ever attached.** Anything
   originating outside the app — a server response, a CLI error, a UI string — is
   mapped onto a known enum first. Unrecognised input becomes `unknown`, `other`
   or `error`; the original string is never carried through. Values arriving from
   the UI process are additionally validated against schemas at that boundary,
   and a failing value is dropped and logged *without* the value.

**The design rule behind it:** where a value would reveal content, we send a
derived flag instead. `has_initial_prompt` not the prompt; `has_instructions` not
the instructions; `agent_count` not the agents; `result_count` not the query;
`setting_key` not the value; `resolved`/`cold_start` not the link;
`picked_from_ssh_config` not the host.

**Consent.** Opt-out: telemetry is on by default. A non-dismissible notice on
first run states what is shared and what never is, and carries the off switch;
the same toggle lives in Settings → General. The setting is re-read before every
single event rather than cached, so turning it off stops transmission
immediately, with no further requests and no queued backlog. Dev builds never
transmit regardless of the setting. Opting out is itself not reported — the one
thing we do not measure is someone asking not to be measured.

---

## 5. The identifier

Exactly one identifier is attached: `flint.client_id`, e.g.
`3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83` — a random UUID generated on the machine
the first time telemetry runs, stored in the app's local database.

- **Generated randomly.** Not derived from hardware, MAC address, disk serial, OS
  account, network, email, licence, or any Switch identity.
- **No Switch identity travels with it** — no user id, agent id, room id, tenant
  id, server id.
- Deleting the app's data directory produces a **new, uncorrelated** UUID; there
  is no mechanism to relink the old one.
- Downstream it is used as the analytics `device_id` — it groups one
  installation's events together, and nothing more.

**There is no join key.** To resolve a UUID to a person you would need a second
dataset holding that UUID next to an identity. No such dataset exists: the UUID
lives only on the user's own machine and in the analytics store, and is never
sent to, or recorded by, any account, licensing, billing or support system. It is
an anonymous installation counter, not an identity.

---

## 6. Where it is sent

1. **App → our relay.** One plain HTTPS POST per event (OTLP logs format; no
   batching, no retries, 10-second timeout) to `telemetry.flintai.dev`, an
   endpoint we operate. No third-party analytics SDK runs inside the app, and no
   vendor credential is shipped in the app. Released builds cannot be pointed at
   a different endpoint — the override exists only in dev builds.
2. **Relay → destinations.** The relay forwards to **Amplitude** and **Datadog**,
   holding the vendor keys server-side.
3. **Storage and analysis** happen in those two products.

Putting a relay in the middle is deliberate: the vendors never receive a
connection from a user's machine, so nothing vendor-side observes the user's
network address, and vendor keys stay off end-user devices.

---

## 7. The client IP, and the relay's obligations

An HTTPS request necessarily reveals the client's IP address to the server
terminating it. The IP is not in the payload — it is a property of the connection
— and it is the only value anywhere in this pipeline that could re-identify a
user. The relay is therefore the single control point, and it is held to the
following requirements.

**R1 — The client IP is never persisted.** Access logging at the relay does not
record the remote address; the IP exists only in memory for the duration of the
request.

**R2 — The client IP is never forwarded.** The relay originates its own
connections to Amplitude and Datadog and does not set `X-Forwarded-For` or any
equivalent header. Amplitude's IP-based geolocation enrichment is disabled, so no
country, region or city is derived from the request and attached to the event.

**R3 — The client IP never reaches the cloud audit and security tooling.**
Request-level IP data is excluded from what is streamed to CloudTrail and Orca,
so there is no secondary copy of the address in the security estate.

**R4 — Abuse protection without retaining addresses.** The endpoint is
unauthenticated by design (shipping a credential in a desktop app protects
nothing), so it needs rate limiting — but naive rate limiting works by keeping a
table of IPs, which would undo R1. The approach is a probabilistic membership
structure: a Bloom filter / counting filter keyed on a **salted hash of the
client IP, with the salt rotated on a short window**, so the relay can throttle a
flooding source without ever storing, logging or being able to recover an address,
and the structure itself is unusable as a lookup table. Rotation bounds how long
even the hash is meaningful.

**R5 — Injection is bounded, and doesn't matter much.** An unauthenticated
endpoint can be sent junk events. Because nothing downstream is used for billing
or security decisions, the worst case is polluted product analytics; R4's rate
limiting caps the volume. Payloads that don't match the expected schema, or that
carry no client id, are rejected at the relay.

R1–R5 describe the relay, which lives outside the Console codebase; the rest of
this document is verified against the Console source directly.

---

## 8. Why this cannot be traced to a person

- **No direct identifier is transmitted.** §3.4 is exhaustive, and it is enforced
  by the three mechanisms in §4 — not by convention or code review.
- **No indirect identifier is transmitted.** The values most often used to
  re-identify — file paths, project and repository names, hostnames, usernames,
  workspace and channel names, error text — are precisely the ones replaced by
  enums, counts and booleans. §3 lists every permitted value; none of them is
  user-supplied.
- **No join key exists.** The only stable value is a locally generated random
  UUID present in no other system (§5).
- **Field entropy is very low.** Every field is drawn from a short fixed
  vocabulary — 2 to 30 possible values — so any event is one of a small number of
  shapes. Fingerprinting by field combination fails because the combinations are
  not distinctive.
- **The IP is controlled at a single point** and is neither logged, forwarded,
  nor used for enrichment (§7).
- **The user is told on first run, and one toggle stops it** — with effect on the
  very next event, since consent is checked per event rather than cached.

Because the payload identifies nobody, the opt-out default changes how many
installations are counted, not what is knowable about any of them.
