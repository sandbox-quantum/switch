"""Changes to people's chats, reaching their Console streams on every process.

Switch Console follows a person's chats over one stream (`chat_events` in
`gateway/chats.py`), held by whichever switch-core process its request
reached. What changes which chats a person has (a chat created or archived, a
member added or removed, a room gaining or losing its agents) is served by
whichever process that request reached, and `ChatService` wakes the streams
held there at once. A stream held by another process saw the change only at
its next periodic re-read.

So each such change, once committed, announces `chats.memberships_changed`
naming the tenant and the people whose chats changed. Every other process
wakes the streams it holds for them, and each re-reads what its person may
see. A change concerning more people than one signal can name is split over
as many signals as it takes.

Signals sent while this process's signal connection was down were never
queued, so when it comes back every stream held here is woken once: a wake-up
costs that stream one re-read.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from switch_core.signals import payload_chunks

if TYPE_CHECKING:
    from switch_core.chats.service import ChatService
    from switch_core.signals import SignalBus

MEMBERSHIPS_CHANGED_SIGNAL = "chats.memberships_changed"

# Room kept in every signal for what it carries beside its user ids: its kind,
# the sending process's id and the tenant id, about 200 bytes at most.
_SIGNAL_ENVELOPE_BYTES = 400


class ChatSignals:
    def __init__(self, *, service: ChatService, bus: SignalBus) -> None:
        self._service = service
        self._bus = bus
        bus.handle(MEMBERSHIPS_CHANGED_SIGNAL, self._on_changed)
        bus.on_resync(self._wake_all)
        # No periodic re-check, unlike the other families: every stream
        # already re-reads everything on its own every `RECHECK_SECONDS`
        # (`gateway/chats.py`), which is all a missed signal can cost it.
        service.use_signals(self)

    def memberships_changed(self, tenant_id: str, user_ids: list[str]) -> None:
        """The users' chats changed and the change has committed: every other
        process wakes the streams it holds for them. This one has already
        woken its own."""
        for chunk in payload_chunks(user_ids, _SIGNAL_ENVELOPE_BYTES):
            self._bus.publish(
                MEMBERSHIPS_CHANGED_SIGNAL, tenant_id=tenant_id, user_ids=chunk
            )

    def _on_changed(self, signal: dict[str, Any]) -> None:
        self._service.wake_membership_watchers(signal["tenant_id"], signal["user_ids"])

    async def _wake_all(self) -> None:
        self._service.wake_all_membership_watchers()
