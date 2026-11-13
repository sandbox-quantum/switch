"""The snapshot's template counts: who builds templates, and who runs them.

Authors and installers are accounts, so one person with templates in two
workspaces counts once; the rest are per-workspace rows summed.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from switch_core.db.models import (
    TENANT_ZERO_ID,
    HiddenOfficialTemplate,
    Template,
    TemplateInstall,
    TemplateRunRecord,
    Tenant,
    User,
)
from switch_core.telemetry.snapshot import collect_usage
from tests.switch_core.telemetry.test_snapshot import _agent

NOW = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
OTHER_TENANT = "22222222-2222-2222-2222-222222222222"


def _template(tenant_id: str, owner: User, name: str, **extra: object) -> Template:
    return Template(
        tenant_id=tenant_id,
        owner_id=owner.id,
        name=name,
        description="",
        kind="room",
        content="room:\n  name: r\n",
        **extra,
    )


def _install(
    tenant_id: str, owner: User, source: str, template_id: str
) -> TemplateInstall:
    return TemplateInstall(
        tenant_id=tenant_id,
        owner_id=owner.id,
        source=source,
        template_id=template_id,
        template_name="t",
        revision=1,
        inputs={},
        builtins={},
    )


async def test_template_counts(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    async with session_factory() as session:
        session.add(
            Tenant(id=OTHER_TENANT, name="second", slug=f"s-{uuid.uuid4().hex[:8]}")
        )
        alice = User(name="alice", email="alice@test", role="user", password_hash="x")
        bob = User(name="bob", email="bob@test", role="user", password_hash="x")
        carol = User(name="carol", email="carol@test", role="user", password_hash="x")
        session.add_all([alice, bob, carol])
        await session.flush()
        saver = await _agent(session, None)
        long_ago = NOW - timedelta(days=30)
        session.add_all(
            [
                _template(TENANT_ZERO_ID, alice, "a1"),
                _template(OTHER_TENANT, alice, "a2"),
                _template(TENANT_ZERO_ID, bob, "b1", created_by_agent_id=saver.id),
                _template(
                    TENANT_ZERO_ID,
                    carol,
                    "c1",
                    created_at=long_ago,
                    updated_at=long_ago,
                ),
                TemplateRunRecord(tenant_id=TENANT_ZERO_ID, template_id="official:x"),
                TemplateRunRecord(tenant_id=OTHER_TENANT, template_id="official:x"),
                TemplateRunRecord(
                    tenant_id=TENANT_ZERO_ID, template_id="t", created_at=long_ago
                ),
                _install(TENANT_ZERO_ID, alice, "official", "official:switch-buddy"),
                _install(OTHER_TENANT, alice, "official", "official:switch-buddy"),
                _install(TENANT_ZERO_ID, bob, "official", "official:sprint-room"),
                _install(TENANT_ZERO_ID, bob, "saved", "some-template"),
                HiddenOfficialTemplate(
                    tenant_id=TENANT_ZERO_ID, slug="incident-war-room", hidden_by=None
                ),
            ]
        )
        await session.commit()

    counts = await collect_usage(session_factory, now=NOW + timedelta(minutes=1))
    properties = counts.as_event_properties(session_live_count=0)

    assert {
        name: properties[name]
        for name in (
            "template_count",
            "template_agent_saved_count",
            "template_author_count",
            "template_author_active_7d",
            "template_run_7d",
            "template_official_installer_count",
            "template_saved_installer_count",
            "official_template_hidden_count",
        )
    } == {
        "template_count": 4,
        "template_agent_saved_count": 1,
        "template_author_count": 3,
        "template_author_active_7d": 2,
        "template_run_7d": 2,
        "template_official_installer_count": 2,
        "template_saved_installer_count": 1,
        "official_template_hidden_count": 1,
    }
