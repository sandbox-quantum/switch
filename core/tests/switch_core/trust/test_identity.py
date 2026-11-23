"""The agent fingerprint has to match Switch Trust's derivation byte for byte:
a guardrail check carrying a different one lands on an agent the inventory
never described."""

from switch_core.trust.identity import agent_fingerprint, agent_label


def test_fingerprint_matches_switch_trusts_derivation() -> None:
    # Pinned: the same vector is asserted on the Switch Trust side.
    assert agent_fingerprint("srv-1", "ten-1", "a1") == (
        "agn_a8c2be6e934eb476dc8f817d19a5c897"
    )


def test_the_same_agent_id_in_another_tenant_is_another_agent() -> None:
    assert agent_fingerprint("srv-1", "ten-1", "a1") != agent_fingerprint(
        "srv-1", "ten-2", "a1"
    )


def test_label_prefers_the_display_name() -> None:
    assert agent_label("reviewer", "Code Reviewer") == "Code Reviewer"
    assert agent_label("reviewer", None) == "reviewer"
    assert agent_label("reviewer", "  ") == "reviewer"
