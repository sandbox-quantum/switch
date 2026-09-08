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
never an admin. Nothing in this codebase reserves that address — a gateway
admin can `POST /users` with it and an admin role, and an OIDC identity
provider can assert it as someone's login email — so both entry points here
verify the resolved account's role and refuse rather than silently adopting
an admin.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.models import ApiKey, User
from switch_core.db.stores.user_store import UserStore

BOOTSTRAP_KEY_TYPE = "bootstrap"

# Every ApiKey type that may stand in for a registration token at the
# `POST /agents` family of endpoints. Anything else (in practice, an agent's
# own `"agent"`-type key) must not be replayed to register more agents.
REGISTRATION_KEY_TYPES = ("registration", BOOTSTRAP_KEY_TYPE)

# Synthetic account, never logged into (no password), that owns every agent
# registered through the deployment-wide bootstrap key. Kept distinct from
# the admin user specifically so that key confers no admin authority.
BOOTSTRAP_OWNER_EMAIL = "agent-bootstrap@switch.local"
BOOTSTRAP_OWNER_NAME = "Agent Bootstrap"

BOOTSTRAP_KEY_LABEL = "Deployment bootstrap (from AGENT_REGISTRATION_TOKEN)"

# Label of the key this replaces, from before agent-registration bootstrap
# had its own owner and its own ApiKey type. Startup seeding uses this,
# together with a hash match against the configured token, to find and
# migrate an existing deployment's old admin-owned key in place rather than
# leaving it live alongside a new one.
LEGACY_BOOTSTRAP_KEY_LABEL = "Default (from AGENT_REGISTRATION_TOKEN)"

# Persisted on the bootstrap owner's own metadata (never on the admin's): the
# admin a deployment resolves to is a mutable config value (`GATEWAY_ADMIN_EMAIL`),
# so a marker filed there stops meaning what it says the moment that value
# changes. The bootstrap owner's email is a fixed constant, so this survives
# an admin-email change intact. It records the hash of the token last seeded
# rather than a bare boolean so a revoked key stays revoked only for the
# value it was revoked at: rotating AGENT_REGISTRATION_TOKEN to a new value
# re-establishes bootstrap registration without touching the database by
# hand, while restarting with the same, already-revoked value does not.
BOOTSTRAP_LAST_SEEDED_HASH_META_KEY = "agent_bootstrap_key_last_hash"


def _raise_if_admin(owner: User) -> None:
    if owner.role == "admin":
        raise RuntimeError(
            f"{BOOTSTRAP_OWNER_EMAIL} is reserved for agent-registration "
            "bootstrap and must never be an admin, but the account at that "
            "address currently has the admin role. Demote or remove it "
            "before agent-registration bootstrap can run."
        )


async def ensure_bootstrap_owner(session: AsyncSession, user_store: UserStore) -> User:
    """Idempotently create the account bootstrap-registered agents are owned by.

    Raises if an account already exists at that address with the admin role.
    """
    owner = await user_store.get_by_email(session, BOOTSTRAP_OWNER_EMAIL)
    if owner is not None:
        _raise_if_admin(owner)
        return owner
    owner = User(name=BOOTSTRAP_OWNER_NAME, email=BOOTSTRAP_OWNER_EMAIL, role="user")
    await user_store.create(session, owner)
    return owner


async def resolve_registration_owner_id(
    session: AsyncSession, user_store: UserStore, key: ApiKey
) -> str:
    """The user new agents should be owned by, given the key used to register them.

    ``key`` must already be validated as one of ``REGISTRATION_KEY_TYPES``.
    Raises if a bootstrap key resolves to an account that has since been
    promoted to admin — ``ensure_bootstrap_owner`` only runs at startup, so
    this is the check that catches a later promotion.
    """
    if key.type != BOOTSTRAP_KEY_TYPE:
        return key.user_id
    owner = await user_store.get_by_email(session, BOOTSTRAP_OWNER_EMAIL)
    if owner is None:
        raise RuntimeError(
            f"Agent-registration bootstrap owner ({BOOTSTRAP_OWNER_EMAIL}) is "
            "missing; restart the server to reseed it."
        )
    _raise_if_admin(owner)
    return owner.id
