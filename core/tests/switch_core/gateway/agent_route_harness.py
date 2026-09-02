"""Rows the agent-route tests write straight into Postgres.

An Agent cannot exist without a Client and an ApiKey, and the routes under test
care about neither, so both are built here at their minimum shape.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Agent, ApiKey, Client, User


async def add_user(session: AsyncSession, *, name: str, role: str = "user") -> User:
    user = User(name=name, email=f"{name}@example.com", role=role)
    session.add(user)
    await session.flush()
    return user


async def add_agent(
    session: AsyncSession,
    *,
    name: str,
    owner_id: str | None,
    icon_url: str | None = None,
    display_name: str | None = None,
) -> Agent:
    client = Client(
        type="agent",
        matrix_user_id=f"@{name}:test",
        display_name=name,
        password=f"pw-{name}",
    )
    session.add(client)
    await session.flush()

    api_key = ApiKey(
        type="agent",
        key_hash=f"hash-{name}",
        encrypted_key=f"enc-{name}",
        label=name,
        user_id=owner_id,
    )
    session.add(api_key)
    await session.flush()

    agent = Agent(
        name=name,
        description=f"{name} desc",
        icon_url=icon_url,
        display_name=display_name,
        agent_type="session_passive",
        connector_type="external",
        integration_profile={"connection_model": "session_passive"},
        client_id=client.id,
        api_key_id=api_key.id,
        owner_id=owner_id,
    )
    session.add(agent)
    await session.flush()
    return agent
