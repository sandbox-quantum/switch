"""A reference model of who a message is for, and the room states and messages
to compare it with the router on.

The reference is written from the rules as Switch states them, not from the
code that implements them: it scans text by hand instead of using
`clients/mentions.py`'s regular expressions, and reads policies from plain
data instead of `switch_core.addressing`. A message is for an agent in the room
when it names the agent and the agent's policy lets the sender address it:

- it names an agent by `@name`, by the `@alias` the agent goes under in the
  room, by the `@role` it holds there while its lease is live, by a mention
  pill carrying its id, or by being the only agent in a direct room;
- `@x` is a mention of `x` when the `@` does not follow a letter or digit,
  the letters match regardless of case, and the name characters after it
  (`.`, `_`, `-`) reach no letter or digit; four non-ASCII letters count as
  the ASCII ones they fold to (`FOLDS_TO`);
- `*` and `~` are emphasis and ignored, and each `@name` a Switch Console send
  says names a person is not a mention of anyone;
- a Switch notice (`com.switch.admin`) names nobody, and nobody's own message
  is for themselves;
- an agent with no policy may be addressed by anyone but the platform; with
  one, by whoever one of its rules admits, and by nobody when the sender is
  someone Switch cannot name.

The world (`World`) is made once per test and committed: agents with names
that are prefixes of each other, their owners, the people and the platform
who send. Each example's room is made inside a transaction that is rolled
back once the router has decided the row.
"""

from __future__ import annotations

import string
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import hypothesis.strategies as st
from sqlalchemy import insert

from switch_core.chats import MEMBER_CLIENT_TYPE
from switch_core.db.models import (
    TENANT_ZERO_ID,
    Agent,
    ApiKey,
    Client,
    ClientRoom,
    CollaborationBridge,
    ExternalUser,
    ExternalUserClaim,
    RoleLease,
    Room,
    RoomGroup,
    RoomRole,
    User,
    room_agents,
)
from switch_core.db.session_scope import tenant_session

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

ADMIN_MARKER = "com.switch.admin"
PLATFORM_MARKER = "com.switch.platform"
MENTIONS_KEY = "com.switch.mentions"

OWNERS = ("olga", "pete", "quinn")
# Each agent's owner. kit-2 has none.
AGENTS: dict[str, str | None] = {
    "ana": "olga",
    "anabel": "pete",
    "ana.dev": "olga",
    "bo_t": "quinn",
    "kit-2": None,
    "sam": "pete",
}
# The platform accounts people post from, and who has claimed each.
ACCOUNTS: dict[str, tuple[str, ...]] = {
    "olga-slack": ("olga",),
    "shared-slack": ("olga", "pete"),
    "nobody-slack": (),
}
# Who can send: a person nobody can name, a platform account, a Switch user in
# person (a chat member client), an agent, or the platform.
SENDERS = (
    "stranger",
    *(f"account:{name}" for name in ACCOUNTS),
    "member:pete",
    *(f"agent:{name}" for name in AGENTS),
    "platform",
)
GROUPS = ("g1", "g2")
ALIASES = ("ana", "anabel", "rev", "rev.x", "Bo_T", "lead")
ROLES = ("reviewer", "rev", "ana", "ops", "lead")
CHANNEL_TYPES = ("direct", "channel_public", "channel_private", None)

# Where a policy names the example's own room, or another one.
THIS_ROOM = "<this room>"
OTHER_ROOM = "<another room>"


@dataclass(frozen=True)
class World:
    """The ids of everything made once per test."""

    users: dict[str, str]
    agents: dict[str, str]
    agent_clients: dict[str, str]
    agent_transport_ids: dict[str, str]
    accounts: dict[str, str]
    account_transport_ids: dict[str, str]
    member_pete: tuple[str, str]
    stranger: str
    platform: tuple[str, str]
    groups: dict[str, str]


