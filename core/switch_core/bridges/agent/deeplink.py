from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import RedirectResponse

from switch_core.deeplinks import gateway_query_to_switchdash

router = APIRouter()


@router.get("/deeplink/session")
async def redirect_session_deeplink(request: Request) -> RedirectResponse:
    """302-redirect to the `switchdash://session?…` deeplink.

    Platforms that only linkify http(s) (Discord, …) can't render the raw
    custom-scheme deeplink, so the bridge posts this https URL instead and the
    click lands here. The incoming query string is carried across verbatim; the
    scheme and host of the target are fixed constants, so this cannot be coerced
    into an open redirect. Public by design — the link is followed by whoever
    clicks it in the external channel, and it serves no data beyond the redirect
    (its `/deeplink` prefix is in the Bearer middleware's public allowlist).
    """
    target = gateway_query_to_switchdash(request.url.query)
    return RedirectResponse(url=target, status_code=302)
