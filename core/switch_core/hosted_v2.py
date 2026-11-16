"""The v1/v2 switch: Core's one answer to "is hosted agents v2 on?".

v2 is the shared cluster of per-person boxes (box provisioning, the visibility
screens and operator routes, and the box-only behaviour around them). It is on
only when `HOSTED_BOX_PROVISIONING` is true. Anything else, an unset value, a
misspelling, a hand-built config without the field, reads as off: v1 hosted
agents (one VM per person) then behave exactly as before v2's pieces.

Every gate asks `hosted_v2_on(config)`. Code deep in a request or a background
loop, with no config to hand, asks `process_hosted_v2()`, the copy the app
records once at start from the same function. Before that it is off. Clients
read the answer from the feature-flags response (`hosted_v2`) and never work it
out themselves. No screen or API can change it, only the server's setting.
"""

from __future__ import annotations

import logging
from typing import Annotated, Any

from fastapi import Depends, HTTPException

logger = logging.getLogger(__name__)

#: The key clients read in `GET /feature-flags`. Not a settable flag: it is
#: derived, so `FEATURE_FLAGS_ENABLED` naming it is refused as unknown.
HOSTED_V2_FLAG = "hosted_v2"

_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"", "0", "false", "no", "off"})

_process_on = False


def _config() -> Any:
    """The server's config, as every route reads it (`get_config`); None when
    none is recorded, which reads as off."""
    from switch_core.gateway.dependencies import get_config

    try:
        return get_config()
    except Exception:
        return None


def parse_box_provisioning(value: Any) -> bool:
    """`HOSTED_BOX_PROVISIONING` read fail-closed: only a clear yes is on. A
    value that isn't a clear yes or no is off, with a warning that names the
    setting but never echoes the value."""
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower() if value is not None else ""
    if text in _TRUE:
        return True
    if text not in _FALSE:
        logger.warning(
            "HOSTED_BOX_PROVISIONING isn't true or false; hosted agents v2 is off."
        )
    return False


def hosted_v2_on(config: Any) -> bool:
    """Whether hosted agents v2 is on for this server. Read defensively: a
    config without the field, or with anything but a real True, is off."""
    return getattr(config, "hosted_box_provisioning", False) is True


def set_process_hosted_v2(config: Any) -> bool:
    """Record this process's answer, once at start, for code with no config to
    hand; returns it. Logged at every start, so the setting a server ran with
    is on record."""
    global _process_on
    _process_on = hosted_v2_on(config)
    logger.info("Hosted agents v2 is %s.", "on" if _process_on else "off")
    return _process_on


def process_hosted_v2() -> bool:
    """This process's answer; off until `set_process_hosted_v2` has run."""
    return _process_on


async def require_hosted_v2(
    config: Annotated[Any, Depends(_config)],
) -> None:
    """A route dependency for every v2-only route: with v2 off it answers
    exactly as a route that doesn't exist (404, "Not Found"), before any
    authentication, lookup or write. Put it on the router, so it runs first."""
    if not hosted_v2_on(config):
        raise HTTPException(404, "Not Found")


async def require_hosted_v2_here() -> None:
    """`require_hosted_v2` for routes outside the gateway (the controllers'
    own API): the process's answer, set at start from the same function."""
    if not process_hosted_v2():
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


async def v2_box(session: Any, tenant_id: str, controller_id: str) -> bool:
    """The gate for v2's box-only behaviour: hosted agents v2 on and the
    controller on a box. With v2 off, no read at all, as before v2."""
    if not process_hosted_v2():
        return False
    return await controller_backend(session, tenant_id, controller_id) == "box"
