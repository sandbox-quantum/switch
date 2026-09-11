"""The public half of an install: the callback the platform redirects back to.

Mounted on the agent-bridge app rather than inside `/gateway`, because this is
the leg the outside world reaches. `/gateway` is not routed here from the
public load balancer at all, and it would not help if it were — it is
cookie-authenticated and this caller has no cookie of ours.

**The reply is a page, not a redirect.** Sending the browser on to the gateway
would work today, when the person installing is an operator who can reach it,
and would break the moment the same flow is offered to a customer who cannot:
the gateway is on a private hostname and the callback is not. So the outcome is
rendered here, in one self-contained page, on the origin the browser already
reached. It is deliberately plain; when there is a place to send people, this
becomes a redirect and the page becomes its fallback.
"""

from __future__ import annotations

import html
import logging

from fastapi import APIRouter, Query
from starlette.responses import HTMLResponse

from switch_core.bridges.collaboration.install import (
    PUBLIC_PATH_PREFIX,
    MessagingInstallError,
)
from switch_core.bridges.collaboration.install_service import (
    InstallPlatformMismatch,
    MessagingInstallService,
)
from switch_core.bridges.collaboration.install_state import InstallStateError
from switch_core.db.stores.messaging_install_store import (
    MessagingInstallClaimedError,
    MessagingInstallStateError,
)

logger = logging.getLogger(__name__)

_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{title}</title>
<style>
 body {{ font: 16px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 34rem;
        padding: 0 1rem; color: #1a1a1a; }}
 h1 {{ font-size: 1.25rem; }}
 p {{ color: #444; }}
</style></head>
<body><h1>{title}</h1><p>{detail}</p></body></html>
"""


def _page(*, title: str, detail: str, status: int) -> HTMLResponse:
    return HTMLResponse(
        _PAGE.format(title=html.escape(title), detail=html.escape(detail)),
        status_code=status,
    )


def create_messaging_install_router(
    service: MessagingInstallService,
) -> APIRouter:
    """Build the public install routes over one already-configured service.

    A factory closing over the service rather than a module-level router with
    dependencies, because this app has no dependency-injection module of its
    own and adding one for a single object would be the larger change.
    """
    router = APIRouter(prefix=PUBLIC_PATH_PREFIX)

    @router.get("/{platform}/oauth/callback")
    async def oauth_callback(
        platform: str,
        code: str | None = Query(default=None),
        state: str | None = Query(default=None),
        error: str | None = Query(default=None),
    ) -> HTMLResponse:
        # The platform's own refusal, which is usually the customer deciding
        # not to install after all. Nothing went wrong here and nothing was
        # written; saying so is the whole handling.
        if error:
            return _page(
                title="Install cancelled",
                detail=f"{platform} reported: {error}. Nothing was connected.",
                status=200,
            )

        if not code or not state:
            return _page(
                title="Install could not be completed",
                detail=(
                    f"{platform} did not send back everything this needs. Start "
                    "the install again from Switch."
                ),
                status=400,
            )

        try:
            install = await service.complete(
                platform=platform, code=code, state_token=state
            )
        except (InstallStateError, InstallPlatformMismatch) as failure:
            # Unauthenticated input, so the reply says nothing the caller did
            # not already know. The reason goes to the log, at warning: a
            # forged state is worth noticing and is not worth an alert.
            logger.warning("Refused a %s install callback: %s", platform, failure)
            return _page(
                title="Install could not be completed",
                detail=(
                    "This install link is not one Switch recognises. Start the "
                    "install again from Switch."
                ),
                status=400,
            )
        except MessagingInstallStateError as failure:
            return _page(
                title="Install link already used",
                detail=str(failure),
                status=400,
            )
        except MessagingInstallClaimedError as failure:
            return _page(
                title="Workspace already connected",
                detail=str(failure),
                status=409,
            )
        except MessagingInstallError as failure:
            return _page(
                title="Install could not be completed",
                detail=str(failure),
                status=400,
            )

        return _page(
            title="Switch is connected",
            detail=(
                f"The {platform} workspace {install.external_workspace_id} is "
                "connected to Switch. You can close this page and finish setting "
                "it up there."
            ),
            status=200,
        )

    return router
