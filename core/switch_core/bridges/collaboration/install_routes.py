"""The public half of an install: the OAuth callback, and the events after it.

Everything here is unauthenticated in the sense that matters — no caller holds
a credential of ours. A browser mid-redirect proves itself with a state we
signed; a platform posting an event proves itself with a signature over the
raw body. Neither is a session, and nothing here may assume a tenant before it
has established one.

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

The event routes answer nobody who reads English, so they answer in status
codes and say the rest in the log.
"""

from __future__ import annotations

import html
import logging

from fastapi import APIRouter, BackgroundTasks, Query, Request, Response
from starlette.responses import HTMLResponse, PlainTextResponse

from switch_core.bridges.collaboration.install import (
    PUBLIC_PATH_PREFIX,
    InboundWebhook,
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookEndpoint,
    WebhookPayloadError,
)
from switch_core.bridges.collaboration.install_service import (
    InstallPlatformMismatch,
    MessagingInstallService,
    WebhookBridgeUnavailable,
    WebhookTarget,
    WebhookWorkspaceUnknown,
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

    async def _deliver(target: WebhookTarget, event: InboundWebhook) -> None:
        """Handle one event after the platform has been answered.

        Its own wrapper so a failure is logged here rather than raised into the
        server's background-task machinery, where it would surface — if at all
        — as an unattributed traceback with nothing in it naming the bridge.
        """
        try:
            await service.deliver(target, event)
        except Exception:
            logger.exception(
                "Failed to handle a %s event for bridge %s (tenant %s)",
                event.envelope_type,
                target.bridge_id,
                target.tenant_id,
            )

    async def _inbound(
        platform: str,
        endpoint: WebhookEndpoint,
        request: Request,
        background: BackgroundTasks,
    ) -> Response:
        """One verified event, from any of a platform's three inbound URLs.

        The status codes are read by the platform, not by a person, and they
        are chosen for what it does with them. Slack retries a 5xx and gives up
        on a 4xx, and counts failures against the app as a whole — so a
        permanent condition must not look transient, and a transient one must
        not look permanent.
        """
        body = await request.body()
        try:
            event = service.authenticate(
                platform=platform,
                endpoint=endpoint,
                headers=dict(request.headers),
                body=body,
            )
        except MessagingInstallError:
            # No app registered for this platform, so nothing here could have
            # signed anything. Not found rather than an explanation: the caller
            # is unauthenticated and learns only that there is nothing here.
            return Response(status_code=404)
        except WebhookAuthenticityError as failure:
            logger.warning("Refused an unverified %s webhook: %s", platform, failure)
            return Response(status_code=401)
        except WebhookPayloadError as failure:
            # Verified, so this really is the platform sending something this
            # build cannot read. Worth an error rather than a shrug — it is how
            # a platform's change to its own payloads first becomes visible.
            logger.error("Could not read a verified %s webhook: %s", platform, failure)
            return Response(status_code=400)

        if event.handshake is not None:
            logger.info("Answered a %s URL verification", platform)
            return PlainTextResponse(event.handshake)

        try:
            target = await service.resolve(platform=platform, event=event)
        except WebhookPayloadError as failure:
            logger.error(
                "A verified %s event named no workspace: %s", platform, failure
            )
            return Response(status_code=400)
        except WebhookWorkspaceUnknown as failure:
            logger.warning("Dropped a %s event: %s", platform, failure)
            return Response(status_code=404)
        except WebhookBridgeUnavailable as failure:
            # Deliberately a 503: the platform retrying is the right behaviour
            # while a bridge restarts, and a 200 here would drop a real message
            # on the floor and report that it had been handled.
            logger.error("Could not deliver a %s event: %s", platform, failure)
            return Response(status_code=503)

        # Answered first, handled after. The platform's deadline is short and
        # what happens next is not bounded by it — a turn can take minutes —
        # so acknowledging on the way out is what keeps a slow room from
        # becoming a retried, duplicated one.
        background.add_task(_deliver, target, event)
        return Response(status_code=200)

    @router.post("/{platform}/events")
    async def events(
        platform: str, request: Request, background: BackgroundTasks
    ) -> Response:
        return await _inbound(platform, "events", request, background)

    @router.post("/{platform}/interactive")
    async def interactive(
        platform: str, request: Request, background: BackgroundTasks
    ) -> Response:
        """Interactions with a message this app posted.

        Routed like any other event and, on Slack today, handled by nothing:
        the app declares an interactivity URL because features it does use
        require one, and its stop button arrives as an ordinary event instead.
        The route exists because the URL is declared — a declared URL that 404s
        counts against the app — and because the alternative is deciding here,
        rather than in the adapter, what a platform's interactions mean.
        """
        return await _inbound(platform, "interactive", request, background)

    @router.post("/{platform}/commands")
    async def commands(
        platform: str, request: Request, background: BackgroundTasks
    ) -> Response:
        return await _inbound(platform, "commands", request, background)

    return router
