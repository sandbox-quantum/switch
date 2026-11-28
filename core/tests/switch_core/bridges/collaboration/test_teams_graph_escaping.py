"""Values Switch puts inside a Graph `$search` or `$filter` stay one value."""

from __future__ import annotations

import httpx

from switch_core.bridges.collaboration.teams.graph import GraphClient, odata_string


class _Tokens:
    async def graph_token(self) -> str:
        return "token"


async def _searched_for(query: str) -> str:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"value": []})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
        graph = GraphClient(tokens=_Tokens(), http=http)  # type: ignore[arg-type]
        await graph.search_users(query=query)
    return seen[0].url.params["$search"]


async def test_a_user_search_escapes_backslashes_and_quotes() -> None:
    search = await _searched_for('a\\" OR "mail:x\'')

    term = 'a\\\\\\" OR \\"mail:x\''
    assert search == (
        f'"displayName:{term}" OR "mail:{term}" OR "userPrincipalName:{term}"'
    )


async def test_a_trailing_backslash_cannot_escape_the_closing_quote() -> None:
    search = await _searched_for("ada\\")

    assert search.startswith('"displayName:ada\\\\" OR ')


def test_an_odata_string_doubles_single_quotes() -> None:
    assert odata_string("it's") == "'it''s'"
    assert odata_string('a\\b"c') == "'a\\b\"c'"
