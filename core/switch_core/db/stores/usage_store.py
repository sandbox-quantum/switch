from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import and_, func, literal, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import Client, TenantUsage, UsageMetric


@dataclass(frozen=True)
class UsageTotal:
    """One consumer's total of one metric over a window.

    `client_name` and `client_type` are null for a client that no longer
    exists; the usage it spent is still the tenant's.
    """

    metric: str
    client_id: str
    client_name: str | None
    client_type: str | None
    model: str
    amount: int


class UsageStore:
    async def record(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        metric: UsageMetric,
        client_id: str,
        model: str,
        amount: int,
    ) -> None:
        """Add `amount` to the current hour's count, in the caller's transaction.

        The bucket is the database's clock, not this process's, so every writer
        agrees on which hour it is. Hours are taken in UTC so a deployment's
        `TimeZone` setting cannot move a bucket boundary.
        """
        if amount <= 0:
            raise ValueError(f"usage amount must be positive, got {amount}")
        bucket = func.date_trunc("hour", func.now(), literal("UTC"))
        statement = insert(TenantUsage).values(
            tenant_id=tenant_id,
            metric=metric.value,
            bucket_start=bucket,
            client_id=client_id,
            model=model,
            amount=amount,
        )
        statement = statement.on_conflict_do_update(
            index_elements=[
                "tenant_id",
                "metric",
                "bucket_start",
                "client_id",
                "model",
            ],
            set_={"amount": TenantUsage.amount + statement.excluded.amount},
        )
        await session.execute(statement)

    async def totals(
        self,
        session: AsyncSession,
        *,
        tenant_id: str,
        since: datetime,
        until: datetime,
    ) -> list[UsageTotal]:
        """Totals per metric, consumer and model for buckets in `[since, until)`.

        Buckets are whole hours, so `since` is rounded down to the hour it
        falls in and a bucket counts if it starts before `until`.

        Names the tenant explicitly as well as relying on the bound session:
        the policy does not apply on an owner connection, and a fan-out that
        leaned on it alone would count every tenant's rows as this one's.
        """
        rows = await session.execute(
            select(
                TenantUsage.metric,
                TenantUsage.client_id,
                Client.display_name,
                Client.type,
                TenantUsage.model,
                func.sum(TenantUsage.amount),
            )
            .outerjoin(
                Client,
                and_(
                    Client.id == TenantUsage.client_id,
                    Client.tenant_id == TenantUsage.tenant_id,
                ),
            )
            .where(
                TenantUsage.tenant_id == tenant_id,
                TenantUsage.bucket_start >= func.date_trunc("hour", since, "UTC"),
                TenantUsage.bucket_start < until,
            )
            .group_by(
                TenantUsage.metric,
                TenantUsage.client_id,
                Client.display_name,
                Client.type,
                TenantUsage.model,
            )
            .order_by(TenantUsage.metric, TenantUsage.client_id, TenantUsage.model)
        )
        return [
            UsageTotal(
                metric=metric,
                client_id=client_id,
                client_name=client_name,
                client_type=client_type,
                model=model,
                amount=int(amount),
            )
            for metric, client_id, client_name, client_type, model, amount in rows
        ]
