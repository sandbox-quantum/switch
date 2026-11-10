from types import SimpleNamespace

from switch_core.connections.flows import ServiceFlows


def test_unscoped_oauth_consent_is_the_single_write_level():
    exchange = SimpleNamespace(
        flow=SimpleNamespace(details={"unscoped": True}),
        signed_in=SimpleNamespace(granted_scopes=[]),
    )

    assert ServiceFlows.consent(object.__new__(ServiceFlows), exchange) == "write"
