"""Slack API fake shared by SDK rendering and interaction tests."""

from typing import Any

from slack_sdk.errors import SlackApiError


class FakeResponse(dict):
    def __init__(self, *args: Any, headers: dict[str, str] | None = None) -> None:
        super().__init__(*args)
        self.headers = headers or {}


class FakeWebClient:
    def __init__(self) -> None:
        self.api_calls: list[tuple[str, dict[str, Any]]] = []
        self.posted: list[dict[str, Any]] = []
        self.updated: list[dict[str, Any]] = []
        self.update_error: str | None = None
        self.deleted: list[dict[str, Any]] = []
        self.reactions: list[tuple[str, str, str]] = []
        self.reaction_error: str | None = None
        # A thread as conversations.replies hands it back: the root first, then
        # its replies in order.
        self.thread: list[dict[str, Any]] = []
        self.replies_error: str | None = None
        # Streamed activity: the openings, every append's chunks in order, and
        # the closes. Kept apart from `posted`/`updated` because a stream is a
        # different call shape, and a test that expects one should not pass on
        # the other.
        self.started: list[dict[str, Any]] = []
        self.appended: list[dict[str, Any]] = []
        self.stopped: list[dict[str, Any]] = []
        self.start_error: str | None = None
        self.append_error: str | None = None
        self._ts = 0

    async def api_call(self, method: str, **kwargs: Any) -> FakeResponse:
        self.api_calls.append((method, kwargs))
        return FakeResponse({"ok": True})

    async def reactions_add(self, **kwargs: Any) -> FakeResponse:
        if self.reaction_error:
            raise SlackApiError("no", FakeResponse({"error": self.reaction_error}))
        self.reactions.append(("add", kwargs["timestamp"], kwargs["name"]))
        return FakeResponse({"ok": True})

    async def reactions_remove(self, **kwargs: Any) -> FakeResponse:
        if self.reaction_error:
            raise SlackApiError("no", FakeResponse({"error": self.reaction_error}))
        self.reactions.append(("remove", kwargs["timestamp"], kwargs["name"]))
        return FakeResponse({"ok": True})

    async def chat_postMessage(self, **kwargs: Any) -> FakeResponse:
        self._ts += 1
        self.posted.append(kwargs)
        return FakeResponse({"ts": f"{self._ts}.0"})

    async def chat_delete(self, **kwargs: Any) -> FakeResponse:
        self.deleted.append(kwargs)
        return FakeResponse({"ok": True})

    async def chat_update(self, **kwargs: Any) -> FakeResponse:
        if self.update_error:
            raise SlackApiError("failed", FakeResponse({"error": self.update_error}))
        self.updated.append(kwargs)
        return FakeResponse({"ok": True})

    async def chat_startStream(self, **kwargs: Any) -> FakeResponse:
        if self.start_error:
            raise SlackApiError("no", FakeResponse({"error": self.start_error}))
        self._ts += 1
        self.started.append(kwargs)
        return FakeResponse({"ts": f"{self._ts}.0"})

    async def chat_appendStream(self, **kwargs: Any) -> FakeResponse:
        if self.append_error:
            raise SlackApiError("no", FakeResponse({"error": self.append_error}))
        self.appended.append(kwargs)
        return FakeResponse({"ok": True})

    async def chat_stopStream(self, **kwargs: Any) -> FakeResponse:
        self.stopped.append(kwargs)
        return FakeResponse({"ok": True})

    async def conversations_replies(self, **kwargs: Any) -> FakeResponse:
        if self.replies_error:
            raise SlackApiError("failed", FakeResponse({"error": self.replies_error}))
        self.api_calls.append(("conversations.replies", kwargs))
        return FakeResponse({"messages": self.thread[: kwargs.get("limit", 100)]})

    async def conversations_info(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"channel": {"is_private": False}})

    async def users_info(self, **kwargs: Any) -> FakeResponse:
        return FakeResponse({"user": {"name": "someone", "profile": {}}})
