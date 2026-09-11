import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import StatementError

from switch_core.bridges.agent.protocol.connections import ConnectionRegistry
from switch_core.bridges.agent.protocol.event_buffer import EventBuffer
from switch_core.db.models import (
    Agent,
    ApiKey,
    Client,
    MediaBlob,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
    Tenant,
    TenantNotBoundError,
    User,
)
from switch_core.db.stores.media_store import MediaStore
from switch_core.sessions.attachments import attachment_uri
from switch_core.sessions.contract import Session
from switch_core.sessions.service import SessionAuthority, SessionError
from switch_core.tenant_context import no_tenant, tenant_scope

from .test_authority import EXAMPLES, command, host_event


async def seed(harness, tenant):
    async with harness.owner() as db, db.begin():
        db.add(Tenant(id=tenant, slug=tenant, name=tenant))
        db.add(
            User(id=tenant, name="Owner", email=f"{tenant}@example.test", role="user")
        )
    with tenant_scope(tenant):
        async with harness.restricted() as db, db.begin():
            key = ApiKey(
                user_id=tenant,
                key_hash=uuid.uuid4().hex,
                encrypted_key="",
                label="fixture",
                type="agent",
            )
            client = Client(
                id=f"client-{tenant}",
                matrix_user_id=f"@agent-{tenant}:example.test",
                display_name="Agent",
                type="agent",
            )
            db.add_all([key, client])
            await db.flush()
            db.add(
                Agent(
                    id=tenant,
                    name="agent",
                    description="Fixture",
                    agent_type="claude",
                    connector_type="external",
                    integration_profile={},
                    client_id=client.id,
                    api_key_id=key.id,
                    owner_id=tenant,
                )
            )
        authority = SessionAuthority(harness.restricted)
        session = Session.model_validate(
            EXAMPLES["initialSnapshot"]["session"]
        ).model_copy(update={"agent_id": tenant})
        snapshot = await authority.acquire(tenant, session)
        await authority.ingest(
            tenant,
            "host-demo",
            host_event(
                snapshot.session.epoch,
                1,
                {
                    "type": "session.upsert",
                    "session": snapshot.session.model_dump(by_alias=True),
                },
            ),
        )
        message = command(
            snapshot.session.epoch,
            "same-command",
            {
                "type": "message.send",
                "text": "Once",
                "attachments": [],
                "delivery": "queue",
            },
            actor=tenant,
        )
        message = message.model_copy(
            update={"origin": message.origin.model_copy(update={"room_id": None})}
        )
        await authority.submit(message, user_id=tenant, bridge_id=None)
        return authority, snapshot.session.epoch


async def test_same_session_and_attachment_ids_are_isolated_by_database_policy(
    rls_harness,
):
    attachment_id = str(uuid.uuid4())
    for tenant in ("tenant-a", "tenant-b"):
        authority, epoch = await seed(rls_harness, tenant)
        with tenant_scope(tenant):
            await authority.upload_attachment(
                "session-demo",
                tenant,
                attachment_id,
                "example.txt",
                "text/plain",
                tenant.encode(),
            )
            blob = await authority.attachment(
                tenant, "session-demo", "host-demo", epoch, attachment_id
            )
            assert blob.data == tenant.encode()
            async with rls_harness.restricted() as db, db.begin():
                row = await db.get(SdkSession, (tenant, "session-demo"))
                assert row.tenant_id == tenant
                row.connection_id = "same-connection"
    for tenant in ("tenant-a", "tenant-b"):
        with tenant_scope(tenant):
            async with rls_harness.owner() as db:
                blob = await MediaStore().get(
                    db, attachment_uri("session-demo", attachment_id)
                )
                assert blob.data == tenant.encode()
            async with rls_harness.restricted() as db:
                for model in (
                    SdkSession,
                    SdkSessionEvent,
                    SdkSessionCommand,
                    MediaBlob,
                ):
                    rows = (await db.scalars(select(model))).all()
                    assert rows
                    assert {row.tenant_id for row in rows} == {tenant}
                    assert not (
                        await db.scalars(select(model).where(model.tenant_id != tenant))
                    ).all()


async def test_all_authority_paths_reject_another_tenants_session(rls_harness):
    authority, epoch = await seed(rls_harness, "tenant-b")
    with tenant_scope("tenant-a"):
        assert await authority.list_sessions("tenant-b") == []
        operations = [
            lambda: authority.renew("tenant-b", "session-demo", "host-demo", epoch),
            lambda: authority.ingest(
                "tenant-b",
                "host-demo",
                host_event(
                    epoch,
                    2,
                    {
                        "type": "session.upsert",
                        "session": {
                            **EXAMPLES["initialSnapshot"]["session"],
                            "agentId": "tenant-b",
                            "epoch": epoch,
                        },
                    },
                ),
            ),
            lambda: authority.pending("tenant-b", "session-demo", "host-demo", epoch),
            lambda: authority.recover(
                "tenant-b", "session-demo", "host-demo", epoch, "recovery", 0
            ),
            lambda: authority.quiesce("tenant-b", "session-demo", "host-demo", epoch),
            lambda: authority.submit_room_message(
                "tenant-b",
                "session-demo",
                "host-demo",
                epoch,
                "room",
                "message",
                1,
                EventBuffer(),
            ),
            lambda: authority.bind_connection(
                "tenant-b",
                "session-demo",
                "host-demo",
                epoch,
                "connection",
                ConnectionRegistry(),
            ),
            lambda: authority.snapshot("session-demo", "tenant-b"),
            lambda: authority.events("session-demo", "tenant-b", 0),
            lambda: authority.command_status(
                "session-demo", "same-command", "tenant-b"
            ),
            lambda: authority.reconcile(
                command(
                    epoch,
                    "reconcile-command",
                    {"type": "session.stop"},
                    actor="tenant-b",
                ),
                "tenant-b",
            ),
            lambda: authority.retire("session-demo", "tenant-b", epoch),
            lambda: authority.submit(
                command(
                    epoch, "other-command", {"type": "session.stop"}, actor="tenant-b"
                ),
                user_id="tenant-b",
                bridge_id=None,
            ),
            lambda: authority.attachment(
                "tenant-b", "session-demo", "host-demo", epoch, str(uuid.uuid4())
            ),
            lambda: authority.upload_attachment(
                "session-demo",
                "tenant-b",
                str(uuid.uuid4()),
                "example.txt",
                "text/plain",
                b"data",
            ),
        ]
        for operation in operations:
            with pytest.raises(SessionError) as error:
                await operation()
            assert error.value.code == "NOT_FOUND"
        foreign = Session.model_validate(
            EXAMPLES["initialSnapshot"]["session"]
        ).model_copy(update={"agent_id": "tenant-b"})
        with pytest.raises(SessionError) as error:
            await authority.acquire("tenant-b", foreign)
        assert error.value.code == "NOT_AUTHORIZED"


async def test_authority_and_raw_writes_require_a_bound_tenant(rls_harness):
    authority, _ = await seed(rls_harness, "tenant-b")
    with no_tenant():
        with pytest.raises(TenantNotBoundError):
            await authority.snapshot("session-demo", "tenant-b")
        async with rls_harness.owner() as db:
            db.add(
                SdkSessionCommand(
                    session_id="session-demo",
                    command_id="unbound",
                    accepted_sequence=1,
                    command={},
                    status={},
                )
            )
            with pytest.raises(StatementError) as error:
                await db.flush()
            assert isinstance(error.value.orig, TenantNotBoundError)
