"""The warm pool's provisioner, scaler and reaper interfaces, as the box side
builds against them: per-claim `capabilities` decide each action's kind and
namespace (fixed when first handed out), a long-poll claim, the re-check and
the write-ahead `owner_writing` step, pool results, the scaler's pool list,
and the reaper's two routes on their own bearer. Against Postgres."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import SecretStr
from sqlalchemy import select, update

from switch_core.db.audit import ServerAuditAction, record_server_audit_event
from switch_core.db.models import HostedPoolBox, ServerAuditEvent
from switch_core.db.stores import hosted_pool_store
from switch_core.providers.hosted import HostedControllerSettings
from switch_core.visibility.box_provision import (
    TTL,
    box_namespace_for,
    namespace_for,
    refill_pool,
)
from switch_core.visibility.keyed_id import KeyedIdKind
from tests.switch_core.gateway.test_hosted_provisioner import (  # noqa: F401
    KEY,
    PROVISIONER,
    TOKEN,
    _ask,
    _bearer,
    _entries,
    provisioner_app,
)

REAPER = "SYNTHETIC-POOL-REAPER-CREDENTIAL-0123456789abc"
CAPABLE = {
    "template_revision": "r7",
    "capabilities": ["box_keyed_names", "pool", "bind"],
}


async def _claim(app, body: dict | None = None, wait_s: int = 0):
    return await app.client.post(
        f"/hosted-provisioner/claim?wait_s={wait_s}",
        headers=_bearer(PROVISIONER),
        **({"json": body} if body is not None else {}),
    )


async def _expire_lease(app) -> None:
    """Every claimed lease is over: the action can be claimed again."""
    async with app.factory() as session:
        rows = await session.scalars(
            select(ServerAuditEvent).where(
                ServerAuditEvent.details["step"].astext == "claimed"
            )
        )
        for row in rows:
            details = dict(row.details or {})
            details["lease_until"] = (
                datetime.now(UTC) - timedelta(seconds=1)
            ).isoformat()
            row.details = details
        await session.commit()


def _box_keyed(machine_id: str) -> str:
    return KEY.keyed_id(KeyedIdKind.BOX, machine_id)


# ── capabilities and the namespace ──


async def test_an_operator_with_no_capabilities_gets_todays_action(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    claimed = await _claim(app)  # no body, as an operator from before
    assert claimed.status_code == 200, claimed.text
    body = claimed.json()
    assert body["kind"] == "provision"
    assert body["box_keyed_id"] == _box_keyed(app.machine_id)
    assert body["namespace"] == namespace_for(body["user_keyed_id"])


async def test_a_capable_operator_gets_a_box_keyed_name_fixed_across_a_retry(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    first = (await _claim(app, CAPABLE)).json()
    assert first["namespace"] == box_namespace_for(_box_keyed(app.machine_id))
    assert first["namespace"].startswith("agents-box-k1-")
    await _expire_lease(app)
    # An operator that can't make box-keyed names doesn't get it back.
    assert (await _claim(app)).status_code == 204
    again = (await _claim(app, CAPABLE)).json()
    assert again["action_id"] == first["action_id"]
    assert again["namespace"] == first["namespace"]


async def test_a_revived_box_keeps_its_person_keyed_name(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    async with app.factory() as session:
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_REVIVED,
            target_type="box",
            target_id=_box_keyed(app.machine_id),
            details={"by": "core", "machine_id": app.machine_id},
        )
        await session.commit()
    await _ask(
        app.factory, app.machine_id, now=datetime.now(UTC) + timedelta(seconds=1)
    )
    body = (await _claim(app, CAPABLE)).json()
    assert body["namespace"] == namespace_for(body["user_keyed_id"])


async def test_a_result_must_name_the_issued_namespace(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    body = (await _claim(app, CAPABLE)).json()
    wrong = await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "done",
            "namespace": namespace_for(body["user_keyed_id"]),
            "claim_token": body["claim_token"],
        },
    )
    assert wrong.status_code == 422
    right = await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "done",
            "namespace": body["namespace"],
            "claim_token": body["claim_token"],
        },
    )
    assert right.status_code == 204, right.text


async def test_a_bind_failure_word_is_refused_on_a_provision(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    body = (await _claim(app, CAPABLE)).json()
    refused = await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "failed",
            "namespace": body["namespace"],
            "failed_at": "bind_closed",
            "claim_token": body["claim_token"],
        },
    )
    assert refused.status_code == 422


# ── the long-poll ──


async def test_the_long_poll_waits_then_answers_204(provisioner_app) -> None:  # noqa: F811
    app = provisioner_app
    started = datetime.now(UTC)
    answer = await _claim(app, CAPABLE, wait_s=1)
    assert answer.status_code == 204
    assert datetime.now(UTC) - started >= timedelta(seconds=1)


async def test_the_long_poll_answers_as_soon_as_an_action_opens(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app

    async def ask_soon() -> None:
        await asyncio.sleep(0.3)
        await _ask(app.factory, app.machine_id)

    asking = asyncio.create_task(ask_soon())
    answer = await _claim(app, CAPABLE, wait_s=10)
    await asking
    assert answer.status_code == 200, answer.text


async def test_each_claim_records_the_operators_report(provisioner_app) -> None:  # noqa: F811
    app = provisioner_app
    await _claim(app, {"template_revision": "r9", "capabilities": ["pool", "nonsense"]})
    async with app.factory() as session:
        report = await hosted_pool_store.operator(session)
    assert report is not None
    assert (report.template_revision, report.capabilities) == ("r9", ["pool"])


# ── the pool ──


async def _refill(app, size: int = 1) -> list[str]:
    app.config.hosted_pool_size = size
    from switch_core.visibility.dependencies import set_process_keyed_id_key

    set_process_keyed_id_key(KEY)
    return await refill_pool(app.factory, app.config, datetime.now(UTC))


async def test_refill_waits_for_a_capable_operator(provisioner_app) -> None:  # noqa: F811
    app = provisioner_app
    assert await _refill(app) == []  # nobody has polled
    await _claim(app, {"capabilities": ["box_keyed_names"]})
    assert await _refill(app) == []  # polled, but can't make pool boxes
    await _claim(app, CAPABLE)
    made = await _refill(app, size=2)
    assert len(made) == 2
    assert await _refill(app, size=2) == []  # requested ones count


async def test_a_pool_action_goes_only_to_a_pool_capable_operator(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _claim(app, CAPABLE)
    (box_id,) = await _refill(app)
    assert (await _claim(app, {"capabilities": ["box_keyed_names"]})).status_code == 204
    body = (await _claim(app, CAPABLE)).json()
    assert (body["kind"], body["machine_id"], body["user_keyed_id"]) == (
        "pool",
        box_id,
        None,
    )
    assert body["namespace"] == box_namespace_for(_box_keyed(box_id))
    done = await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "done",
            "namespace": body["namespace"],
            "claim_token": body["claim_token"],
        },
    )
    assert done.status_code == 204, done.text
    async with app.factory() as session:
        row = await hosted_pool_store.get(session, box_id)
    assert row is not None
    assert (row.state, row.namespace, row.template_revision) == (
        "waiting",
        body["namespace"],
        "r7",
    )


async def test_a_pool_box_not_made_retires_reapable(provisioner_app) -> None:  # noqa: F811
    app = provisioner_app
    await _claim(app, CAPABLE)
    (box_id,) = await _refill(app)
    body = (await _claim(app, CAPABLE)).json()
    await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "failed",
            "namespace": body["namespace"],
            "failed_at": "object_refused",
            "claim_token": body["claim_token"],
        },
    )
    async with app.factory() as session:
        row = await hosted_pool_store.get(session, box_id)
    assert row is not None and (row.state, row.retire_reason) == (
        "retiring",
        "make_failed",
    )


@pytest.mark.usefixtures("hosted_v2_on")
async def test_the_scaler_lists_pool_boxes_with_no_owner(provisioner_app) -> None:  # noqa: F811
    from tests.switch_core.gateway.test_hosted_controller import HEADERS

    app = provisioner_app
    await _claim(app, CAPABLE)
    (box_id,) = await _refill(app)
    listed = await app.client.get("/hosted-controller/pool", headers=HEADERS)
    assert listed.status_code == 200, listed.text
    assert listed.json() == {
        "boxes": [
            {
                "pool_box_id": box_id,
                "namespace": None,
                "template_revision": None,
                "desired_state": "running",
            }
        ]
    }
    refused = await app.client.get(
        "/hosted-controller/pool", headers=_bearer(PROVISIONER)
    )
    assert refused.status_code == 401


# ── the reaper ──


def _with_reaper(app) -> None:
    app.settings.reaper_token = SecretStr(REAPER)


async def _retire(app, box_id: str, reason: str = "age") -> None:
    async with app.factory() as session:
        await session.execute(
            update(HostedPoolBox)
            .where(HostedPoolBox.id == box_id)
            .values(
                state="retiring", retire_reason=reason, retired_at=datetime.now(UTC)
            )
        )
        await session.commit()


async def test_the_reaper_lists_and_reports_only_reapable_boxes(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    _with_reaper(app)
    await _claim(app, CAPABLE)
    keep, reap = await _refill(app, size=2)
    await _retire(app, reap)
    listed = await app.client.get(
        "/hosted-provisioner/pool/retiring", headers=_bearer(REAPER)
    )
    assert listed.status_code == 200, listed.text
    assert [b["pool_box_id"] for b in listed.json()["boxes"]] == [reap]
    refused = await app.client.post(
        f"/hosted-provisioner/pool/{keep}/gone", headers=_bearer(REAPER)
    )
    assert refused.status_code == 409  # never retired
    gone = await app.client.post(
        f"/hosted-provisioner/pool/{reap}/gone", headers=_bearer(REAPER)
    )
    assert gone.status_code == 204, gone.text
    async with app.factory() as session:
        row = await hosted_pool_store.get(session, reap)
        retired = await session.scalar(
            select(ServerAuditEvent).where(
                ServerAuditEvent.action == ServerAuditAction.HOSTED_POOL_BOX_RETIRED
            )
        )
    assert row is not None and row.state == "gone"
    assert retired is not None and retired.details["reason"] == "age"


async def test_gone_is_refused_for_a_box_whose_bind_reached_its_owner(
    provisioner_app,  # noqa: F811
) -> None:
    """Core marked it reapable, but a bind of it recorded `owner_writing`:
    the box is the person's, and the reaper is refused."""
    app = provisioner_app
    _with_reaper(app)
    await _claim(app, CAPABLE)
    (box_id,) = await _refill(app)
    async with app.factory() as session:
        bind = await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=_box_keyed(box_id),
            details={"phase": "requested", "kind": "bind", "machine_id": box_id},
        )
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=_box_keyed(box_id),
            details={
                "phase": "progress",
                "step": "owner_writing",
                "linked_to": bind.id,
            },
        )
        await session.commit()
    await _retire(app, box_id, "failed_before_owner")
    refused = await app.client.post(
        f"/hosted-provisioner/pool/{box_id}/gone", headers=_bearer(REAPER)
    )
    assert refused.status_code == 409


