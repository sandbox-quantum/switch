"""Inbound webhooks for bridges whose platform calls Switch, one address each.

A platform that cannot hold a connection open to us — email, SMS, WhatsApp,
Google Chat — delivers each event by calling an address. A connection created
in Switch gets one of its own, `/messaging/bridges/<id>/events`, and the
request is proved
with that connection's own secret by its adapter (`verify_webhook`) rather than
with a secret the deployment holds. That is what separates this from the
shared `/messaging/<platform>/...` routes, which serve Switch's own distributed
apps and are verified with the deployment's app credentials.

What happens after verification is the same as there: answer the platform at
once, hand the event to the adapter in the background, and recognise a retried
delivery so it is handled once.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from fastapi import APIRouter, BackgroundTasks, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.responses import PlainTextResponse

from switch_core.bridges.collaboration.install import (
    PUBLIC_PATH_PREFIX,
    InboundWebhook,
    WebhookAuthenticityError,
    WebhookPayloadError,
    WebhookRequest,
    public_url,
)
from switch_core.db.session_scope import tenant_session
from switch_core.db.stores.messaging_event_store import MessagingEventReceiptStore
from switch_core.tenant_context import no_tenant

if TYPE_CHECKING:
    from switch_core.bridges.collaboration.adapter import PlatformAdapter
    from switch_core.bridges.collaboration.lifecycle_service import (
        CollaborationBridgeLifecycleService,
    )

logger = logging.getLogger(__name__)


def webhook_path(bridge_id: str) -> str:
    """The path a bridge receives its platform's events on.

    Under `/messaging` because that is already the prefix a deployment exposes
    to platforms dialling in from the internet, beside the distributed apps'
    routes — so an ingress that serves those serves these with no change.
    """
    return f"{PUBLIC_PATH_PREFIX}/bridges/{bridge_id}/events"


def webhook_url(public_origin: str | None, bridge_id: str) -> str | None:
    """The address to give the platform, or None where the deployment has not
    said what its public origin is (`MESSAGING_PUBLIC_URL`)."""
    if not public_origin:
        return None
    return public_url(public_origin, webhook_path(bridge_id))


class WebhookBridgeUnknown(RuntimeError):
    """No bridge here takes webhooks at this address.

    Covers a bridge id that does not exist and one whose platform does not
    receive webhooks alike, so an unauthenticated caller cannot tell the two
    apart.
    """


class WebhookBridgeStopped(RuntimeError):
    """The bridge exists and takes webhooks, and is not running to take this one.

    Transient — a bridge mid-restart — so the platform is told to try again
    rather than having the event dropped.
    """


@dataclass(frozen=True)
class BridgeWebhookTarget:
    """The running bridge a webhook address belongs to."""

    tenant_id: str
    bridge_id: str
    bridge_type: str
    adapter: PlatformAdapter


class BridgeWebhookService:
    def __init__(
        self,
        *,
        lifecycle: CollaborationBridgeLifecycleService,
        session_factory: async_sessionmaker[AsyncSession],
        receipts: MessagingEventReceiptStore,
    ) -> None:
        self._lifecycle = lifecycle
        self._session_factory = session_factory
        self._receipts = receipts

    async def resolve(self, bridge_id: str) -> BridgeWebhookTarget:
        """The running bridge behind this address. Raises `WebhookBridgeUnknown`
        or `WebhookBridgeStopped`."""
        return await self._lifecycle.webhook_target(bridge_id)

    async def authenticate(
        self, target: BridgeWebhookTarget, request: WebhookRequest
    ) -> InboundWebhook:
        """Prove the request is the platform's, with this bridge's own secret,
        and read it. Verification is first and unconditional."""
        await target.adapter.verify_webhook(request)
        return target.adapter.parse_webhook(request)

    async def deliver(self, target: BridgeWebhookTarget, event: InboundWebhook) -> None:
        """Hand a verified event to the bridge, at most once.

        Claimed before it is dispatched, so a retry arriving while the first
        delivery is still working finds the event taken. The receipt is keyed
        by the bridge as well as the platform's event id: two connections to
        the same platform are two apps, whose event ids need not be distinct.

        Dispatched with nothing bound, as a socket-delivered event is — see
        `MessagingInstallService.deliver`.
        """
        if event.external_event_id is None:
            await self._dispatch(target, event)
            return

        async with tenant_session(self._session_factory, target.tenant_id) as session:
            receipt = await self._receipts.claim(
                session,
                platform=target.bridge_type,
                external_event_id=f"{target.bridge_id}:{event.external_event_id}",
            )
            if receipt is None:
                logger.info(
                    "Dropped a repeat delivery of %s event %s to bridge %s; it "
                    "has already been taken",
                    target.bridge_type,
                    event.external_event_id,
                    target.bridge_id,
                )
                return
            receipt_id = receipt.id
            await session.commit()

        await self._dispatch(target, event)

        async with tenant_session(self._session_factory, target.tenant_id) as session:
            await self._receipts.mark_handled(session, receipt_id=receipt_id)
            await self._receipts.prune(session)
            await session.commit()

    async def _dispatch(
        self, target: BridgeWebhookTarget, event: InboundWebhook
    ) -> None:
        with no_tenant():
            await target.adapter.dispatch_event(
                envelope_type=event.envelope_type, payload=event.payload
            )


def create_bridge_webhook_router(service: BridgeWebhookService) -> APIRouter:
    """`/messaging/bridges/<id>/events`, mounted where the outside world reaches
    Switch.

    The status codes are read by the platform, not a person: a 5xx is retried
    and a 4xx is not, so a permanent condition must not look transient and a
    transient one must not look permanent.
    """
    router = APIRouter()

    async def _deliver(target: BridgeWebhookTarget, event: InboundWebhook) -> None:
        # A background task: the platform has had its answer, and a traceback
        # here would otherwise surface only as an unretrieved task exception.
        try:
            await service.deliver(target, event)
        except Exception:
            logger.exception(
                "Failed to deliver a %s event to bridge %s",
                target.bridge_type,
                target.bridge_id,
            )

    async def _inbound(
        bridge_id: str, request: Request, background: BackgroundTasks
    ) -> Response:
        try:
            target = await service.resolve(bridge_id)
        except WebhookBridgeUnknown:
            return Response(status_code=404)
        except WebhookBridgeStopped as failure:
            logger.error("Could not deliver a webhook: %s", failure)
            return Response(status_code=503)

        webhook = WebhookRequest(
            method=request.method,
            headers={k.lower(): v for k, v in request.headers.items()},
            query=dict(request.query_params),
            body=await request.body(),
        )
        try:
            event = await service.authenticate(target, webhook)
        except WebhookAuthenticityError as failure:
            logger.warning(
                "Refused an unverified webhook for %s bridge %s: %s",
                target.bridge_type,
                bridge_id,
                failure,
            )
            return Response(status_code=401)
        except WebhookPayloadError as failure:
            # Verified, so this really is the platform sending something the
            # adapter cannot read — how a platform's change first shows up.
            logger.error(
                "Could not read a verified webhook for %s bridge %s: %s",
                target.bridge_type,
                bridge_id,
                failure,
            )
            return Response(status_code=400)

        if event.handshake is not None:
            logger.info(
                "Answered a %s address check for bridge %s",
                target.bridge_type,
                bridge_id,
            )
            return PlainTextResponse(event.handshake)

        # Answered first, handled after: the platform's deadline is short and a
        # turn can take minutes.
        background.add_task(_deliver, target, event)
        return Response(status_code=200)

    @router.post(webhook_path("{bridge_id}"))
    async def events(
        bridge_id: str, request: Request, background: BackgroundTasks
    ) -> Response:
        return await _inbound(bridge_id, request, background)

    # Some platforms prove an address is ours with a GET carrying a challenge
    # (WhatsApp's `hub.challenge`) before they post anything to it.
    @router.get(webhook_path("{bridge_id}"))
    async def address_check(
        bridge_id: str, request: Request, background: BackgroundTasks
    ) -> Response:
        return await _inbound(bridge_id, request, background)

    return router
