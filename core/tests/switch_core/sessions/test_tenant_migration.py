import uuid
from types import SimpleNamespace

from alembic.config import Config
from alembic.runtime.environment import EnvironmentContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine

from switch_core.db.base import Base
from switch_core.db.engine import create_session_factory
from switch_core.db.models import (
    MediaBlob,
    SdkSession,
    SdkSessionCommand,
    SdkSessionEvent,
)
from switch_core.tenant_context import tenant_scope
from tests.switch_core.test_migration_parity import (
    _CORE,
    _script_directory,
    _upgrade_to_head,
    migrated_url,  # noqa: F401 — pytest fixture
)

from .test_tenant_isolation import seed


def downgrade_sdk(connection):
    config = Config(str(_CORE / "alembic.ini"))
    script = _script_directory(config)
    with EnvironmentContext(
        config,
        script,
        fn=lambda revision, context: script._downgrade_revs("b72e5d9f3018", revision),
    ) as environment:
        environment.configure(connection=connection, target_metadata=Base.metadata)
        with environment.begin_transaction():
            environment.run_migrations()


async def test_tenant_migration_preserves_session_history_and_attachment_bytes(
    migrated_url,  # noqa: F811 — imported pytest fixture
):
    engine = create_async_engine(migrated_url)
    factory = create_session_factory(engine)
    try:
        async with engine.begin() as connection:
            await connection.run_sync(_upgrade_to_head)
        authority, _ = await seed(
            SimpleNamespace(owner=factory, restricted=factory), "tenant-data"
        )
        with tenant_scope("tenant-data"):
            await authority.upload_attachment(
                "session-demo",
                "tenant-data",
                str(uuid.uuid4()),
                "example.txt",
                "text/plain",
                b"Retained bytes",
            )
            async with factory() as db:
                before = {}
                for model in (
                    SdkSession,
                    SdkSessionEvent,
                    SdkSessionCommand,
                    MediaBlob,
                ):
                    before[model] = [
                        tuple(
                            getattr(row, column.name)
                            for column in model.__table__.columns
                        )
                        for row in (
                            await db.scalars(
                                select(model).order_by(
                                    *model.__table__.primary_key.columns
                                )
                            )
                        ).all()
                    ]
        async with engine.begin() as connection:
            await connection.run_sync(downgrade_sdk)
            await connection.run_sync(_upgrade_to_head)
        with tenant_scope("tenant-data"):
            async with factory() as db:
                for model, expected in before.items():
                    actual = [
                        tuple(
                            getattr(row, column.name)
                            for column in model.__table__.columns
                        )
                        for row in (
                            await db.scalars(
                                select(model).order_by(
                                    *model.__table__.primary_key.columns
                                )
                            )
                        ).all()
                    ]
                    assert actual == expected
    finally:
        await engine.dispose()