async def make_world(session_factory: async_sessionmaker[AsyncSession]) -> World:
    async with tenant_session(session_factory, TENANT_ZERO_ID) as session:
        users = {}
        for name in OWNERS:
            user = User(name=name, email=f"{name}@test.local", role="user")
            session.add(user)
            await session.flush()
            users[name] = user.id
        agents, agent_clients, agent_transport_ids = {}, {}, {}
        for name, owner in AGENTS.items():
            key = ApiKey(
                user_id=users["olga"],
                key_hash=f"hash-{uuid.uuid4().hex}",
                encrypted_key="enc",
                label=name,
                type="agent",
            )
            client = Client(
                transport_user_id=f"@{name}-{uuid.uuid4().hex[:8]}:test",
                display_name=name,
                type="agent",
            )
            session.add_all([key, client])
            await session.flush()
            agent = Agent(
                name=name,
                description="",
                agent_type="always_on",
                connector_type="claude_code",
                integration_profile={"connection_model": "always_on"},
                client_id=client.id,
                api_key_id=key.id,
                owner_id=users[owner] if owner is not None else None,
            )
            session.add(agent)
            await session.flush()
            agents[name] = agent.id
            agent_clients[name] = client.id
            agent_transport_ids[name] = client.transport_user_id
        bridge_client = Client(
            transport_user_id=f"@bridge-{uuid.uuid4().hex[:8]}:test",
            display_name="bridge",
            type="bridge",
        )
        session.add(bridge_client)
        await session.flush()
        bridge = CollaborationBridge(
            type="slack",
            display_name="Slack",
            client_id=bridge_client.id,
            status="active",
        )
        session.add(bridge)
        await session.flush()
        accounts, account_transport_ids = {}, {}
        for name, claimants in ACCOUNTS.items():
            client = Client(
                transport_user_id=f"@slack-{name}-{uuid.uuid4().hex[:6]}:test",
                display_name=name,
                type="user",
            )
            session.add(client)
            await session.flush()
            account = ExternalUser(
                bridge_id=bridge.id,
                external_user_id=f"U-{name}",
                external_username=name,
                client_id=client.id,
            )
            session.add(account)
            await session.flush()
            for claimant in claimants:
                session.add(
                    ExternalUserClaim(
                        external_user_id=account.id, user_id=users[claimant]
                    )
                )
            accounts[name] = account.id
            account_transport_ids[name] = client.transport_user_id
        member = Client(
            transport_user_id=f"@member-pete-{uuid.uuid4().hex[:6]}:test",
            display_name="pete",
            type=MEMBER_CLIENT_TYPE,
            user_id=users["pete"],
        )
        stranger = Client(
            transport_user_id=f"@stranger-{uuid.uuid4().hex[:6]}:test",
            display_name="stranger",
            type="user",
        )
        platform = Client(
            transport_user_id=f"@switch-{uuid.uuid4().hex[:6]}:test",
            display_name="Switch",
            type="admin",
        )
        session.add_all([member, stranger, platform])
        groups = {name: RoomGroup(name=name) for name in GROUPS}
        session.add_all(groups.values())
        await session.flush()
        world = World(
            users=users,
            agents=agents,
            agent_clients=agent_clients,
            agent_transport_ids=agent_transport_ids,
            accounts=accounts,
            account_transport_ids=account_transport_ids,
            member_pete=(member.id, member.transport_user_id),
            stranger=stranger.transport_user_id,
            platform=(platform.id, platform.transport_user_id),
            groups={name: group.id for name, group in groups.items()},
        )
        await session.commit()
    return world


# ── One example ───────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Member:
    agent: str
    alias: str | None
    role: str | None
    role_live: bool
    policy: list[dict[str, Any]] | None


@dataclass(frozen=True)
class Case:
    channel_type: str | None
    group: str | None
    members: tuple[Member, ...]
    sender: str
    body: str
    formatted_body: str | None
    person_names: tuple[str, ...] | None
    admin_marker: bool
    platform_marker: dict[str, Any] | None


def _dimension(values: list[str]) -> st.SearchStrategy[Any]:
    return st.one_of(
        st.just("*"),
        st.just([]),
        st.lists(st.sampled_from(values), min_size=1, max_size=2, unique=True),
    )


