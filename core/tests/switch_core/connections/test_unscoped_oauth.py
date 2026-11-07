from types import SimpleNamespace

import pytest
import yaml
from pydantic import ValidationError

from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import ConnectionDefinition
from tests.switch_core.connections.test_loader import OAUTH_ENTRY


def unscoped():
    body = yaml.safe_load(OAUTH_ENTRY)
    body["access"] = {"unscoped": True, "read": {"scopes": []}, "write": {"scopes": []}}
    return body


def test_unscoped_oauth_accepts_only_empty_levels():
    definition = ConnectionDefinition.model_validate(unscoped())
    assert definition.access.unscoped is True
    body = unscoped()
    body["access"]["write"]["scopes"] = ["write"]
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(body)


def test_empty_scopes_require_explicit_opt_in():
    body = unscoped()
    body["access"].pop("unscoped")
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(body)


def test_unscoped_requires_write_level():
    body = unscoped()
    body["access"].pop("write")
    with pytest.raises(ValidationError):
        ConnectionDefinition.model_validate(body)


def test_unscoped_consent_is_always_write():
    exchange = SimpleNamespace(
        signed_in=SimpleNamespace(granted_scopes=[]),
        flow=SimpleNamespace(
            details={
                "name": "Example",
                "unscoped": True,
                "read_scopes": [],
                "write_scopes": [],
            }
        ),
    )
    assert ServiceFlows.consent(None, exchange) == "write"
