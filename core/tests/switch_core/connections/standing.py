"""Asking the broker about a service the way a route does: in a session of
the bound workspace."""

from __future__ import annotations

from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import ServiceBroker, ServiceStanding
from switch_core.connections.loader import ConnectionDefinition
from switch_core.db.models import ServiceConnection


async def standing(broker: ServiceBroker, service: str) -> ServiceStanding:
    async with broker._session_factory() as session:
        return await broker.standing(session, service)


async def connectable(broker: ServiceBroker, service: str) -> bool:
    return (await standing(broker, service)).connectable


async def read_only(broker: ServiceBroker, service: str) -> str | None:
    return broker.read_only(await standing(broker, service), service)


async def connection_status(
    broker: ServiceBroker, connection: ServiceConnection
) -> str:
    return broker.connection_status(
        await standing(broker, connection.service), connection
    )


async def reconnect_reason(
    broker: ServiceBroker, connection: ServiceConnection
) -> tuple[str, str] | None:
    return broker.reconnect_reason(
        await standing(broker, connection.service), connection
    )


async def availability(broker: ServiceBroker, service: str) -> str | None:
    async with broker._session_factory() as session:
        return await broker.availability(session, service)


async def sign_in(
    broker: ServiceBroker, service: str
) -> tuple[ConnectionDefinition, OAuthAdapter]:
    async with broker._session_factory() as session:
        return await broker.sign_in(session, service)
