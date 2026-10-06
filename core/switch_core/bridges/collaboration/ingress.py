from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from aiohttp import web

from switch_core.keys import Keyring, Purpose

logger = logging.getLogger(__name__)

# What a bridge's callbacks are addressed as. The type is in the path so a
# second platform needing one is a sibling rather than a collision, and the
# bridge's id is in it so one listener serves every bridge and every tenant.
_ROUTE = "/collaboration/{bridge_type}/{bridge_id}/callback"

# How a bridge's callback key was derived from `JWT_SECRET_KEY` before
# `SECRET_KEYS`; kept so buttons posted then still verify while it is set.
_LEGACY_KEY_PURPOSE = "collaboration-callback"

Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


class CallbackRefused(Exception):
    """A callback this bridge will not act on, and the answer it is owed.

    Raised by a handler that has read the request and decided against it —
    an unsigned press, a credential that no longer verifies, a body that is
    not what the route is for. The status travels with it because refusing is
    a normal outcome of an authenticated route, not a fault to be logged as
    one.
    """

    def __init__(self, message: str, *, status: int) -> None:
        super().__init__(message)
        self.status = status


class CallbackIngress:
    """One HTTP listener for every collaboration bridge that is called back.

    Most platforms never need this: Slack, Discord, Telegram and Mattermost's
    own event stream all dial out, and nothing has to reach Switch for them to
    work. A Mattermost button is the exception — a press is delivered by the
    Mattermost server to a URL, so there has to be something listening.

    It is a port of its own rather than a route on the agent API. The agent API
    carries the agent surface and the operator dashboard, and a callback route
    on it would mean one over-broad proxy rule away from publishing both. Here the whole of what an operator exposes is
    callbacks, so a mistake can only expose callbacks.

    It is shared rather than one per bridge, because a per-bridge listener
    costs a port and an ingress rule each, and two Mattermost bridges — two
    tenants, or a test server beside a real one — are ordinary. Each bridge is
    named in its own path and authenticates its own callers; this class routes
    and does not judge.

    Nothing binds until a bridge actually asks to be served, so a deployment
    with no callbacks opens no port. Once bound it stays bound until shutdown:
    a bridge restarting would otherwise unbind and rebind the port underneath
    any other bridge sharing it.
    """

    def __init__(self, *, host: str, port: int, keyring: Keyring) -> None:
        self._host = host
        self._port = port
        self._keyring = keyring
        self._handlers: dict[tuple[str, str], Handler] = {}
        self._runner: web.AppRunner | None = None
        # Each bridge runs in a task of its own, so two starting together reach
        # the bind together. Without this both would find nothing bound and the
        # loser would fail on a port its own neighbour had just taken.
        self._bind_lock = asyncio.Lock()

    def endpoint_for(self, bridge_type: str, bridge_id: str) -> CallbackEndpoint:
        return CallbackEndpoint(
            self,
            bridge_type,
            bridge_id,
            key=self._key_for(bridge_type, bridge_id),
            verification_keys=self._verification_keys_for(bridge_type, bridge_id),
        )

    def path_for(self, bridge_type: str, bridge_id: str) -> str:
        return _ROUTE.format(bridge_type=bridge_type, bridge_id=bridge_id)

    def _key_for(self, bridge_type: str, bridge_id: str) -> str:
        """The key one bridge authenticates its own callbacks with.

        Derived rather than stored. A secret on the bridge's saved
        configuration would have to be minted when the bridge is registered,
        which leaves every bridge registered before callbacks existed unable to
        take one until somebody edits its configuration by hand — and adds a
        second secret to keep, back up and rotate. Deriving it costs none of
        that: the key exists the moment the bridge starts, and rotating the
        server keys rotates it.

        Separated by bridge, so what one bridge accepts another will not, and
        by purpose (`keys.Purpose.BRIDGE_CALLBACK`), so it is not the same value
        as anything else derived from the server's keys. Signing uses the
        current key; `_verification_keys_for` also accepts older ones.
        """
        return self._bridge_key(
            self._keyring.derive(Purpose.BRIDGE_CALLBACK), bridge_type, bridge_id
        )

    def _verification_keys_for(self, bridge_type: str, bridge_id: str) -> list[str]:
        """Every key a press for this bridge may carry a signature from: each
        key in the keyring, and while `JWT_SECRET_KEY` is set, the key it
        derived before `SECRET_KEYS`, so buttons already posted keep working."""
        keys = [
            self._bridge_key(derived, bridge_type, bridge_id)
            for derived in self._keyring.verification_keys(Purpose.BRIDGE_CALLBACK)
        ]
        if self._keyring.legacy_secret is not None:
            keys.append(
                hmac.new(
                    self._keyring.legacy_secret.encode(),
                    f"{_LEGACY_KEY_PURPOSE}:{bridge_type}:{bridge_id}".encode(),
                    hashlib.sha256,
                ).hexdigest()
            )
        return keys

    @staticmethod
    def _bridge_key(derived: bytes, bridge_type: str, bridge_id: str) -> str:
        return hmac.new(
            derived, f"{bridge_type}:{bridge_id}".encode(), hashlib.sha256
        ).hexdigest()

    async def serve(self, bridge_type: str, bridge_id: str, handle: Handler) -> None:
        """Take callbacks for one bridge, binding the listener if it is the first.

        Bound before registered, so a bind that fails leaves nothing behind
        claiming to serve this bridge. A press arriving in the gap between the
        two is answered as not running, which is what it is.
        """
        await self._listen()
        self._handlers[(bridge_type, bridge_id)] = handle

    async def withdraw(self, bridge_type: str, bridge_id: str) -> None:
        """Stop taking callbacks for one bridge.

        The listener stays up. A press that arrives for a bridge that is not
        running is answered as gone rather than by a refused connection, which
        is the difference between a Mattermost server that reports the problem
        and one that retries into a closed port.
        """
        self._handlers.pop((bridge_type, bridge_id), None)

    async def stop(self) -> None:
        self._handlers.clear()
        if self._runner is None:
            return
        await self._runner.cleanup()
        self._runner = None
        logger.info("Collaboration callback listener stopped")

    async def _listen(self) -> None:
        async with self._bind_lock:
            if self._runner is not None:
                return
            app = web.Application()
            app.router.add_post(_ROUTE, self._dispatch)
            runner = web.AppRunner(app)
            await runner.setup()
            try:
                site = web.TCPSite(runner, self._host, self._port)
                await site.start()
            except Exception:
                # A runner that has been set up holds resources whether or not
                # anything ever bound through it.
                await runner.cleanup()
                raise
            self._runner = runner
            logger.info(
                "Collaboration callback listener on %s:%s", self._host, self._port
            )

    async def _dispatch(self, request: web.Request) -> web.StreamResponse:
        bridge_type = request.match_info["bridge_type"]
        bridge_id = request.match_info["bridge_id"]
        handle = self._handlers.get((bridge_type, bridge_id))
        if handle is None:
            logger.warning(
                "A callback arrived for %s bridge %s, which is not running here.",
                bridge_type,
                bridge_id,
            )
            return web.json_response(
                {"error": {"message": "Unknown bridge."}}, status=404
            )

        try:
            body = await request.json()
        except Exception:
            return web.json_response(
                {"error": {"message": "Expected a JSON body."}}, status=400
            )
        if not isinstance(body, dict):
            return web.json_response(
                {"error": {"message": "Expected a JSON object."}}, status=400
            )

        try:
            answer = await handle(body)
        except CallbackRefused as refused:
            return web.json_response(
                {"error": {"message": str(refused)}}, status=refused.status
            )
        except Exception:
            # The listener serves every bridge sharing the port, so one
            # handler's failure is not allowed to be the port's.
            logger.exception(
                "Failed to handle a callback for %s bridge %s", bridge_type, bridge_id
            )
            return web.json_response(
                {"error": {"message": "Switch could not handle that."}}, status=500
            )
        return web.json_response(answer)


class CallbackEndpoint:
    """One bridge's place on the shared listener, and the key it vouches with.

    Handed to an adapter so it can serve its own callbacks without knowing
    which bridge it is or that it shares a port with anything — and without
    ever holding the server keys its keys came from.
    """

    def __init__(
        self,
        ingress: CallbackIngress,
        bridge_type: str,
        bridge_id: str,
        *,
        key: str,
        verification_keys: list[str],
    ) -> None:
        self._ingress = ingress
        self._bridge_type = bridge_type
        self._bridge_id = bridge_id
        # Signs what the bridge posts now.
        self.key = key
        # Verifies a press: `key`, plus older keys still in the keyring.
        self.verification_keys = verification_keys

    @property
    def path(self) -> str:
        """The path a caller reaches this bridge on, below whatever base URL
        the platform has been told to use."""
        return self._ingress.path_for(self._bridge_type, self._bridge_id)

    async def serve(self, handle: Handler) -> None:
        await self._ingress.serve(self._bridge_type, self._bridge_id, handle)

    async def withdraw(self) -> None:
        await self._ingress.withdraw(self._bridge_type, self._bridge_id)