rules = st.fixed_dictionaries(
    {
        "rooms": _dimension([THIS_ROOM, OTHER_ROOM]),
        "room_groups": _dimension(list(GROUPS)),
        "users": _dimension([*(f"account:{a}" for a in ACCOUNTS), "member:pete"]),
        "agents": _dimension(list(AGENTS)),
        "owner": st.booleans(),
        "owner_agents": st.booleans(),
        "platform": st.booleans(),
    }
)


def _preset(**admits: Any) -> list[dict[str, Any]]:
    return [
        {
            "rooms": "*",
            "room_groups": "*",
            "users": [],
            "agents": [],
            "owner": False,
            "owner_agents": False,
            "platform": False,
        }
        | admits
    ]


# The policies agents carry in practice: owner-only, the default (the owner
# and their agents), each of those letting the platform in too, and one
# naming an account and an agent.
PRESETS = (
    _preset(owner=True),
    _preset(owner=True, owner_agents=True),
    _preset(owner=True, platform=True),
    _preset(owner=True, owner_agents=True, platform=True),
    _preset(users=["account:shared-slack"], agents=["sam"]),
)
# Half the agents are open, so that most mentions are let through and a row
# is often for several agents.
policies = st.one_of(
    st.none(),
    st.none(),
    st.sampled_from(PRESETS),
    st.lists(rules, min_size=1, max_size=2),
)


@st.composite
def members(draw: st.DrawFn) -> tuple[Member, ...]:
    names = draw(
        st.lists(st.sampled_from(list(AGENTS)), min_size=1, max_size=4, unique=True)
    )
    return tuple(
        Member(
            agent=name,
            alias=draw(st.none() | st.sampled_from(ALIASES)),
            role=draw(st.none() | st.sampled_from(ROLES)),
            role_live=draw(st.booleans()),
            policy=draw(policies),
        )
        for name in names
    )


# What a mention's name may be: a name, alias or role, part of one, or one
# with a letter swapped for a character that only folds to it.
_TARGETS = sorted({*AGENTS, *ALIASES, *ROLES, "an", "anab", "ana.d", "bo", "kit"})
_LOOKALIKES = {"s": "\u017f", "k": "\u212a", "i": "\u0131", "I": "\u0130"}


@st.composite
def _target(draw: st.DrawFn, in_room: list[str]) -> str:
    # Mostly a name the room's agents go by, so that rows are often for
    # someone, and for several agents at once.
    if in_room and draw(st.integers(0, 2)) > 0:
        name = draw(st.sampled_from(in_room))
    else:
        name = draw(st.sampled_from(_TARGETS))
    how = draw(st.sampled_from(["as is", "as is", "upper", "flip", "lookalike"]))
    if how == "upper":
        return name.upper()
    if how == "flip":
        return "".join(c.swapcase() if draw(st.booleans()) else c for c in name)
    if how == "lookalike":
        return "".join(_LOOKALIKES.get(c, c) for c in name)
    return name


_BEFORE = [
    "",
    "",
    "",
    " ",
    " ",
    "x",
    "_",
    "(",
    "*",
    "~",
    ".",
    "-",
    "@",
    "\u212a",
    "\u00e9",
]
_AFTER = [
    "",
    "",
    "",
    " ",
    " ",
    ".",
    "...",
    "-",
    "_",
    ".x",
    "-2",
    "2",
    "_x",
    ",",
    ":",
    "!",
    "'s",
    "@",
    "*",
    "\u017f",
    "\u212a",
    ".\u00e9",
    "-ok",
]
_FILLER = [
    " ",
    " please ",
    "\n",
    "a@ana",
    "root@kit-2",
    "`@sam`",
    "@channel",
    "@",
    "**",
    "~",
    "ok",
]


@st.composite
def bodies(draw: st.DrawFn, in_room: list[str]) -> str:
    mention = st.tuples(
        st.sampled_from(_BEFORE), _target(in_room), st.sampled_from(_AFTER)
    ).map(lambda t: f"{t[0]}@{t[1]}{t[2]}")
    parts = draw(
        st.lists(
            st.one_of(mention, mention, st.sampled_from(_FILLER)),
            max_size=5,
        )
    )
    return "".join(parts)


