from __future__ import annotations

import httpx
import pytest

from switch_core.matrix_admin import MatrixAdmin, MatrixAdminError

ROOM = "!T5MphZvo650rb9LDq2:switch.local"
USER = "@switch-agent-d322f24a:switch.local"

# Verbatim from Tuwunel, typo included — the guard matches on this text, so a
# paraphrase would test nothing.
TUWUNEL_NOT_A_MEMBER = (
    '{"errcode":"M_FORBIDDEN","error":"M_FORBIDDEN: Cannot kick a user who is '
    'not apart of the room (current membership: leave)"}'
)
SYNAPSE_NOT_A_MEMBER = (
    '{"errcode":"M_FORBIDDEN","error":"The target user is not in the room"}'
)


def _admin(handler: object) -> MatrixAdmin:
    http = httpx.AsyncClient(
        base_url="http://homeserver.invalid",
        transport=httpx.MockTransport(handler),  # type: ignore[arg-type]
    )
    return MatrixAdmin(
        server_url="http://homeserver.invalid",
        admin_user="@admin:switch.local",
        access_token="token",
        shared_secret="secret",
        http=http,
    )


class TestKickUser:
    @pytest.mark.parametrize("body", [TUWUNEL_NOT_A_MEMBER, SYNAPSE_NOT_A_MEMBER])
    async def test_already_gone_is_not_an_error(self, body: str) -> None:
        """Tearing a room down kicks every client it ever had, and a client that
        already left answers 403. Deleting a room must not abort on it
        (CHOO-2344: disconnecting a messaging app failed with a 500)."""
        admin = _admin(lambda request: httpx.Response(403, text=body))

        await admin.kick_user(ROOM, USER)

        await admin._http.aclose()

    async def test_real_forbidden_still_raises(self) -> None:
        admin = _admin(
            lambda request: httpx.Response(
                403,
                text='{"errcode":"M_FORBIDDEN","error":"You don\'t have permission to kick"}',
            )
        )

        with pytest.raises(MatrixAdminError, match="Failed to kick"):
            await admin.kick_user(ROOM, USER)

        await admin._http.aclose()

    async def test_other_failures_still_raise(self) -> None:
        admin = _admin(lambda request: httpx.Response(500, text="boom"))

        with pytest.raises(MatrixAdminError, match="Failed to kick"):
            await admin.kick_user(ROOM, USER)

        await admin._http.aclose()
