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

import asyncio
import functools
import html
import logging
from typing import Annotated, Any, Literal

from fastapi import APIRouter, BackgroundTasks, Form, Query, Request, Response
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse

from switch_core.bridges.collaboration.install import (
    PUBLIC_PATH_PREFIX,
    InboundWebhook,
    InstallClaim,
    MessagingInstallError,
    WebhookAuthenticityError,
    WebhookEndpoint,
    WebhookPayloadError,
    WebhookVerificationUnavailable,
    oauth_confirm_path,
)
from switch_core.bridges.collaboration.install_confirmation import (
    InstallTicketError,
)
from switch_core.bridges.collaboration.install_service import (
    InstallClaimNotPermitted,
    InstallPlatformMismatch,
    MessagingInstallService,
    PendingInstall,
    Revocation,
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

#: How long an event the platform waits on may take before it is answered as
#: failed. Under the platforms' own limits — Teams gives up on a card press
#: after about fifteen seconds — so the answer that says it failed is the one
#: the person sees, rather than the platform's own timeout.
_INLINE_ANSWER_SECONDS = 10.0

#: Inline handling that outran its deadline and is still finishing. Held so
#: the task is not collected mid-way, and dropped as each one ends.
_finishing: set[asyncio.Task[dict[str, Any] | None]] = set()


def _finished_late(
    target: WebhookTarget,
    envelope_type: str,
    task: asyncio.Task[dict[str, Any] | None],
) -> None:
    _finishing.discard(task)
    if task.cancelled():
        return
    error = task.exception()
    if error is not None:
        logger.error(
            "A %s %s event for bridge %s failed after its answer was sent",
            target.platform,
            envelope_type,
            target.bridge_id,
            exc_info=error,
        )


_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>{title}</title>
<style>
 body {{ font: 16px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 34rem;
        padding: 0 1rem; color: #1a1a1a; }}
 h1 {{ font-size: 1.25rem; }}
 p {{ color: #444; }}
</style></head>
<body><h1>{title}</h1><p>{detail}</p>{extra}</body></html>
"""

_CONFIRM_FORM = """<dl>
 <dt>{platform} workspace</dt><dd>{workspace}</dd>
 <dt>Switch organisation</dt><dd>{organisation}</dd>
 <dt>Requested by</dt><dd>{requested_by}</dd>
</dl>
<form method="post" action="{action}">
 <input type="hidden" name="ticket" value="{ticket}">
 <button type="submit" name="decision" value="connect">Connect</button>
 <button type="submit" name="decision" value="cancel">Cancel</button>
</form>
<p>If you do not recognise this organisation or the person who requested it,
choose Cancel. Closing this page connects nothing, but leaves the app in your
workspace until you remove it there.</p>
"""

#: Every page here is a decision or the outcome of one; none may be framed by
#: another site (a framed Connect button is a clickjacking target), cached, or
#: leak the callback's query string as a referrer.
_PAGE_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; "
        "frame-ancestors 'none'; base-uri 'none'"
    ),
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
}


def _page(*, title: str, detail: str, status: int, extra: str = "") -> HTMLResponse:
    return HTMLResponse(
        _PAGE.format(title=html.escape(title), detail=html.escape(detail), extra=extra),
        status_code=status,
        headers=_PAGE_HEADERS,
    )


def _confirmation_page(pending: PendingInstall) -> HTMLResponse:
    return _page(
        title=f"Connect this {pending.platform} workspace to Switch?",
        detail=(
            "The app was approved on the platform. Check the organisation below "
            "before it is connected."
        ),
        status=200,
        extra=_CONFIRM_FORM.format(
            platform=html.escape(pending.platform),
            workspace=html.escape(
                f"{pending.workspace_name} ({pending.external_workspace_id})"
            ),
            organisation=html.escape(pending.organisation),
            requested_by=html.escape(pending.requested_by),
            action=html.escape(oauth_confirm_path(pending.platform)),
            ticket=html.escape(pending.ticket),
        ),
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
        error_description: str | None = Query(default=None),
    ) -> HTMLResponse:
        # The platform's own refusal, which is usually the customer deciding
        # not to install after all. Nothing went wrong here and nothing was
        # written; saying so is the whole handling.
        if error:
            try:
                explained = service.installer(platform).describe_callback_error(
                    error=error, description=error_description
                )
            except MessagingInstallError:
                explained = f"{platform} reported: {error}."
            return _page(
                title="Install cancelled",
                detail=f"{explained} Nothing was connected.",
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
            pending = await service.complete(
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

        return _confirmation_page(pending)

    @router.post("/{platform}/oauth/confirm")
    async def oauth_confirm(
        platform: str,
        ticket: Annotated[str, Form()],
        decision: Annotated[Literal["connect", "cancel"], Form()],
    ) -> HTMLResponse:
        try:
            if decision == "cancel":
                try:
                    grant = await service.cancel(platform=platform, ticket=ticket)
                except MessagingInstallError as failure:
                    logger.error(
                        "Could not revoke the %s token of a cancelled install: %s",
                        platform,
                        failure,
                    )
                    return _page(
                        title="Cancel did not finish",
                        detail=(
                            f"Switch could not give the app's access back to "
                            f"{platform}. Nothing was connected to Switch. Go "
                            "back and press Cancel again; if it keeps failing, "
                            f"remove the app from the {platform} workspace."
                        ),
                        status=502,
                    )
                return _page(
                    title="Install cancelled",
                    detail=(
                        f"Nothing was connected to Switch. The {platform} "
                        f"workspace {grant.workspace_name} may still list the "
                        "app; remove it there if you no longer want it."
                    ),
                    status=200,
                )
            install = await service.confirm(platform=platform, ticket=ticket)
        except (InstallTicketError, InstallPlatformMismatch) as failure:
            logger.warning("Refused a %s install confirmation: %s", platform, failure)
            return _page(
                title="Install could not be completed",
                detail=(
                    "This confirmation is not one Switch recognises, or it has "
                    "expired. Start the install again from Switch."
                ),
                status=400,
            )
        except MessagingInstallStateError as failure:
            return _page(
                title="Install already decided",
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

    async def _claim(platform: str, claim: InstallClaim) -> None:
        """Install the workspace a claim names, or log why not.

        A refused claim is not a refused event. The event is resolved next
        either way, and that is right in every case a claim can fail: a replay
        of a claim that succeeded resolves to the install it made, and receipts
        drop the duplicate; a workspace another tenant holds resolves to them,
        exactly as it would have without the claim; and one nobody holds is
        dropped as any unowned workspace is.
        """
        try:
            await service.claim(platform=platform, claim=claim)
        except (
            InstallStateError,
            MessagingInstallStateError,
            MessagingInstallClaimedError,
            InstallClaimNotPermitted,
        ) as failure:
            logger.warning(
                "Refused a claim of %s workspace %s: %s",
                platform,
                claim.grant.external_workspace_id,
                failure,
            )

    async def _end_install(platform: str, revocation: Revocation) -> None:
        """Act on the platform's news after it has been acknowledged.

        Logged and not raised for the same reason as `_deliver`, and with more
        at stake: the platform redelivers what it gets no answer to, and a
        traceback out of a background task would leave a dead install claiming
        a workspace with nothing in the log naming it.
        """
        try:
            await service.revoked(
                platform=platform,
                workspace_id=revocation.workspace_id,
                reason=revocation.reason,
            )
        except Exception:
            logger.exception(
                "Failed to end the install of %s workspace %s after the platform "
                "reported it was over (%s)",
                platform,
                revocation.workspace_id,
                revocation.reason,
            )

    async def _answer(target: WebhookTarget, event: InboundWebhook) -> Response:
        """Handle an event the platform waits on, and answer with what came of it.

        Under a deadline, and with every failure answered rather than raised:
        until it is answered the person who pressed is looking at a spinner,
        and the platform's own timeout reports a failure in its words, not
        ours.
        """
        handling = asyncio.create_task(service.answer(target, event))
        try:
            # Shielded: the deadline is the platform's, and running out of it
            # ends the wait, not the handling — a press abandoned half way
            # could be recorded with its card never redrawn.
            body = await asyncio.wait_for(
                asyncio.shield(handling), _INLINE_ANSWER_SECONDS
            )
        except TimeoutError:
            logger.error(
                "A %s %s event for bridge %s was not handled within %ss; it is "
                "still being handled, but the platform has been told it failed",
                target.platform,
                event.envelope_type,
                target.bridge_id,
                _INLINE_ANSWER_SECONDS,
            )
            _finishing.add(handling)
            handling.add_done_callback(
                functools.partial(_finished_late, target, event.envelope_type)
            )
            return Response(status_code=504)
        except Exception:
            logger.exception(
                "Failed to handle a %s %s event for bridge %s (tenant %s)",
                target.platform,
                event.envelope_type,
                target.bridge_id,
                target.tenant_id,
            )
            return Response(status_code=500)
        if body is None:
            return Response(status_code=200)
        return JSONResponse(body)

    async def _inbound(
        platform: str,
        endpoint: WebhookEndpoint,
        request: Request,
        background: BackgroundTasks,
    ) -> Response:
        """One verified request, from any of a platform's inbound URLs.

        The status codes are read by the platform, not by a person, and they
        are chosen for what it does with them. Slack retries a 5xx and gives up
        on a 4xx, and counts failures against the app as a whole — so a
        permanent condition must not look transient, and a transient one must
        not look permanent.
        """
        query = dict(request.query_params)
        try:
            # Before verification, because it cannot pass it by design and
            # answering it does nothing but echo the caller's own string.
            unsigned = service.unsigned_handshake(
                platform=platform, endpoint=endpoint, query=query
            )
        except MessagingInstallError:
            # No app registered for this platform, or none that posts here, so
            # nothing here could have signed anything. Not found rather than an
            # explanation: the caller is unauthenticated and learns only that
            # there is nothing here.
            return Response(status_code=404)
        if unsigned is not None:
            logger.info("Answered a %s URL validation", platform)
            return PlainTextResponse(unsigned)

        body = await request.body()
        try:
            events = await service.authenticate(
                platform=platform,
                endpoint=endpoint,
                headers=dict(request.headers),
                query=query,
                body=body,
            )
        except MessagingInstallError:
            return Response(status_code=404)
        except WebhookAuthenticityError as failure:
            logger.warning("Refused an unverified %s webhook: %s", platform, failure)
            return Response(status_code=401)
        except WebhookVerificationUnavailable as failure:
            logger.error(
                "Could not check a %s webhook, so asked for it again: %s",
                platform,
                failure,
            )
            return Response(status_code=503)
        except WebhookPayloadError as failure:
            # Verified, so this really is the platform sending something this
            # build cannot read. Worth an error rather than a shrug — it is how
            # a platform's change to its own payloads first becomes visible.
            logger.error("Could not read a verified %s webhook: %s", platform, failure)
            return Response(status_code=400)

        handshake = next((e.handshake for e in events if e.handshake is not None), None)
        if handshake is not None:
            logger.info("Answered a %s URL verification", platform)
            return PlainTextResponse(handshake)

        unavailable = 0
        unreadable = 0
        handled = 0
        # A batch usually names a handful of workspaces among many events, and
        # each lookup is two database reads before the platform is answered.
        resolved: dict[str, WebhookTarget | Exception] = {}

        async def resolve(event: InboundWebhook) -> WebhookTarget:
            workspace_id = service.workspace_of(platform=platform, event=event)
            if workspace_id not in resolved:
                try:
                    resolved[workspace_id] = await service.resolve_by_workspace(
                        platform=platform, workspace_id=workspace_id
                    )
                except (WebhookWorkspaceUnknown, WebhookBridgeUnavailable) as failure:
                    resolved[workspace_id] = failure
            outcome = resolved[workspace_id]
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        for event in events:
            if event.delivery_attempt > 0:
                # The only signal this deployment gets that its own
                # acknowledgements are arriving too late. The event itself is
                # handled normally — the receipt decides whether it is a
                # duplicate — but a run of these is the platform saying the
                # three-second answer is being missed, and nothing else in the
                # system would say so.
                logger.warning(
                    "%s is re-sending a %s event (attempt %s), which means an "
                    "earlier delivery was not acknowledged in time",
                    platform,
                    event.envelope_type,
                    event.delivery_attempt,
                )

            try:
                # Before resolving, because this is the one event that arrives
                # as the bridge it would be resolved to is going away.
                revocation = service.revocation(platform=platform, event=event)
                if revocation is not None:
                    background.add_task(_end_install, platform, revocation)
                    handled += 1
                    continue

                # Before resolving too, and handled before answering rather
                # than after: the event goes on to be delivered below, and
                # whether it has anywhere to go is what the claim decides.
                claim = service.claim_of(platform=platform, event=event)
                if claim is not None:
                    await _claim(platform, claim)
                    resolved.pop(claim.grant.external_workspace_id, None)

                target = await resolve(event)
            except WebhookPayloadError as failure:
                # Skipped rather than answered: on an endpoint every workspace
                # shares, one unreadable item in a batch must not take the rest
                # of it down with it.
                logger.error(
                    "A verified %s event named no workspace: %s", platform, failure
                )
                unreadable += 1
                continue
            except WebhookWorkspaceUnknown as failure:
                # A 200 for an event that reached nobody, which is the one place
                # this file answers something other than what happened. The app
                # left behind in a workspace whose install ended goes on
                # posting, the platform cannot act on a 404, and it counts the
                # refusals against the app as a whole — so the honest answer
                # costs every other customer's delivery. The log is where it is
                # visible.
                logger.warning("Dropped a %s event: %s", platform, failure)
                continue
            except WebhookBridgeUnavailable as failure:
                logger.error("Could not deliver a %s event: %s", platform, failure)
                unavailable += 1
                continue

            if event.answers_inline:
                # Only ever one to a request: a platform that waits on an
                # answer sends the one event it waits on.
                return await _answer(target, event)

            # Answered first, handled after. The platform's deadline is short
            # and what happens next is not bounded by it — a turn can take
            # minutes — so acknowledging on the way out is what keeps a slow
            # room from becoming a retried, duplicated one.
            background.add_task(_deliver, target, event)
            handled += 1

        # A 503 asks the platform to send the request again, which is right
        # while a bridge restarts — a 200 would drop a real message and report
        # it handled. But only when nothing in it was delivered: a batch on an
        # endpoint every workspace shares is otherwise one workspace's restart
        # failing, and the platform backing off from, everyone else's delivery.
        # What was undeliverable in a partly delivered batch is logged above.
        # A batch nothing in which could be read is the platform's payload
        # changing under this build, and says so with a 400 that is not retried.
        if events and unreadable == len(events):
            return Response(status_code=400)
        if unavailable and not handled:
            return Response(status_code=503)
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

    @router.post("/{platform}/notifications")
    async def notifications(
        platform: str, request: Request, background: BackgroundTasks
    ) -> Response:
        """Change notifications a platform pushes for what it was asked to watch.

        Microsoft Graph's, for the distributed Teams app: every message in the
        channels Switch captures, batched, from every organisation at once.
        """
        return await _inbound(platform, "notifications", request, background)

    return router