@st.composite
def platform_markers(draw: st.DrawFn) -> dict[str, Any]:
    which = draw(
        st.sampled_from(["bare", "person", "unclaimed person", "agent", "gone agent"])
    )
    if which == "bare":
        return {}
    if which == "person":
        return {"on_behalf_of": {"user_id": draw(st.sampled_from(["olga", "pete"]))}}
    if which == "unclaimed person":
        return {"on_behalf_of": {"user_id": "quinn"}}
    agent = draw(st.sampled_from(list(AGENTS))) if which == "agent" else "gone"
    return {"on_behalf_of": {"user_id": "olga", "agent_id": agent}}


@st.composite
def cases(draw: st.DrawFn) -> Case:
    in_room = draw(members())
    # Half the time the person or agent the policies are about: an owner of
    # an agent in the room, in person or through an account they claimed, or
    # another agent of that owner.
    owners = {AGENTS[m.agent] for m in in_room} - {None}
    related = [
        sender
        for sender in SENDERS
        if (sender == "member:pete" and "pete" in owners)
        or (
            sender.startswith("account:")
            and owners & set(ACCOUNTS[sender.removeprefix("account:")])
        )
        or (
            sender.startswith("agent:")
            and AGENTS[sender.removeprefix("agent:")] in owners
        )
    ]
    sender = draw(
        st.sampled_from(related) | st.sampled_from(SENDERS)
        if related
        else st.sampled_from(SENDERS)
    )
    body = draw(
        bodies(
            [
                name
                for m in in_room
                for name in (m.agent, m.alias, m.role)
                if name is not None
            ]
        )
    )
    # Mostly a name the body mentions, which is the case the names are there
    # for: a person who shares an agent's name, alias or role.
    said = sorted({name for name in _TARGETS if mentions(body, name)})
    return Case(
        channel_type=draw(st.sampled_from(CHANNEL_TYPES)),
        group=draw(st.none() | st.sampled_from(GROUPS)),
        members=in_room,
        sender=sender,
        body=body,
        formatted_body=draw(
            st.none() | st.sampled_from(list(AGENTS)).map(lambda a: f"<pill:{a}>")
        ),
        person_names=draw(
            st.none()
            | st.lists(
                st.sampled_from(said) | st.sampled_from(_TARGETS)
                if said
                else st.sampled_from(_TARGETS),
                max_size=2,
            ).map(tuple)
        ),
        admin_marker=draw(st.integers(0, 9)) == 0,
        # Every message Switch posts carries one of the two markers
        # (`SystemActor`), so the platform's always has this one. Any other
        # sender may carry it too; only the platform's carries weight.
        platform_marker=draw(platform_markers())
        if sender == "platform" or draw(st.integers(0, 9)) == 0
        else None,
    )


# ── Writing the example's room ────────────────────────────────────────────────


def _resolve_ids(world: World, room_id: str, values: Any) -> Any:
    if values == "*":
        return values
    out = []
    for value in values:
        if value == THIS_ROOM:
            out.append(room_id)
        elif value == OTHER_ROOM:
            out.append("some-other-room")
        elif value in world.groups:
            out.append(world.groups[value])
        elif value.startswith("account:"):
            out.append(world.accounts[value.removeprefix("account:")])
        elif value == "member:pete":
            out.append(world.member_pete[0])
        else:
            out.append(world.agents[value])
    return out


def stored_policy(
    world: World, room_id: str, policy: list[dict[str, Any]] | None
) -> dict[str, Any] | None:
    if policy is None:
        return None
    return {
        "rules": [
            {
                key: (
                    _resolve_ids(world, room_id, value)
                    if key in ("rooms", "room_groups", "users", "agents")
                    else value
                )
                for key, value in rule.items()
            }
            for rule in policy
        ]
    }


