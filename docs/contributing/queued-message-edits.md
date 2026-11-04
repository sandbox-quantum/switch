# Editing a queued message

When an agent is busy, its next addressed message waits in the session host's
queue. Editing that message in **Slack or Mattermost** updates its text if the
host has not claimed the turn yet. The activity card says **Queued (prompt
updated)**. The turn ID, queue position, sender, thread, attachments and trusted
prompt context stay the same. Edits never run a newly typed chat command or
address another agent through changed mentions.

## When an edit is too late

Claiming the turn is the cutoff, including time spent staging its attachments.
After claim, an edit leaves that turn unchanged. It does not steer, cancel or
restart work. Send a follow-up or use `!interrupt @agent` when work already
underway needs to stop. Other messaging platforms retain their existing
behavior; edit ingress is currently implemented for Slack and Mattermost.

## Delivery and recovery

A replacement is a new room row referencing the original with
`m.relates_to: {rel_type: "m.replace", event_id: ...}` and `m.new_content`.
The original row remains immutable. The router validates the author and room
and delivers `message_edit` events to the original recipients still in the
room. An agent that was not originally addressed is not started by an edit.

Platform edit times are positive integer microseconds. Stable edit identities
make retries idempotent; the host ignores revisions older than the latest
accepted one. Edits have their own accepted command records, so resending the
original command remains idempotent. Prompt framing is regenerated with a
fresh nonce while preserving the trusted prefix and suffix.

Successful transcript updates survive restart. Existing recovery behavior is
preserved: queued or running turns interrupted by a host restart are **not
resent automatically**, avoiding uncertain duplicate execution. Room context
retains originals and explicit edit entries rather than rewriting history.

## Verify the behavior

With a development stack, a signed-in supported provider and the headless
controller, run the real Mattermost scenario:

```sh
SWITCH_E2E_LANE=provider SWITCH_E2E_AGENT_TYPE=codex \
  bash console/tooling-e2e/scripts/ephemeral-stack.sh -- \
  src/provider/provider.e2e.test.ts -t queued-message-edit
```

The scenario holds a real provider turn busy, queues another request, edits the
same Mattermost post, waits for the updated queued card, interrupts the first
turn and verifies that the provider replies to the corrected request. It uses
an isolated temporary stack and real model calls.
