# Switch Console telemetry — what we collect, where it goes, and why it cannot be traced to a person

**Audience:** InfoSec.
**Scope:** the Switch Console desktop app, and the consent decision it carries
to a Switch server it runs for the user (§4.1). What that server itself
collects is documented in [`old/telemetry-events.md`](old/telemetry-events.md);
Switch server-side logging is out of scope here and needs its own pass.
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

These are all the fields one event carries, flattened out of the OTLP log
record it travels in (which also repeats the event's name as the record's own
name and body). Nothing else is sent with it:

```json
{
  "resource": {
    "service.name": "switch-console",
    "service.version": "0.9.14",
    "flint.client_id": "3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83",
    "flint_env": "prod",
    "flint_internal": "false",
    "os.type": "darwin",
    "os.version": "23.6.0"
  },
  "event.name": "switch_console.session_started",
  "timeUnixNano": "1789572278158000000",
  "severityText": "INFO",
  "attributes": {
    "build": "stable",
    "flint.insert_id": "9d0c5e7a-41b2-4f3e-8a6d-2b7c1e94f0a3",
    "flint.session_id": 1789571950042,
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
| `flint_env` | which analytics project the event is filed under | `prod` (a released stable build), `staging` (a released canary), `dev` (a packaged build that is not a release), `local` (running from source) |
| `flint_internal` | whether an account this app is signed in to a Switch server with has a SandboxAQ email address — **only the yes/no is sent, never the address**. Once an installation has been signed in with one, it stays `true`, so staff usage stays labelled after that account signs out | `true`, `false`, `unknown` (no account, or only the one a local server signs in with) |
| `os.type` | OS family | `darwin`, `windows`, `linux`, `other` |
| `os.version` | OS release string | `23.6.0`, `10.0.22631`, `6.1.0-53-cloud-amd64` |
| `flint.client_id` | random install UUID | `3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83` |
| `flint.insert_id` | a random UUID made for this one event, so that two events alike in every field and sent in the same millisecond are not taken for one. A new one every event; kept nowhere | `9d0c5e7a-41b2-4f3e-8a6d-2b7c1e94f0a3` |
| `flint.session_id` | which visit to the app the event belongs to: the time, in milliseconds, of the first thing someone did in it. A visit ends after 30 minutes with nothing done, and is kept only in memory. `-1` on the events that are not someone using the app — `session_discovered`, `session_reopened`, `subagent_adopted`, `agent_pruned`, `update_checked`, `update_install_started`, `renderer_crashed`, a `telemetry_consent_changed` from the first-run notice, and a `session_ended` for a session that went because the app removed its agent by itself — which neither start nor prolong a visit | `1789571950042`, `-1` |
| `event.name` | the event, prefixed with the product | `switch_console.session_started` |
| timestamp | event time | `1789572278158000000` |

That is the entire ambient set. No hostname, no username, no account, no machine
id, no IP field, no Switch identity.

### 3.2 Values shared across events

| Field | Complete set of possible values |
|---|---|
| `outcome` | `success`, `failure` (on `session_ended`, always `normal`; on `update_install_started`, always `failure`; on `bridge_identity_claimed`, also `pending`) |
| `agent_type` | the AI provider, one of those the app has registered — today `claude`, `codex`, `opencode`, `cursor`, `antigravity`, `deepseek-harness`, `pi`, `copilot`, `kiro`, `mistral-vibe`, `goose`, `qwen`, `droid`, `cline`, `junie` — or `unknown` for any value that is not one of them (on `agent_cli_action` and `host_setup_step`, also a tool that is not an agent's CLI). **Never an agent's name.** |
| `location` | `local`, `remote`, `unknown`. **Never a path, directory or project name.** |
| `server_kind` | `local`, `remote_managed`, `external`, `cloud` (Switch Cloud, the server this build offers by name), `unknown` (a server added by address while this build's own Switch Cloud address cannot be read). **Never a server name or URL.** |
| `bridge_platform` | A platform key the server lists as one of its registered platforms (`slack`, `mattermost`, `discord`, `teams`, `telegram`, and any platform added since), else `other`, or `unknown` when it cannot be read. Always a short lowercase key. **Never a workspace or channel name.** |
| `entry_point` | `command_palette`, `sidebar`, `server_page`, `onboarding`, `agent_page`, `machine_page`, `session_list`, `room_row`, `link`, `template`, `switch_buddy`, `unknown` |
| `target` | `local`, `remote` |

### 3.3 Every event and its fields

**App lifecycle**

| Event | Fields, with example values |
|---|---|
| `app_launched` | `install_kind`: `new` (the installation's very first launch) / `updated` (the first launch on a newer version; switching between the canary and stable builds, or going back to an older version, is `same`) / `same` · `from_version`: `0.40.1`, or `unknown` when the previous launch did not record one · `update_trigger`: `restart_button` (the app restarted itself to install the update) / `other` (installed on quit, or by hand) / `unknown` (that could not be read) — both are `none` unless `install_kind` is `updated` |
| `renderer_crashed` | *(no fields)* |
| `update_check_requested` | `result`: `available` / `up_to_date` / `failed` — someone asked for an update check, from the menu or a Check button |
| `update_checked` | `trigger`: `startup` (as a window loads) / `scheduled` (the hourly check) · `result`: `available` / `up_to_date` / `failed` — the app checked for an update on its own. Sent so the updater's health can be watched; a check that joins one already running is not sent again |
| `update_download_started` | *(no fields)* — Download was pressed for an available update |
| `update_downloaded` | `outcome`: `success` / `failure` |
| `update_install_started` | `outcome`: `failure` — an update install that was started and did not finish (the app never went down for the installer, or came back on the old version). One that worked is the next `app_launched`, with `install_kind` `updated` |
| `telemetry_consent_changed` | sharing was turned on · `source`: `first_run` (the first-run notice, which records sharing as on as soon as it is shown) / `settings` (turned on later, in Settings) · `install_kind`: as on `app_launched`, or `unknown` if the launch could not be recorded |
| `setting_changed` | `setting_key`, one of exactly 10: `localLocation`, `sessions`, `defaultAgent`, `notifications`, `theme`, `openIn`, `interface`, `browserPreview`, `browser`, `changesViewMode`. Sent only when the stored value actually changed. **The new value is never sent** — we learn that someone changed their theme, not to what. |
| `search_performed` | `status`: `ok` / `recents` / `query-too-short` / `failed` · `result_count`: `0`, `3`, `17`. **The query is never sent.** |

**Navigation and onboarding**

| Event | Fields, with example values |
|---|---|
| `view_opened` | a screen someone opened (not the one a launch resumes on) · `view_id`, one of exactly 24: `noServer`, `location`, `session`, `chat`, `managedAgent`, `room`, `settings`, `server`, `managedServer`, `serverAgents`, `machine`, `connectors`, `serverRooms`, `remoteHosts`, `remoteHost`, `templateImport`, `library`, `libraryItem`, `templates`, `templateDetail`, `templateUse`, `templateCapture`, `switchBuddy`, `admin` |
| `command_executed` | `command_id`, one of exactly 9: `app.settings`, `app.newLocation`, `app.addServer`, `app.toggleTheme`, `app.navigateBack`, `app.navigateForward`, `session.pin`, `session.nextSession`, `session.prevSession` · `invoked_by`: `palette` / `shortcut` |
| `deeplink_opened` | `resolved`: `true` / `false` · `cold_start`: `true` / `false`. **The URL is never sent.** |
| `add_server_step` | `step`: `choose` / `managedGitHub` / `managedAgent` / `local` / `remoteHost` / `external` / `signIn` / `linkAccounts` · `choice`: `none` / `local` / `remoteHost` / `external` / `cloud` · `first_run`: `true` / `false` — whether the same step was reached on a fresh install rather than from the Add server dialog |
| `onboarding_page` | `page`: `welcome` / `how_to_run` / `local_setup` / `server_address` / `sign_in` / `choose_workspace` / `create_workspace` / `meet_buddy` / `provider_setup` · `path`: `none` / `cloud` / `local` / `external` — which page of the first run opened, and how the install is running Switch once chosen |
| `buddy_step` | `action`: `start` / `skip` / `setup_opened` / `install` / `sign_in` / `check_again` / `create_failed` / `opened_existing` / `intro_opened` / `intro_dismissed` · `provider`: `claude` / `codex` / `opencode` / `cursor` / `antigravity` / `deepseek-harness` / `pi` / `copilot` / `kiro` / `mistral-vibe` / `goose` / `qwen` / `droid` / `cline` / `junie` / `none` — a step on the way to switch-buddy, the first agent, from the first run or from the pop-up that introduces it to people who have none. A new buddy is reported once, as `agent_created` with `entry_point` `switch_buddy` |
| `home_action` | `action`: `chip` / `connect_ai` / `message` · `chip`: `connect_chat_app` / `first_agent` / `team_room` / `new_room` / `new_agent` / `room_instructions` / `none` — something done on a server's Home: which suggestion was clicked, Connect to AI pressed, or a message sent to switch-buddy from the box there. **The message is never sent**, only that one was |

**Agents and sessions**

| Event | Fields, with example values |
|---|---|
| `agent_created` | `agent_type`: `codex` · `location`: `remote` · `outcome`: `failure` · `failure_reason`: `none` / `unauthenticated` / `name_conflict` / `credentials_conflict` / `already_configured` / `invalid_name` / `directory_unusable` / `not_configured` / `agent_not_on_server` / `refused` / `invalid` / `error` · `entry_point`: `sidebar` |
| `agent_attached` | `agent_type` · `location` — an agent already set up in a folder on a host was loaded into this app (Load existing agents); nothing was created |
| `subagent_adopted` | `agent_type` · `location` — one of an agent's sessions started a subagent, and this app took it on as an agent of its own |
| `agent_removed` | `agent_type` · `location` · `delete_in_switch`: `true` · `trigger`: `user` / `server_teardown` / `unknown` · `outcome` · `failure_reason`: `none` / `not_linked_to_switch` / `gateway_unauthorized` / `gateway_http` / `gateway_network` / `error` |
| `agent_pruned` | `agent_type` · `location` · `cause`: `gone_from_server` (its Switch server no longer has it) / `managed_agent_deleted` (the managed agent it had moved to was deleted from this app) · `outcome` — the agent was removed from this app automatically, not by a person removing it |
| `agent_cli_action` | `agent_type` · `target`: `local` / `remote` · `install_method`: `homebrew` / `npm` / `winget` / `powershell` / `apt` / `curl` / `pip` / `cargo` / `installer-macos` / `installer-windows` / `installer-linux` / `other` / `unspecified` · `action`: `install` / `update` / `uninstall` · `outcome` · `failure_reason`: `none` / `unknown_dependency` / `no_install_command` / `no_update_strategy` / `no_uninstall_strategy` / `no_uninstall_command` / `permission_denied` / `command_failed` / `process_open_failed` / `not_detected_after_install` / `not_detected_after_update` / `still_present` / `error` · `duration_ms`: `8421` |
| `session_started` | `agent_type`: `claude` · `location`: `local` · `outcome`: `success` · `failure_reason`: `none` / `agent_not_found` / `already_exists` / `spawn_failed` · `entry_point`: `command_palette` · `start_source`: `user` / `auto` (the app's local automation API) / `unknown` · `has_initial_prompt`: `true` (**a boolean — never the prompt**) · `connected_to_room`: `false` |
| `session_discovered` | `agent_type` · `location` — a session this app found running on a host and took on, rather than started: one started in a room, say, or from another computer |
| `session_ended` | `agent_type` · `location` · `outcome`: `normal` — a session deleted or archived here, or removed with its agent. One removed because the app removed its agent by itself (`agent_pruned`) is in no visit, with `flint.session_id` `-1` |
| `session_provision_retried` | `agent_type` · `location` · `trigger`: `retry_button` (Retry pressed) / `session_click` (the session clicked in the sidebar or a session list) · `outcome` — someone asked for a session that was not running to be set up again |
| `session_reopened` | `agent_type` · `location` · `outcome` — the app set a session up again on its own, typically the one a launch resumes on |

Note the shape of `failure_reason` everywhere: a short enumerated code such as
`permission_denied` or `docker_daemon_down`. It is **never** an exception message,
a stack trace, or a command's stderr — those are mapped to `error` if they don't
match a known code.

`duration_ms` on `agent_cli_action` is how long the operation took, in whole
milliseconds, measured on a monotonic clock around the operation itself. Like
`agent_count` and `result_count` it is a number rather than a value from a fixed
set, so to be explicit: it is an elapsed time and nothing else. It names no path,
host, command or repository, and at this resolution it does not distinguish one
machine from another.

**Servers and sign-in**

| Event | Fields, with example values |
|---|---|
| `server_added` | `server_kind`: `remote_managed` · `outcome`: `success` · `failure_reason`: `none` / `already_added` (another server already has the address) / `not_the_server_address` (it answered with a web page, usually a dashboard's address) / `error` |
| `server_removed` | `server_kind`: `external` |
| `server_sign_in` | `auth_method`: `password` / `oidc` / `signup` · `server_kind` · `outcome` · `failure_reason`: `none` / `invalid_credentials` / `cancelled` / `failed` / `unreachable` / `email_taken` / `invalid` / `disabled` / `rate_limited` |
| `server_sign_out` | `server_kind`: `local` |
| `managed_server_action` | `action`: `start` / `stop` / `reset` · `target`: `local` / `remote` · `outcome` · `failure_reason`: `none` / `docker_not_installed` / `docker_daemon_down` / `version_downgrade` / `matrix_migration_failed` / `start_refused` (the stack already on the host cannot be started from here, such as another account's) / `health_timeout` (it started but did not become healthy in time) / `core_exited` (the server process exited while starting) / `running_as_root` / `operation_in_progress` (another start, stop or reset was running) / `error` · `docker_available`: `available` / `unavailable` / `unknown` |

No server name, URL, hostname or username appears in any of these. A failed
sign-in records `invalid_credentials` — not the username tried, not the server.

**Rooms and bridges**

| Event | Fields, with example values |
|---|---|
| `bridge_connected` | `bridge_platform`: `slack` · `outcome`: `failure` · `failure_reason`: `none` / `unauthenticated` / `forbidden` / `invalid` / `error` |
| `bridge_disconnected` | `bridge_platform`: `mattermost` · `outcome` |
| `bridge_identity_claimed` | `bridge_platform` · `outcome`: `success` (linked) / `pending` (waiting for a one-time code to be posted from the account, which is what confirms the link) / `failure` |
| `bridge_identity_confirmed` | `bridge_platform` · `link_kind`: `new` (a link that was waiting on its code) / `existing` (a link made before links had to be confirmed, which worked all along) / `unknown` — sent when the code is posted and the link confirmed, after asking the server that it is |
| `room_created` | `server_kind`: `local` · `bridge_platform`: `slack` · `agent_count`: `3` · `has_instructions`: `true` · `outcome` · `failure_reason`: `none` / `unauthenticated` / `bridge_unavailable` / `invalid` / `unreachable` / `network` / `forbidden` / `not_found` / `conflict` / `server_error` / `error` · `source`: `dialog` / `template` |
| `room_deleted` | `server_kind` · `outcome` |
| `room_agents_added` | `agent_count`: `2` · `direction`: `agents_to_room` / `room_to_agents` / `unknown` · `outcome` · `failure_reason`: `none` / `unreachable` / `unauthenticated` / `network` / `forbidden` / `not_found` / `conflict` / `invalid` / `server_error` / `error` |

A room creation tells us *"someone made a Slack-bridged room with 3 agents and it
worked"*. It does not tell us the room name, the channel, the workspace, or which
agents.

`source` says whether the room came from the Create room dialog or from a
template. A template run reports each room it made, and each agent as
`agent_created` with `entry_point` `template` — or, for switch-buddy,
`switch_buddy`, whether it was set up in the first run or from its chat later.
What a run does not
already say — a room's platform, agent count and whether it has instructions, the
provider of an agent the server chose — is read back from the server once it
exists, only when sharing is on, and only while the run's workspace is still the
one open: the app never switches back to it just to describe the run. A template
run that fails reports nothing: it made nothing, and how many rooms it would have
made is not known.

**Chats**

| Event | Fields, with example values |
|---|---|
| `chat_created` | `server_kind` · `kind`: `direct` / `group` (as the server made it) / `unknown` (the create failed) · `agent_count`: `1` · `person_count`: `0` · `on_messaging_app`: `false` · `outcome` · `failure_reason`: `none` / `unauthenticated` / `refused` (the server turned the request down) / `rate_limited` (the server asked the app to slow down) / `request_reused` (the request's id was already used for a different request) / `network` (no answer, or the request timed out) / `server_error` / `error` |
| `chat_message_sent` | `server_kind` · `has_attachment`: `true` · `in_thread`: `false` · `mentions`: `none` / `agent` / `person` / `both` · `outcome` · `failure_reason` |
| `chat_member_changed` | `server_kind` · `change`: `added` / `removed` · `member_kind`: `person` / `agent` · `outcome` · `failure_reason` |
| `chat_control_sent` | `server_kind` · `command`: `interrupt` / `reset` / `compact` / `retry` · `outcome` · `failure_reason` |
| `chat_approval_answered` | `server_kind` · `outcome` · `failure_reason` |

A message sent tells us *"someone sent a message in a thread, with a file, that
named an agent"*. It does not tell us the text, the file, the chat, or which
agent or person was named. `mentions` is the kind of who was named, never who.
A refusal is reported as `refused`, not with the server's code or message.
Reopening a chat that already exists is not reported as a new one, and a retry
of something already reported as done is not counted twice.

**Remote hosts**

| Event | Fields, with example values |
|---|---|
| `host_setup_step` | `step_kind`: `core-dependency` / `agent-cli` / `unknown` · `agent_type` · `action`: `install` / `update` / `skip` · `outcome` |
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

**Consent.** Opt-out: telemetry is on by default. The first-run welcome page
carries one line saying that anonymous usage data is shared, with a link to this
document and a Turn off link beside it; the page that starts a Switch server on
this machine carries the same switch, and the toggle lives in Settings →
Preferences. Because the default is on, events are sent from the first launch,
before anyone has read that line, and the line records sharing as on as soon as
it is shown. The setting is re-read before every single event rather than
cached, so turning it off stops transmission immediately, with no further
requests and no queued backlog. Running the app from source sends nothing
whatever the setting, unless a developer opts that run in to test what it
sends (it is then filed as `local`); a packaged build that is not a release
does send, filed as `dev` (§3.1). Opting out is itself not reported — the one thing we do not measure is
someone asking not to be measured.

### 4.1 The same answer governs a server the Console runs

Switch Console can run a Switch server for the user — as containers on their own
machine, or on a host they have given it over SSH. That server has product-usage
telemetry of its own, off unless its configuration turns it on, and the Console's
toggle is what turns it on: the answer is written into the server's configuration
every time the Console starts it, in both directions, together with the address
to send to — the same relay the app reports to, rather than whatever the
server's own version defaults to. A server that was already running when the
Console started naming the address is flagged on its page like any other
out-of-step setting, with the restart offered. "No" is written down
explicitly rather than left out, because a stack started under a "yes" would
otherwise keep the setting it started with.

What that server reports is its own catalogue (`docs/old/telemetry-events.md`),
held to the same rule: counts, durations and closed values, never a room,
agent, person or message. Auto-route is an example: each decision the server
asks a decision service for reports only which kind of backend answered
(`server_default`, `endpoint`, `haiku_anthropic` or `haiku_bedrock`), whether
it picked an agent or nobody, its confidence in tenths and its latency
(`decision_made`), or why it failed (`decision_failed`: `timeout`,
`unreachable`, `error_status`, `bad_answer`, `key_unreadable`,
`endpoint_refused`). Which agent was
picked, in which room, for which message, is never sent.

Three limits are stated in the app rather than left to be discovered.

- **The server reads the setting when it starts.** Changing the answer while it
  is running does not reach it until it restarts, and the Console does not
  restart it silently — a restart ends live agent sessions. Instead the server's
  page says the running server is out of step with the answer and offers the
  restart. The check reads the running container's own environment, so a start
  that wrote the configuration and then failed is reported as out of step rather
  than as applied; a server that cannot be read at all is reported as unknown,
  never as agreeing.
- **A server reached by URL is not covered.** It is somebody else's deployment
  with its own answer, and the toggle neither reaches it nor claims to.

The third is stated in the same note as the second, in a sentence; the detail
is here. **On a server other people's Consoles also use, a "yes" does not turn
sharing on over them, but a "yes" can keep it on.** This concerns a server on
an SSH host, which several people can run from their own Consoles; the server
on the user's own machine has no other users, and the answer is applied there
as given.

- **A "no" applies to everyone on the server**, but only when the Console that
  holds it starts the server. Until then the server keeps the setting it
  started with, and that person's server page says it is still sharing and
  offers the restart.
- **A "yes" applies only if the server's saved configuration already asks to
  share, or no other Console has been seen on it in the last 14 days.** Each
  Console records itself in a list kept on the host when it starts, stops,
  connects to or resets the server, and once a day while it is open on a
  running one. The list holds nobody's answer, so holding a "yes" back is a
  precaution, not a check that someone said no.
- **So an earlier "yes" can outlast a later "no".** If sharing was turned on
  while one Console was alone, later starts under a "yes" keep it on with
  others present. A co-user's "no" stops it only when their own Console
  restarts the server.
- **Failing to read the list holds a "yes" back** for that start. A host with
  no list yet counts as nobody else, entries that cannot be parsed are
  skipped, and a Console too old to write to the list is not counted.

When a "yes" is held back, the Console does not say so at the time: the note
states the rule, and the log records each case. The server's page does not
report the server as out of step, because a restart from that Console would
hold it back again.

---

## 5. The identifier

Exactly one lasting identifier is attached: `flint.client_id`, e.g.
`3f2a9c41-8d7e-4b16-9a55-c0e1d2f47b83` — a random UUID generated on the machine
the first time telemetry runs, stored in the app's local database.

Each event also carries `flint.insert_id`, a random UUID made for that event
alone. It identifies the event and nothing else: it is never reused, never
stored on the machine, and connects no event to any other. And it carries
`flint.session_id`, a time: when the visit it belongs to began. It groups an
installation's events into visits, which `flint.client_id` already groups
them into installations, and is derived from nothing but the clock.

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
   batching, no retries, 10-second timeout) to `telemetry.switchagents.ai`, an
   endpoint we operate. No third-party analytics SDK runs inside the app, and no
   vendor credential is shipped in the app. No packaged build can be pointed at
   a different endpoint — the override exists only when running from source.
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
- **No join key exists.** The only lasting value is a locally generated random
  UUID present in no other system (§5).
- **Field entropy is very low.** Apart from the install id, the event's own
  random id and the time its visit began (§5), every field is drawn from a short
  fixed vocabulary — 2 to 30 possible values — so any event is one of a small number of
  shapes. Fingerprinting by field combination fails because the combinations are
  not distinctive.
- **The IP is controlled at a single point** and is neither logged, forwarded,
  nor used for enrichment (§7).
- **The user is told on first run, and one toggle stops it** — with effect on the
  very next event, since consent is checked per event rather than cached.

Because the payload identifies nobody, the opt-out default changes how many
installations are counted, not what is knowable about any of them.