async def write_room(session: AsyncSession, world: World, case: Case) -> Room:
    """The example's room, its agents, their aliases, roles and policies, in
    the caller's transaction."""
    room = Room(
        transport_room_id=f"!oracle-{uuid.uuid4().hex[:8]}:test",
        name="oracle",
        description="",
        channel_type=case.channel_type,
        group_id=world.groups[case.group] if case.group is not None else None,
    )
    session.add(room)
    await session.flush()
    roles: dict[str, str] = {}
    for member in case.members:
        agent = await session.get(Agent, world.agents[member.agent])
        assert agent is not None
        agent.addressing_policy = stored_policy(world, room.id, member.policy)
        session.add(
            ClientRoom(client_id=world.agent_clients[member.agent], room_id=room.id)
        )
        await session.execute(
            insert(room_agents).values(
                room_id=room.id,
                agent_id=agent.id,
                alias=member.alias,
                receives_join_events=False,
            )
        )
        if member.role is not None:
            if member.role not in roles:
                role = RoomRole(
                    room_id=room.id,
                    name=member.role,
                    instructions="",
                    exclusive=False,
                )
                session.add(role)
                await session.flush()
                roles[member.role] = role.id
            seen = datetime.now(UTC) - (
                timedelta(0) if member.role_live else timedelta(hours=1)
            )
            session.add(
                RoleLease(
                    role_id=roles[member.role],
                    room_id=room.id,
                    agent_id=agent.id,
                    acquired_at=seen,
                    last_seen_at=seen,
                )
            )
    await session.flush()
    return room


def sender_of(world: World, case: Case) -> tuple[str, str | None]:
    """The sender's transport id, and their client id where the router is told
    it."""
    if case.sender == "stranger":
        return world.stranger, None
    if case.sender.startswith("account:"):
        return world.account_transport_ids[case.sender.removeprefix("account:")], None
    if case.sender == "member:pete":
        return world.member_pete[1], world.member_pete[0]
    if case.sender.startswith("agent:"):
        name = case.sender.removeprefix("agent:")
        return world.agent_transport_ids[name], world.agent_clients[name]
    return world.platform[1], world.platform[0]


def content_of(world: World, case: Case) -> dict[str, Any]:
    content: dict[str, Any] = {"msgtype": "m.text", "body": case.body}
    if case.person_names is not None:
        content[MENTIONS_KEY] = {
            "user_ids": [],
            "person_names": list(case.person_names),
        }
    if case.admin_marker:
        content[ADMIN_MARKER] = {"type": "notice"}
    if case.platform_marker is not None:
        marker = dict(case.platform_marker)
        person = marker.get("on_behalf_of")
        if isinstance(person, dict):
            agent = person.get("agent_id")
            marker["on_behalf_of"] = {
                "user_id": world.users[person["user_id"]],
                "name": person["user_id"],
                **(
                    {"agent_id": world.agents.get(agent, "no-such-agent")}
                    if agent is not None
                    else {}
                ),
            }
        content[PLATFORM_MARKER] = marker
    return content


def formatted_body_of(world: World, case: Case) -> str | None:
    if case.formatted_body is None:
        return None
    agent = case.formatted_body.removeprefix("<pill:").removesuffix(">")
    return f'<a href="https://matrix.to/#/{world.agent_transport_ids[agent]}">x</a>'


# ── The reference ─────────────────────────────────────────────────────────────

# Four letters outside ASCII that a case-insensitive match takes for ASCII
# ones, so they name and bound a mention as those letters would: sam written
# with a long s still names sam, and a Kelvin sign just before `@ana` makes it
# part of a word, naming nobody. Names themselves are ASCII.
FOLDS_TO = {"\u017f": "s", "\u212a": "k", "\u0131": "i", "\u0130": "i"}
_ALNUM = frozenset(string.ascii_letters + string.digits) | FOLDS_TO.keys()
_NAME_CHARS = _ALNUM | frozenset("._-")


def _same_letter(text_char: str, name_char: str) -> bool:
    if name_char in string.ascii_letters:
        folded = FOLDS_TO.get(text_char, text_char)
        return folded in string.ascii_letters and folded.lower() == name_char.lower()
    return text_char == name_char