async def test_the_reaper_has_its_own_bearer_and_nothing_else(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    listed = await app.client.get(
        "/hosted-provisioner/pool/retiring", headers=_bearer(REAPER)
    )
    assert listed.status_code == 401  # no reaper_token configured
    _with_reaper(app)
    for bearer in (PROVISIONER, TOKEN):
        assert (
            await app.client.get(
                "/hosted-provisioner/pool/retiring", headers=_bearer(bearer)
            )
        ).status_code == 401
    assert (
        await app.client.post("/hosted-provisioner/claim", headers=_bearer(REAPER))
    ).status_code == 401
    with pytest.raises(ValueError, match="separate identity"):
        HostedControllerSettings(
            allowed_tenant_ids=None,
            token=TOKEN,
            provisioner_token=PROVISIONER,
            reaper_token=PROVISIONER,
            agent_api_endpoint="https://switch.example.com/api/agent",
        )


# ── the re-check and the write-ahead step ──


async def _bind_action(app, box_id: str) -> dict:
    """A bind request for a claimed pool box (its machine row has the pool
    box's id, as T1 makes it), claimed by a capable operator."""
    async with app.factory() as session:
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=_box_keyed(box_id),
            details={
                "phase": "requested",
                "by": "core",
                "kind": "bind",
                "machine_id": box_id,
                "user": "k1-0000000000000000",
                "expires_at": (datetime.now(UTC) + TTL).isoformat(),
            },
        )
        await session.commit()
    body = (await _claim(app, CAPABLE)).json()
    assert body["kind"] == "bind"
    return body


