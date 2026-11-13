"""What a chat account can do about its own links to Switch users, from the
account itself: confirm one with a code (CHOO-3881), list them, or drop one.

The bridge that hears these commands answers them itself, without a room
(CHOO-4121): none of them is about a room, and a person linking an account
they have only just made may not be in any channel Switch is in. The in-room
handlers in `bridges/agent/commands.py` call the same functions, for a command
typed somewhere else.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from switch_core.db.audit import AuditAction, record_audit_event
from switch_core.db.models import CollaborationBridge, ExternalUser
from switch_core.db.stores.external_user_store import (
    CodeNotAccepted,
    ExternalUserStore,
    NoSuchLink,
)
from switch_core.db.stores.user_store import UserStore

# Answered by the bridge that heard them, never relayed into a room.
ACCOUNT_COMMANDS = frozenset({"link-account", "unlink-account"})

LINK_USAGE = (
    "Usage: `link-account CODE`, with the code Switch showed you when you "
    "linked this account."
)
CODE_REFUSED = (
    "⚠️ That code doesn't match a link waiting for this account, or it has "
    "expired. Get a new code in Switch, and post it from the account you're "
    "linking."
)
NOT_LINKED = "This account isn't linked to any Switch user."


def linked_notice(platform: str, username: str, name: str, *, ran_command: bool) -> str:
    """What the account is told once a link is confirmed.

    Names the Switch user, so whoever confirmed it sees who the account is now
    recognised as, and how to take that back if it is not them. "The way you
    ran this" because platforms differ in how a command reaches Switch: typed
    with `!`, as a slash command, or with the app mentioned. A link confirmed
    by tapping a prompt (`ran_command=False`) had no command to point back at.
    """
    how = "the way you ran this command" if ran_command else "from this account"
    return (
        f"✅ Linked this {platform} account ({username}) to Switch user "
        f"**{name}**. If that isn't you, run `unlink-account {name}` {how}."
    )


async def confirm_with_code(
    session: AsyncSession,
    *,
    external_user_store: ExternalUserStore,
    user_store: UserStore,
    account: ExternalUser,
    code: str,
    only_here: bool,
) -> str | None:
    """Confirm the link `code` was issued for, from the account that posted
    it, and say what happened.

    `only_here` says the command reached this server alone: a slash command,
    a button, or a direct conversation with this app. A code typed in a
    channel can reach the apps of several Switch servers sharing a workspace,
    and only the one it was issued on should answer: a server with no link
    waiting for the account says nothing (None) rather than contradicting the
    one that linked it. A wrong or expired code still gets an answer from the
    server waiting for one.

    Only the Switch user was shown the code, and the platform says which
    account posted it, so a match proves one person holds both. A code posted
    from any other account matches nothing, which is why posting it in a busy
    channel gives nothing away.

    The caller replies after closing `session`: a rejected code may have
    locked the request it was checked against, and nobody should wait on that
    while a reply is written.
    """
    try:
        request = await external_user_store.redeem_link_code(
            session, account, code, user_store
        )
    except CodeNotAccepted:
        if only_here or await external_user_store.has_link_request(session, account):
            return CODE_REFUSED
        return None
    return await record_confirmed_link(
        session,
        user_store=user_store,
        account=account,
        user_id=request.user_id,
        by="code",
        ran_command=True,
    )


async def record_confirmed_link(
    session: AsyncSession,
    *,
    user_store: UserStore,
    account: ExternalUser,
    user_id: str,
    by: str,
    ran_command: bool,
) -> str:
    """Audit a link `account` has just confirmed to `user_id`, commit, and say
    what to tell the account.

    The one place a confirmation is recorded, whichever proof the account
    gave: a code it posted (`by="code"`) or a number it tapped
    (`by="prompt"`).
    """
    linked = await user_store.get(session, user_id)
    bridge = await session.get(CollaborationBridge, account.bridge_id)
    # Both are held by foreign keys from the rows just written.
    if linked is None or bridge is None:
        raise RuntimeError(
            f"Confirmed a link for user {user_id} on bridge "
            f"{account.bridge_id}, but could not read either back"
        )
    name, platform = linked.name, bridge.display_name
    username = account.external_username
    await record_audit_event(
        session,
        tenant_id=account.tenant_id,
        actor_user_id=user_id,
        action=AuditAction.BRIDGE_IDENTITY_CLAIMED,
        target_type="external_user",
        target_id=account.id,
        details={"bridge_id": account.bridge_id, "user_id": user_id, "by": by},
    )
    await session.commit()
    return linked_notice(platform, username, name, ran_command=ran_command)


def strip_quotes(text: str) -> str:
    text = text.strip()
    for opening, closing in (('"', '"'), ("'", "'"), ("\u201c", "\u201d")):
        if len(text) >= 2 and text.startswith(opening) and text.endswith(closing):
            return text[1:-1].strip()
    return text


async def unlink_account(
    session: AsyncSession,
    *,
    external_user_store: ExternalUserStore,
    user_store: UserStore,
    account: ExternalUser,
    wanted: str,
    only_here: bool,
) -> str | None:
    """List the Switch users this account is linked to, or remove the one
    `wanted` names, and say what happened.

    Says nothing (None) when the account has no links here and the command
    may have reached other Switch servers too (`only_here`, as for
    `confirm_with_code`): one of them may have the link.

    The account's own say over its links, for someone who has no Switch login
    to fix one with: a link confirmed by mistake, or one made before links
    needed confirming. It only ever touches `account`.
    """
    wanted = strip_quotes(wanted)
    claims = (await external_user_store.claims_for(session, [account.id])).get(
        account.id, []
    )
    users = {
        user.id: user
        for user in await user_store.get_many(session, [c.user_id for c in claims])
    }
    linked = sorted(
        (
            (users[c.user_id].name, users[c.user_id].email, c)
            for c in claims
            if c.user_id in users
        ),
        key=lambda entry: entry[0].casefold(),
    )
    listing = "\n".join(
        f"- **{name}**"
        + (
            ""
            if claim.verified_at is not None
            else " (made before links needed confirming)"
        )
        for name, _email, claim in linked
    )

    if not linked and not only_here:
        return None
    if not wanted:
        if not linked:
            return NOT_LINKED
        return (
            f"This account is linked to:\n{listing}\n\nRun "
            "`unlink-account NAME` the way you ran this command to remove one."
        )

    needle = wanted.casefold()
    matches = [
        claim
        for name, email, claim in linked
        if needle in (name.casefold(), email.casefold())
    ]
    if not matches:
        return f"⚠️ This account isn't linked to a Switch user called **{wanted}**." + (
            f" It is linked to:\n{listing}" if linked else ""
        )
    if len(matches) > 1:
        return (
            f"⚠️ More than one Switch user linked to this account goes by "
            f"**{wanted}**. Run `unlink-account` with their email instead."
        )
    user_id = matches[0].user_id
    name = users[user_id].name
    try:
        await external_user_store.release(session, account, user_id)
    except NoSuchLink:
        # Unlinked some other way while this ran: the outcome asked for.
        return f"This account is no longer linked to Switch user **{name}**."
    await record_audit_event(
        session,
        tenant_id=account.tenant_id,
        actor_user_id=None,
        action=AuditAction.BRIDGE_IDENTITY_RELEASED,
        target_type="external_user",
        target_id=account.id,
        details={
            "bridge_id": account.bridge_id,
            "user_id": user_id,
            "by": "chat_account",
        },
    )
    await session.commit()
    return f"Unlinked this account from Switch user **{name}**."
