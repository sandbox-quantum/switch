"""An inviter for tests that put agents in rooms without being about invites."""

from switch_core.invites import PlatformInviter

# A platform join that did not say who added the bot, which `InviteGate` never
# refuses. Tests of the gate itself use the real inviter kinds.
UNCHECKED = PlatformInviter(bridge_id="test-bridge", external_user_id=None)
