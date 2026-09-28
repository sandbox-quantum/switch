"""The deployment's own Telegram bot, shared by every tenant.

The distributed Telegram app (`docs/old/bridges/TELEGRAM_DISTRIBUTED_APP.md`)
is one bot per deployment. Its token is deployment config, never stored against
an install, and everything that is per bot rather than per tenant lives here:
who the bot is (`getMe`), and where Telegram delivers its updates
(`setWebhook`).

A bot has exactly one delivery channel. Setting a webhook makes `getUpdates`
fail, so this bot is never polled — not by this process and not by a
self-registered bridge someone pasted the same token into.
"""

from __future__ import annotations

import asyncio
import logging

import telegram

from switch_core.bridges.collaboration.install import MessagingInstallError

logger = logging.getLogger(__name__)

#: The updates Telegram is asked to deliver. The same set the self-registered
#: adapter polls for; a test holds the two together.
ALLOWED_UPDATES: tuple[str, ...] = (
    "message",
    "channel_post",
    "my_chat_member",
    "callback_query",
)

_INITIAL_RETRY_DELAY = 5.0
_MAX_RETRY_DELAY = 300.0


class TelegramAppNotReady(MessagingInstallError):
    """The shared bot has not yet told us who it is.

    Its username comes from `getMe`, which runs in the background at boot so an
    unreachable Telegram cannot hold up a deployment serving other platforms.
    Until it answers there is no link to hand out and no way to tell a command
    addressed to this bot from one addressed to another bot in the same chat.
    """


def bot_id_of(token: str) -> str:
    """The bot's numeric id, which is the part of its token before the colon.

    Read from the token rather than `getMe` because it is needed where no call
    can be made — comparing a token someone pasted into a self-registered
    bridge against this one.
    """
    bot_id, separator, _ = token.partition(":")
    if not separator or not bot_id.isdigit():
        raise ValueError("a Telegram bot token is shaped <bot id>:<secret>")
    return bot_id


class TelegramAppClient:
    def __init__(
        self, *, bot: telegram.Bot, webhook_url: str, webhook_secret: str
    ) -> None:
        self._bot = bot
        self._webhook_url = webhook_url
        self._webhook_secret = webhook_secret
        self._username: str | None = None
        self.bot_id = bot_id_of(bot.token)

    @property
    def bot_username(self) -> str:
        if self._username is None:
            raise TelegramAppNotReady(
                "the Switch Telegram bot has not connected yet, so there is no "
                "link to offer. Try again shortly; the server log says why if "
                "it keeps failing."
            )
        return self._username

    async def start(self) -> None:
        """Learn who the bot is, then point Telegram's delivery at us.

        `setWebhook` runs on every start rather than once at registration, so
        the URL, the secret and the update types always match this build's
        config — rotating the secret is a redeploy, not a manual call.
        """
        await self._bot.initialize()
        me = await self._bot.get_me()
        if not me.username:
            raise MessagingInstallError(
                f"Telegram reports no username for bot {me.id}, and every link "
                "to it is built from one"
            )
        await self._bot.set_webhook(
            url=self._webhook_url,
            secret_token=self._webhook_secret,
            allowed_updates=list(ALLOWED_UPDATES),
        )
        self._username = me.username
        logger.info(
            "Telegram app @%s is receiving updates at %s",
            self._username,
            self._webhook_url,
        )

    async def start_with_retry(self) -> None:
        """`start`, retried with backoff, as a supervised background task.

        A configured-but-unreachable Telegram must never block or fail a boot
        that serves every other platform. Until this succeeds the app offers no
        links, and updates Telegram already holds for us wait on its side.
        """
        delay = _INITIAL_RETRY_DELAY
        while True:
            try:
                await self.start()
                return
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception(
                    "The Telegram app failed to start; it offers no links until "
                    "it does. Retrying in %.0fs",
                    delay,
                )
                await asyncio.sleep(delay)
                delay = min(delay * 2, _MAX_RETRY_DELAY)

    async def stop(self) -> None:
        """Release the HTTP client. The webhook stays set on purpose.

        Deleting it would make Telegram discard what it would otherwise hold
        and retry while this process restarts.
        """
        await self._bot.shutdown()
