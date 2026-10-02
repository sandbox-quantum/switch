"""Letting go of an organisation: what a removed Teams bridge leaves behind.

Shared by a bridge removing itself (`TeamsAdapter.withdraw`) and the
deployment's app doing it for a bridge that is not running
(`TeamsSharedApp.withdraw_from_org`), so the two leave the same nothing behind.

Best effort, item by item: a removal is what someone asked for and goes ahead
whatever these manage, so one subscription or team that cannot be undone is
reported and the rest are still tried. Each returns what it could not do, in
words fit for a log line.
"""

from __future__ import annotations

from collections.abc import Iterable

from switch_core.bridges.collaboration.teams.graph import GraphClient
from switch_core.bridges.collaboration.teams.identity import TeamsIdentity


async def delete_own_subscriptions(
    graph: GraphClient, *, identity: TeamsIdentity, known: Iterable[str]
) -> list[str]:
    """Delete every subscription that delivers to this deployment.

    `known` are the ones the bridge holds; Graph is asked as well, so one the
    bridge failed to adopt goes too, whichever clientState key it was made
    under.
    """
    subscription_ids = set(known)
    left_behind: list[str] = []
    try:
        for sub in await graph.list_subscriptions():
            if identity.delivers_here(str(sub.get("notificationUrl") or "")):
                subscription_ids.add(str(sub.get("id") or ""))
    except Exception as error:
        left_behind.append(f"listing subscriptions failed ({error})")
    for subscription_id in sorted(s for s in subscription_ids if s):
        try:
            await graph.delete_subscription(subscription_id=subscription_id)
        except Exception as error:
            left_behind.append(f"subscription {subscription_id} ({error})")
    return left_behind


async def leave_every_team(graph: GraphClient, *, app_id: str) -> list[str]:
    """Take the app out of every team in the organisation it is in.

    Every team, not only those the bridge learned of: an install whose join
    was never seen would otherwise stay, unable to answer. Each team is asked
    on its own, since nothing answers this for the organisation at once.
    """
    left_behind: list[str] = []
    try:
        teams = await graph.list_teams()
    except Exception as error:
        return [f"listing the organisation's teams failed ({error})"]
    for team in teams:
        team_id = str(team.get("id") or "")
        if not team_id:
            continue
        try:
            for installation in await graph.find_app_installations(
                team_id=team_id, external_id=app_id
            ):
                await graph.uninstall_app(
                    team_id=team_id, installation_id=installation.installation_id
                )
        except Exception as error:
            left_behind.append(f"the app in team {team_id} ({error})")
    return left_behind
