"""Who invites agents in tests that set rooms up rather than test invites.

A person, as in the gateway: every open addressing policy admits them, which
is what those tests' agents carry. A test whose agents have a restricted
policy names the agents' owner (`Inviter.user(owner_id)`) instead, and the
rules themselves are tested in `tests/switch_core/test_invites.py`.
"""

from __future__ import annotations

from switch_core.invites import Inviter

FIXTURE_INVITER = Inviter.user("test-fixture-user")
