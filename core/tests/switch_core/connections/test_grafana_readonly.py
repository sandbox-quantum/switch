"""The shipped read-only entry through real consent and grant-selection code."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from switch_core.connections.broker import ServiceBroker, ServiceError
from switch_core.connections.flows import ServiceFlows
from switch_core.connections.loader import CATALOG


async def test_generic_grafana_sign_in_requests_only_read():
    store = SimpleNamespace(start=AsyncMock(return_value=SimpleNamespace()))
    flows = ServiceFlows(None, store)
    await flows.start(
        definition=CATALOG['grafana'].definition,
        tenant_id='test-tenant', user_id='test-user', state='test-state',
        port=43123, completion_secret='test-secret', owner_label='Test',
        fields={'stack': 'example.grafana.net'},
    )
    details = store.start.call_args.kwargs['details']
    assert details['consent'] == 'read'
    assert details['scopes'] == ['grafana:read']
    assert details['read_scopes'] == ['grafana:read']
    assert details['write_scopes'] == []
    assert details['connection_fields'] == {'stack': 'example.grafana.net'}


def broker_for_read_connection():
    broker = object.__new__(ServiceBroker)
    broker._catalog = CATALOG
    broker.standing = AsyncMock(return_value=SimpleNamespace(unavailable=None))
    broker.require_workspace_enabled = AsyncMock()
    broker._adapter = AsyncMock(return_value=object())
    broker._store = SimpleNamespace(get_connection=AsyncMock(return_value=SimpleNamespace(status='active', consent='read')))
    return broker


async def test_on_off_agent_grant_inherits_read_only_consent():
    broker = broker_for_read_connection()
    terms = await broker._grant_terms(None, owner_id='test-user', service='grafana', access=None, tool_mode=None, tools=None)
    assert terms.access == 'read'
    assert terms.reach == {'scopes': ['grafana:read']}
    assert terms.passes_through is True


async def test_explicit_write_grant_cannot_broaden_pass_through_connection():
    broker = broker_for_read_connection()
    with pytest.raises(ServiceError, match='on or off'):
        await broker._grant_terms(None, owner_id='test-user', service='grafana', access='write', tool_mode=None, tools=None)
