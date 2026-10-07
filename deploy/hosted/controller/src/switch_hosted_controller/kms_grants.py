from __future__ import annotations

import logging
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from botocore.exceptions import ClientError

from .config import ConfigError
from .store import MachineStore

logger = logging.getLogger(__name__)

GRANT_OPERATIONS = ("Decrypt",)
CONTEXT_KEYS = frozenset({"switch:tenant", "switch:owner_id", "switch:controller_id"})
_CONTEXT_VALUE = re.compile(r"^[\x21-\x7e]{1,256}$")
_GRANT_NAME = re.compile(r"^switch-(?P<slot>[a-z0-9][a-z0-9-]{2,39})-g(?P<generation>[1-9][0-9]*)$")
_GONE = {"NotFoundException", "InvalidGrantIdException"}


@dataclass(frozen=True)
class Grant:
    grant_id: str
    token: str = field(repr=False)


def grant_name(slot_id: str, generation: int) -> str:
    return f"switch-{slot_id}-g{generation}"


def validate_context(context: Any) -> dict[str, str]:
    if not isinstance(context, Mapping) or set(context) != CONTEXT_KEYS:
        raise ConfigError("Cloud gateway returned an invalid login key encryption context.")
    for value in context.values():
        if not isinstance(value, str) or not _CONTEXT_VALUE.fullmatch(value):
            raise ConfigError("Cloud gateway returned an invalid login key encryption context.")
    return dict(context)


class KmsGrants:
    """One Decrypt grant on the login key per slot generation, for the slot's role.

    The grant is constrained to the encryption context of the machine's owner
    and controller, so a slot's instance can open only the logins sealed for
    the machine it currently serves.
    """

    def __init__(self, kms: Any, key_arn: str, store: MachineStore):
        self._kms = kms
        self._key_arn = key_arn
        self._store = store

    @property
    def key_arn(self) -> str:
        return self._key_arn

    def ensure_grant(
        self, slot_id: str, slot_role_arn: str, generation: int, context: Mapping[str, str]
    ) -> Grant:
        constraint = validate_context(context)
        name = grant_name(slot_id, generation)
        record = self._store.intend_grant(slot_id, generation, self._key_arn, slot_role_arn)
        same_name = [
            grant for grant in self._list(self._key_arn, slot_role_arn) if grant.get("Name") == name
        ]
        current = {
            grant["GrantId"] for grant in same_name if _matches(grant, slot_role_arn, constraint)
        }
        if record.grant_id is not None and record.grant_token and record.grant_id in current:
            grant = Grant(record.grant_id, record.grant_token)
        else:
            response = self._kms.create_grant(
                KeyId=self._key_arn,
                GranteePrincipal=slot_role_arn,
                Operations=list(GRANT_OPERATIONS),
                Constraints={"EncryptionContextSubset": constraint},
                Name=name,
            )
            grant_id = response["GrantId"]
            token = response["GrantToken"]
            if record.grant_id == grant_id and record.grant_token:
                # KMS answers a repeated named CreateGrant with the same grant and
                # a new token; either token works, and keeping the first keeps a
                # rewritten bundle identical to the one already stored.
                token = record.grant_token
            self._store.record_grant(slot_id, generation, grant_id, token)
            grant = Grant(grant_id, token)
        for stale in same_name:
            if stale["GrantId"] != grant.grant_id:
                logger.warning(
                    "Revoking a login key grant of slot %s generation %s with different terms.",
                    slot_id,
                    generation,
                )
                self._revoke(self._key_arn, stale["GrantId"])
        return grant

    def retire_older(self, slot_id: str, generation: int) -> list[int]:
        """Revoke this slot's grants of generations before `generation`.

        Returns the generations retired. Only generations the store recorded an
        open grant for are looked up, so this is free when there is nothing to do.
        """
        records = self._store.open_grants(slot_id, generation)
        if not records:
            return []
        for key_arn, grantee_arn in {(record.key_arn, record.grantee_arn) for record in records}:
            for grant in self._list(key_arn, grantee_arn):
                match = _GRANT_NAME.fullmatch(grant.get("Name") or "")
                if (
                    match is not None
                    and match["slot"] == slot_id
                    and int(match["generation"]) < generation
                ):
                    self._revoke(key_arn, grant["GrantId"])
        for record in records:
            if record.grant_id is not None:
                # ListGrants is eventually consistent; revoke a recorded grant
                # by id even when the listing did not show it yet.
                self._revoke(record.key_arn, record.grant_id)
            self._store.mark_grant_retired(record.slot_id, record.generation)
        return [record.generation for record in records]

    def _list(self, key_arn: str, grantee_arn: str) -> list[dict[str, Any]]:
        """Every grant of `grantee_arn` on the key, read in full before any is revoked."""
        request: dict[str, Any] = {
            "KeyId": key_arn,
            "GranteePrincipal": grantee_arn,
            "Limit": 100,
        }
        grants: list[dict[str, Any]] = []
        while True:
            response = self._kms.list_grants(**request)
            grants.extend(response.get("Grants", []))
            if not response.get("Truncated"):
                return grants
            marker = response.get("NextMarker")
            if not marker:
                raise ConfigError("KMS ListGrants reported more grants without a marker.")
            request["Marker"] = marker

    def _revoke(self, key_arn: str, grant_id: str) -> None:
        try:
            self._kms.revoke_grant(KeyId=key_arn, GrantId=grant_id)
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") not in _GONE:
                raise


def _matches(grant: dict[str, Any], grantee_arn: str, constraint: dict[str, str]) -> bool:
    return (
        grant.get("GranteePrincipal") == grantee_arn
        and sorted(grant.get("Operations") or []) == sorted(GRANT_OPERATIONS)
        and grant.get("Constraints") == {"EncryptionContextSubset": constraint}
    )
