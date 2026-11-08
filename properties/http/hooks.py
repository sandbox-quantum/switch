"""Schemathesis hooks for the HTTP property run (`core/tests/switch_core/properties/test_http_surface.py`).

The run asks the gateway as a person in one workspace, after another workspace
has been filled in. `SWITCH_FOREIGN_IDS` names a JSON file of that other
workspace's ids; when it is set,

- a path or query parameter that looks like an id (`id`, `*_id`) is sometimes
  one of them, so the request really asks about another tenant's object, and
- `no_foreign_ids` fails any response that contains one, unless the request
  itself did (a 404 that repeats the id it was asked about is not a leak).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import schemathesis
from hypothesis import strategies as st

_FILE = os.environ.get("SWITCH_FOREIGN_IDS")
FOREIGN_IDS: list[str] = json.loads(Path(_FILE).read_text()) if _FILE else []


def _looks_like_an_id(name: str) -> bool:
    return name == "id" or name.endswith("_id")


def _sometimes_foreign(parameters: dict[str, Any] | None) -> st.SearchStrategy[Any]:
    if not FOREIGN_IDS or not parameters:
        return st.just(parameters)
    chosen = {
        name: st.one_of(st.just(value), st.sampled_from(FOREIGN_IDS))
        for name, value in parameters.items()
        if _looks_like_an_id(name)
    }
    return st.fixed_dictionaries(chosen).map(lambda picked: {**parameters, **picked})


@schemathesis.hook
def flatmap_path_parameters(
    context: schemathesis.HookContext, path_parameters: dict[str, Any] | None
) -> st.SearchStrategy[Any]:
    return _sometimes_foreign(path_parameters)


@schemathesis.hook
def flatmap_query(
    context: schemathesis.HookContext, query: dict[str, Any] | None
) -> st.SearchStrategy[Any]:
    return _sometimes_foreign(query)


@schemathesis.check
def no_foreign_ids(
    ctx: schemathesis.CheckContext,
    response: schemathesis.Response,
    case: schemathesis.Case,
) -> None:
    """`tenancy.no-cross-tenant-ids`: no response contains an id of the other
    workspace that the request did not itself name."""
    if not FOREIGN_IDS:
        return
    asked = json.dumps(
        [case.path_parameters, case.query, case.body, case.headers], default=str
    )
    found = sorted(
        {
            foreign
            for foreign in FOREIGN_IDS
            if foreign in response.text and foreign not in asked
        }
    )
    if found:
        raise AssertionError(
            f"the response to {case.method} {case.formatted_path} names "
            f"another workspace's id(s): {', '.join(found[:5])}"
        )
