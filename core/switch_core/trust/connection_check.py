"""Asking Switch Trust whether a policy can be used, before an organization
connects it (`gateway/organization_guardrails.py`).

One check of a fixed message, made exactly as every message is checked, so a
policy id or API key Switch Trust refuses is refused when it is entered rather
than at the first message, where a failed check only annotates it. The answer
also carries the policy's name, which nothing else Switch Trust offers does.
"""

from __future__ import annotations

import httpx

from switch_core.trust.client import HttpTrustClient, TrustCheckResult

# What the check sends: words no policy should object to, saying what they are
# for to anyone reading Switch Trust's records of it.
_CHECKED_TEXT = "Switch is checking that it can use this policy."
_SESSION_ID = "switch-connection-check"


class TrustConnectionCheck:
    def __init__(self, *, client: httpx.AsyncClient, timeout_seconds: float) -> None:
        self._client = client
        self._timeout_seconds = timeout_seconds

    async def __call__(
        self, *, endpoint: str, policy_id: str, api_key: str
    ) -> TrustCheckResult:
        """Switch Trust's answer for the policy. Raises `GuardrailsCheckError`
        when it can't be reached, or `GuardrailsRefusedError` when it answers
        with an error, as for a key or policy it doesn't know."""
        checker = HttpTrustClient(
            base_url=endpoint,
            api_key=api_key,
            policy_id=policy_id,
            timeout_seconds=self._timeout_seconds,
            client=self._client,
        )
        return await checker.check(
            role="user", content=_CHECKED_TEXT, room_id=_SESSION_ID
        )