def _mention_end(text: str, at: int, name: str) -> int | None:
    """Where a mention of `name` starting with the `@` at `at` ends, or None
    when there is none there."""
    if text[at] != "@" or (at > 0 and text[at - 1] in _ALNUM):
        return None
    end = at + 1 + len(name)
    if end > len(text):
        return None
    if not all(
        _same_letter(t, n) for t, n in zip(text[at + 1 : end], name, strict=True)
    ):
        return None
    after = end
    while after < len(text) and text[after] in _NAME_CHARS:
        if text[after] in _ALNUM:
            return None
        after += 1
    return end


def mentions(text: str, name: str) -> bool:
    return any(_mention_end(text, at, name) is not None for at in range(len(text)))


def _without(text: str, name: str) -> str:
    out, at = [], 0
    while at < len(text):
        end = _mention_end(text, at, name)
        if end is None:
            out.append(text[at])
            at += 1
        else:
            at = end
    return "".join(out)


def addressable(case: Case) -> str:
    text = case.body.replace("*", "").replace("~", "")
    for name in case.person_names or ():
        if name:
            text = _without(text, name)
    return text


@dataclass(frozen=True)
class Principal:
    kind: str  # "user", "agent" or "platform"
    ids: tuple[str, ...]  # the ids a rule's list may name; any one matching admits
    user_ids: tuple[str, ...]  # the Switch users a person is (for `owner`)
    owner: str | None  # an agent sender's owner (for `owner_agents`)


def _principal(case: Case) -> Principal | None:
    """Who the sender is in a policy's terms, by name rather than id; None for
    someone Switch cannot name."""
    sender = case.sender
    if sender == "stranger":
        return None
    if sender.startswith("account:"):
        name = sender.removeprefix("account:")
        return Principal("user", (sender,), ACCOUNTS[name], None)
    if sender == "member:pete":
        return Principal("user", (sender,), ("pete",), None)
    if sender.startswith("agent:"):
        name = sender.removeprefix("agent:")
        return Principal("agent", (name,), (), AGENTS[name])
    person = (case.platform_marker or {}).get("on_behalf_of")
    if person is None:
        return Principal("platform", (), (), None)
    agent = person.get("agent_id")
    if agent is not None:
        if agent in AGENTS:
            return Principal("agent", (agent,), (), AGENTS[agent])
        return Principal("platform", (), (), None)
    user = person["user_id"]
    claimed = tuple(
        f"account:{name}" for name, claimants in ACCOUNTS.items() if user in claimants
    )
    return Principal("user", claimed, (user,), None)


def _admits(dimension: Any, value: str | None) -> bool:
    return dimension == "*" or (value is not None and value in dimension)


def _rule_admits(rule: dict[str, Any], case: Case, agent: str, who: Principal) -> bool:
    if not _admits(rule["rooms"], THIS_ROOM):
        return False
    if not _admits(rule["room_groups"], case.group):
        return False
    if who.kind == "platform":
        return bool(rule["platform"])
    owner = AGENTS[agent]
    if who.kind == "user":
        if rule["owner"] and owner is not None and owner in who.user_ids:
            return True
        return any(_admits(rule["users"], i) for i in who.ids) or (
            not who.ids and rule["users"] == "*"
        )
    if rule["owner_agents"] and owner is not None and who.owner == owner:
        return True
    return any(_admits(rule["agents"], i) for i in who.ids)


def permitted(case: Case, member: Member) -> bool:
    who = _principal(case)
    if member.policy is None:
        return who is None or who.kind != "platform"
    if who is None:
        return False
    return any(_rule_admits(rule, case, member.agent, who) for rule in member.policy)


def named(case: Case, member: Member, text: str) -> bool:
    if case.formatted_body == f"<pill:{member.agent}>":
        return True
    if mentions(text, member.agent):
        return True
    if case.channel_type == "direct" and len(case.members) == 1:
        return True
    if member.alias and mentions(text, member.alias):
        return True
    return bool(member.role and member.role_live and mentions(text, member.role))


def expected(case: Case) -> set[str]:
    """The agents the message is for, by name."""
    if case.admin_marker:
        return set()
    text = addressable(case)
    return {
        member.agent
        for member in case.members
        if case.sender != f"agent:{member.agent}"
        and named(case, member, text)
        and permitted(case, member)
    }
