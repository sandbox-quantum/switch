"""Whether this server runs hosted agents: Core's one answer to "is there a
box cluster to run them on?".

Hosted agents are per-person boxes on a shared cluster. A server has a box
cluster when its hosted controller config (`HOSTED_CONTROLLER_CONFIG_PATH`)
is loaded and carries `provisioner_token`, the box operator's own bearer (only
a server with a box operator holds one), and the keyed-id key is loaded: the
operator's views, actions and alerts name boxes and people only by keyed id,
and without it some would stop raising anything. Without both, hosted agents
are off:
nobody can claim a cloud machine and every box route answers as a route that
isn't there.

The app records the answer once at start (`set_box_cluster`), from the
settings it loads, for every check that runs later.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)

_process_on = False


def _names_a_box_operator(settings: Any) -> bool:
    """A provisioner token of at least the config's bearer length. The config
    reads an empty or short one as none (`HostedControllerSettings`); this
    checks again, so a settings object made any other way can't be partly on."""
    from switch_core.providers.hosted import MIN_BEARER_LENGTH

    token = (
        getattr(settings, "provisioner_token", None) if settings is not None else None
    )
    if token is None:
        return False
    value = token.get_secret_value() if hasattr(token, "get_secret_value") else token
    return isinstance(value, str) and len(value.strip()) >= MIN_BEARER_LENGTH


def box_cluster_configured(settings: Any, keyed_id_key: Any) -> bool:
    """Whether this server has a box cluster: settings naming the box operator,
    and the keyed-id key loaded."""
    return _names_a_box_operator(settings) and keyed_id_key is not None


def box_cluster_at_boot(config: Any) -> bool:
    """The answer boot needs before the gateway app is built (awake budgets,
    the background sweeps), from the same two files the gateway reads and the
    same rule (`box_cluster_configured`), so the two can't disagree."""
    from switch_core.providers.hosted import load_hosted_settings
    from switch_core.visibility.dependencies import load_keyed_id_key

    return box_cluster_configured(
        load_hosted_settings(config.hosted_controller_config_path),
        load_keyed_id_key(config),
    )


def set_box_cluster(settings: Any, keyed_id_key: Any) -> bool:
    """Record this process's answer, once at start; returns it. Logged at every
    start, so the state a server ran with is on record, with a warning when
    the box operator is named but the keyed-id key is missing."""
    global _process_on
    _process_on = box_cluster_configured(settings, keyed_id_key)
    if _names_a_box_operator(settings) and keyed_id_key is None:
        logger.warning(
            "The hosted controller config names a box operator, but no keyed-id "
            "key is loaded (VISIBILITY_KEYED_ID_KEY_PATH), so hosted agents are "
            "off: the operator's views, actions and alerts need it."
        )
    logger.info(
        "Hosted agents are %s.",
        "on: a box cluster is configured"
        if _process_on
        else "off: no box cluster is configured",
    )
    return _process_on


def box_cluster_on() -> bool:
    """This process's answer; off until `set_box_cluster` has run."""
    return _process_on


async def require_box_cluster() -> None:
    """A route dependency for every box route: with no box cluster it answers
    exactly as a route that doesn't exist (404, "Not Found"), before any
    authentication, lookup or write. Put it on the router, so it runs first."""
    if not _process_on:
        raise HTTPException(404, "Not Found")


async def require_box_cluster_here() -> None:
    """`require_box_cluster` for routes outside the gateway (the controllers'
    own API), on the same answer."""
    if not _process_on:
        raise HTTPException(404, "Not Found")


async def controller_backend(
    session: Any, tenant_id: str, controller_id: str
) -> str | None:
    """`vm` or `box` for the cloud machine a controller enrolled as, or None for
    a controller on no cloud machine (a person's own computer). Read from the
    database, never from anything the controller says."""
    from sqlalchemy import select

    from switch_core.db.models import CloudMachine, MachineWorkspace

    backend: str | None = await session.scalar(
        select(CloudMachine.backend)
        .join(MachineWorkspace, MachineWorkspace.machine_id == CloudMachine.id)
        .where(
            MachineWorkspace.tenant_id == tenant_id,
            MachineWorkspace.controller_id == controller_id,
        )
    )
    return backend


async def on_box(session: Any, tenant_id: str, controller_id: str) -> bool:
    """Whether the controller runs on a box: the gate for box-only behaviour."""
    return await controller_backend(session, tenant_id, controller_id) == "box"
