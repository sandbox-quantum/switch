# Agent invitation authority

An agent's addressing policy also controls who can bring it into a room. The
room's roster permissions still apply: being able to direct an agent does not
grant permission to change somebody else's room. Conversely, an administrator
who can manage the room does not bypass the agent's addressing policy.

`switch_core.invitations.require_invitation` is the shared policy check.
`RoomService` calls it before writing new agent memberships; callers supply
an actor derived from their authenticated context, never from an HTTP body.

| Entry point | Actor checked |
| --- | --- |
| Chat/slash `!invite-agent` | Actual transport sender, resolved through the addressing resolver |
| MCP and agent-bridge `invite_agent_to_room` | Inviting agent, with its own identity and owner |
| Agent-created room | Creating agent |
| Gateway/Console room creation and addition | Signed-in user and their linked platform accounts |
| Room YAML and template execution | Template runner; newly created agents belong to that runner |
| Platform join with a reported inviter | Reported platform account and its linked Switch users |

The existing `owner_and_owner_agents` rule admits the owner's agents. Strict
`owner_only` does not admit an inviting agent merely because its owner would
be allowed. A refusal points to the target agent's owner and account linking.
There is no extra invitation permission or implicit administrator exception.

## Whole-batch check and concurrent policy changes

Creation checks the resolved agent list before creating an external channel or
transport room. Both creation and addition check again in the membership
transaction, locking target agent rows in sorted ID order and refreshing their
stored policies. A concurrent policy update therefore takes effect either
before the membership decision or after that transaction commits. Addition
also locks and refreshes the room before checking its group, and filters
existing members again under that lock. A concurrent room-group move cannot
authorize against the room's old group.

A new room is checked with an empty room ID and its requested group: a rule
naming an existing room cannot authorize another room. Included subagents and
join listeners are checked individually. Existing members are filtered out
first. Tightening a policy does not remove existing memberships, and a duplicate
platform event cannot trigger a compensating removal.

Network provisioning is not a distributed transaction with PostgreSQL. If a
policy changes after creation's preliminary check, the final check refuses
membership, but an already-created external channel or transport room may need
operator cleanup. This change does not claim rollback of remote resources.

## Platforms that cannot identify an inviter

Slack's `member_joined_channel` event supplies `inviter` when available; the
adapter forwards it for both shared-app and bot-as-user joins. Other adapters
can fill the same optional fields. A present but unlinked/unrecognized account
is still a known actor and must pass policy. It is never treated as unknown.

When the platform omits the inviter, the accepted compatibility behavior is to
allow the new membership, without trusting any person. Switch:

- writes a warning to the server log;
- posts a non-addressing system notice in the room;
- persists a warning on each affected agent, including the room's name.

The authenticated Gateway returns those warnings **only to the agent's owner**,
including when another viewer is an administrator. Shared agent/MCP summaries
omit them. Console displays the warning on the agent page after fetching the
agent list. This reaches an owner who was absent from the channel when they
next view the agent; it is a persistent in-app warning, **not a push or email
notification**. At most 20 distinct room warnings are retained per agent.
The metadata key is server-owned: registration and client metadata replacements cannot inject or
erase it, including a stale reconnect declaration racing with an invitation.
A failed room-notice delivery is logged; the owner's warning remains stored.

A known unauthorized external addition does not create Switch agent membership,
transport invitation, or agent-arrival messages. The collaboration adapter API
has no general operation for removing an externally added bot. Switch therefore
reports the refusal in the channel but cannot promise to remove that external
bot from every supported vendor. An operator may need to remove it there.

## Verification

`core/tests/switch_core/test_invitation_policy.py` exercises the common gate,
real PostgreSQL membership writes and policy locking, unknown/known platform
origins, existing members, pre-provisioning refusal, and Gateway owner-only
warning visibility. Command and Slack adapter tests cover actor propagation;
`test_invitation_durability.py` covers metadata replacement, stale reconnects
and room-group changes. Console tests cover response mapping and rendered
warnings. Network effects are stubbed in these tests; no live platform
invitation is implied.
