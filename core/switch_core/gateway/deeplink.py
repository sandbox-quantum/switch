from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse

from switch_core.config import SwitchConfig
from switch_core.deeplinks import gateway_query_to_switchdash
from switch_core.gateway.dependencies import get_config

router = APIRouter()


@router.get("/deeplink/session")
async def redirect_session_deeplink(
    request: Request,
    _config: Annotated[SwitchConfig, Depends(get_config)],
) -> RedirectResponse:
    """302-redirect to the `switchdash://session?…` deeplink.

    Platforms that only linkify http(s) (Discord, …) can't render the raw
    custom-scheme deeplink, so the bridge posts this https URL instead and the
    click lands here. The incoming query string is carried across verbatim; the
    scheme and host of the target are fixed constants, so this cannot be coerced
    into an open redirect. Public by design — the link is followed by whoever
    clicks it in the external channel.
    """
    target = gateway_query_to_switchdash(request.url.query)
    return RedirectResponse(url=target, status_code=302)
