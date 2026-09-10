"""The deployment-wide agent-registration bootstrap credential.

``AGENT_REGISTRATION_TOKEN`` is seeded once at startup as an ``ApiKey`` of
type ``"bootstrap"`` (see ``main.py``) so a fresh deployment has *some* way to
register its first agents before any user has logged into the gateway to mint
a personal one (``gateway/api_keys.py``, type ``"registration"``).

A ``"registration"`` key is minted by, and owned by, a single user: agents it
registers are attributed to that user directly. A ``"bootstrap"`` key has no
such owner in mind — it is handed to whoever needs to bring an agent up
against a fresh deployment — so agents registered through it are attributed
to a dedicated, non-admin account (see :data:`BOOTSTRAP_OWNER_EMAIL`) instead
of the seeded admin. Otherwise every holder of that one shared secret would
register agents that inherit the admin's authority over every room and
resource in the deployment, not just their own.

That guarantee only holds if the account at :data:`BOOTSTRAP_OWNER_EMAIL` is
the one this module itself provisioned. Nothing in this codebase reserves
that address, and an admin role is not the only way to end up controlling
it: a gateway admin can `POST /users` with that email and an admin role, but
an OIDC identity provider can also claim it outright by asserting it as a
login email — JIT provisioning always creates a `role="user"` account, so an
account's mere existence there proves nothing about who put it there. Both
entry points here refuse to adopt an existing account at that address unless
it is provably genuine, and refuse an admin role on top of that as a second,
independent check.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ApiKey, User
from switch_core.db.stores.user_store import UserStore

BOOTSTRAP_KEY_TYPE = "bootstrap"

# Every ApiKey type that may stand in for a registration token at the
# `POST /agents` family of endpoints. Anything else (in practice, an agent's
# own `"agent"`-type key, or a `RETIRED_KEY_TYPE` row) must not be replayed
# to register more agents.
REGISTRATION_KEY_TYPES = ("registration", BOOTSTRAP_KEY_TYPE)

# Assigned to a stale legacy-labeled key at startup instead of deleting it:
# not in REGISTRATION_KEY_TYPES, so it stops authenticating exactly as
# deletion would, but the row (and its label, rewritten to say so) stays on
# the gateway's API Keys page for a human to notice and remove — a deleted
# row leaves nothing but a startup log line, and the two cases this can be
# (a stale rotated-out bootstrap key, or an unrelated personal key that
# happened to share the auto-generated label) are not distinguishable at
# seed time, so the evidence needs to survive for a human to tell afterward.
RETIRED_KEY_TYPE = "retired"

# Synthetic account, never logged into (no password), that owns every agent
# registered through the deployment-wide bootstrap key. Kept distinct from
# the admin user specifically so that key confers no admin authority.
BOOTSTRAP_OWNER_EMAIL = "agent-bootstrap@switch.local"
BOOTSTRAP_OWNER_NAME = "Agent Bootstrap"

# Stamped into the bootstrap owner's metadata by this module's own creation
# path. An account found at BOOTSTRAP_OWNER_EMAIL without this marker was put
# there by something else — a gateway admin, an OIDC login claiming the
# address before this ever ran — *unless* it already carries
# BOOTSTRAP_LAST_SEEDED_HASH_META_KEY (below): that key is written only by
# this module's own seeding step, so its presence on an unmarked row proves
# the row predates the marker (created by an earlier version of this
# feature) rather than being squatted — a squatter cannot have written a
# value only this code ever writes. Backfilled onto such a row rather than
# refused, so upgrading past the commit that introduced the marker does not
# brick a database this already ran against.
BOOTSTRAP_OWNER_MARKER_META_KEY = "agent_bootstrap_owner"

BOOTSTRAP_KEY_LABEL = "Deployment bootstrap (from AGENT_REGISTRATION_TOKEN)"

# Label of the key this replaces, from before agent-registration bootstrap
# had its own owner and its own ApiKey type. Startup seeding uses this,
# together with a hash match against the configured token, to find and
# migrate an existing deployment's old admin-owned key in place rather than
# leaving it live alongside a new one.
LEGACY_BOOTSTRAP_KEY_LABEL = "Default (from AGENT_REGISTRATION_TOKEN)"

# Both persisted on the bootstrap owner's own metadata, never on the admin's:
# the admin a deployment resolves to is a mutable config value
# (`GATEWAY_ADMIN_EMAIL`), so a marker filed there stops meaning what it says
# the moment that value changes. The bootstrap owner's email is a fixed
# constant, so these survive an admin-email change intact.
#
# `..._LAST_HASH...` is the hash of the bootstrap key as of the last seed
# call, used only to notice that a key present last time is now gone (i.e. it
# was just revoked) so its hash can be recorded below.
#
# `..._REVOKED_HASHES...` is every hash ever revoked this way. A hash on this
# list is refused forever, even if the currently active key or the
# configured token later returns to it — recording only the single
# most-recently-revoked value would let one rotation forward and one back
# silently reinstate a value the operator deliberately killed.
BOOTSTRAP_LAST_SEEDED_HASH_META_KEY = "agent_bootstrap_key_last_hash"
BOOTSTRAP_REVOKED_HASHES_META_KEY = "agent_bootstrap_revoked_hashes"


def _is_genuine(owner: User) -> bool:
    meta = owner.metadata_ or {}
    if meta.get(BOOTSTRAP_OWNER_MARKER_META_KEY):
        return True
    return BOOTSTRAP_LAST_SEEDED_HASH_META_KEY in meta


def _raise_unless_genuine(owner: User) -> None:
    if not _is_genuine(owner):
        raise RuntimeError(
            f"An account already exists at {BOOTSTRAP_OWNER_EMAIL} but "
            "cannot be proven to have been created by agent-registration "
            "bootstrap seeding, so it cannot be trusted to carry no admin "
            "authority now or later. Two things produce this: something "
            "else claimed the address (a gateway admin, an OIDC login), or "
            "it was created by an earlier revision of this feature that "
            "recorded its own state on the admin's account instead of here "
            "and so left no evidence on this row to check. Either way, "
            "there is no gateway endpoint that removes or renames a user: "
            "this needs a direct edit to the users table before "
            "agent-registration bootstrap can run."
        )
    if owner.role == "admin":
        raise RuntimeError(
            f"{BOOTSTRAP_OWNER_EMAIL} must never be an admin, but the "
            "account at that address currently has the admin role. There is "
            "no gateway endpoint that changes a user's role: this needs a "
            "direct edit to the users table before agent-registration "
            "bootstrap can run."
        )


async def ensure_bootstrap_owner(session: AsyncSession, user_store: UserStore) -> User:
    """Idempotently create the account bootstrap-registered agents are owned by.

    Raises if an account already exists at that address that cannot be
    proven genuine (see ``_is_genuine``), or that has since been given the
    admin role. A genuine row created before the marker existed is backfilled
    with one here rather than refused.
    """
    owner = await user_store.get_by_email(session, BOOTSTRAP_OWNER_EMAIL)
    if owner is not None:
        _raise_unless_genuine(owner)
        if not (owner.metadata_ or {}).get(BOOTSTRAP_OWNER_MARKER_META_KEY):
            meta = dict(owner.metadata_ or {})
            meta[BOOTSTRAP_OWNER_MARKER_META_KEY] = True
            owner.metadata_ = meta
        return owner
    owner = User(
        name=BOOTSTRAP_OWNER_NAME,
        email=BOOTSTRAP_OWNER_EMAIL,
        role="user",
        metadata_={BOOTSTRAP_OWNER_MARKER_META_KEY: True},
    )
    await user_store.create(session, owner)
    return owner


async def resolve_registration_owner_id(
    session: AsyncSession, user_store: UserStore, key: ApiKey
) -> str:
    """The user new agents should be owned by, given the key used to register them.

    ``key`` must already be validated as one of ``REGISTRATION_KEY_TYPES``.
    Raises if a bootstrap key resolves to an account that cannot be proven
    genuine, or one that has since been given the admin role —
    ``ensure_bootstrap_owner`` only runs at startup, so this is the check
    that catches either happening afterward.
    """
    if key.type != BOOTSTRAP_KEY_TYPE:
        return key.user_id
    owner = await user_store.get_by_email(session, BOOTSTRAP_OWNER_EMAIL)
    if owner is None:
        raise RuntimeError(
            f"Agent-registration bootstrap owner ({BOOTSTRAP_OWNER_EMAIL}) is "
            "missing; restart the server to reseed it."
        )
    _raise_unless_genuine(owner)
    return owner.id
