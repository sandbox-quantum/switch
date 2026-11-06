"""Asking the broker about a service the way a route does: in a session of
the bound workspace."""

from __future__ import annotations

from switch_core.connections.adapters.oauth import OAuthAdapter
from switch_core.connections.broker import ServiceBroker, ServiceStanding
from switch_core.connections.loader import ConnectionDefinition


async def standing(broker: ServiceBroker, service: str) -> ServiceStanding:
    async with broker._session_factory() as session:
        return await broker.standing(session, service)


async def connectable(broker: ServiceBroker, service: str) -> bool:
    return (await standing(broker, service)).connectable


async def availability(broker: ServiceBroker, service: str) -> str | None:
    async with broker._session_factory() as session:
        return await broker.availability(session, service)


async def sign_in(
    broker: ServiceBroker, service: str
) -> tuple[ConnectionDefinition, OAuthAdapter]:
    async with broker._session_factory() as session:
        return await broker.sign_in(session, service)