async def test_owner_writing_is_accepted_only_while_the_bind_is_open(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _claim(app, CAPABLE)
    body = await _bind_action(app, app.machine_id)
    url = f"/hosted-provisioner/actions/{body['action_id']}"
    is_open = await app.client.get(
        url, headers={**_bearer(PROVISIONER), "X-Claim-Token": body["claim_token"]}
    )
    assert is_open.json() == {"open": True}
    wrong = await app.client.get(
        url, headers={**_bearer(PROVISIONER), "X-Claim-Token": "nope"}
    )
    assert wrong.json() == {"open": False}
    stale = await app.client.post(
        f"{url}/steps",
        headers={**_bearer(PROVISIONER), "X-Claim-Token": "an-older-claim"},
        json={"step": "owner_writing"},
    )
    assert stale.status_code == 409
    step = await app.client.post(
        f"{url}/steps",
        headers={**_bearer(PROVISIONER), "X-Claim-Token": body["claim_token"]},
        json={"step": "owner_writing"},
    )
    assert step.status_code == 204, step.text
    steps = [
        e
        for e in await _entries(app.factory)
        if (e.details or {}).get("step") == "owner_writing"
    ]
    assert len(steps) == 1


async def test_owner_writing_is_refused_once_the_bind_has_a_result(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _claim(app, CAPABLE)
    body = await _bind_action(app, app.machine_id)
    await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/result",
        headers=_bearer(PROVISIONER),
        json={
            "result": "failed",
            "namespace": body["namespace"],
            "failed_at": "bind_closed",
            "claim_token": body["claim_token"],
        },
    )
    refused = await app.client.post(
        f"/hosted-provisioner/actions/{body['action_id']}/steps",
        headers={**_bearer(PROVISIONER), "X-Claim-Token": body["claim_token"]},
        json={"step": "owner_writing"},
    )
    assert refused.status_code == 409


async def test_a_bind_or_pool_action_never_goes_to_an_old_operator(
    provisioner_app,  # noqa: F811
) -> None:
    app = provisioner_app
    await _claim(app, CAPABLE)
    await _refill(app)
    async with app.factory() as session:
        await record_server_audit_event(
            session,
            actor_user_id=None,
            action=ServerAuditAction.HOSTED_BOX_PROVISION,
            target_type="box",
            target_id=_box_keyed("00000000-0000-4000-8000-000000000003"),
            details={
                "phase": "requested",
                "kind": "bind",
                "machine_id": "00000000-0000-4000-8000-000000000003",
                "user": "k1-0000000000000000",
            },
        )
        await session.commit()
    assert (await _claim(app)).status_code == 204
    assert (await _claim(app, {"capabilities": ["box_keyed_names"]})).status_code == 204


async def test_the_claim_token_reaches_no_log_on_either_route(
    provisioner_app,  # noqa: F811
    caplog,
) -> None:
    import logging

    app = provisioner_app
    await _claim(app, CAPABLE)
    body = await _bind_action(app, app.machine_id)
    token = body["claim_token"]
    url = f"/hosted-provisioner/actions/{body['action_id']}"
    headers = {**_bearer(PROVISIONER), "X-Claim-Token": token}
    with caplog.at_level(logging.DEBUG):
        await app.client.get(url, headers=headers)
        await app.client.post(
            f"{url}/steps", headers=headers, json={"step": "owner_writing"}
        )
        await app.client.post(
            f"{url}/steps",
            headers={**_bearer(PROVISIONER), "X-Claim-Token": token + "x"},
            json={"step": "owner_writing"},
        )
    assert caplog.records  # something was logged to look through
    for record in caplog.records:
        assert token not in record.getMessage()
        assert token not in repr(record.__dict__)


async def test_a_fixed_name_holds_with_no_memory_of_the_claim(
    provisioner_app,  # noqa: F811
) -> None:
    """The name lives on the action's `claimed` entry, not in any process:
    claiming again from a brand-new session (as a restarted Core would)
    after the lease runs out gives the same name, even to an operator that
    lists nothing new."""
    from switch_core.visibility.box_provision import claim_provision

    app = provisioner_app
    await _ask(app.factory, app.machine_id)
    first = (await _claim(app, CAPABLE)).json()
    await _expire_lease(app)
    async with app.factory() as fresh:
        again = await claim_provision(
            fresh,
            datetime.now(UTC),
            capabilities=frozenset({"box_keyed_names"}),
        )
        await fresh.commit()
    assert again is not None
    assert (again.action_id, again.namespace) == (
        first["action_id"],
        first["namespace"],
    )
