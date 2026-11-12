"""Schemathesis hooks for the HTTP property run (`core/tests/switch_core/properties/test_http_surface.py`).

The run asks the gateway as a person in one workspace, after another workspace
has been filled in. `SWITCH_FOREIGN_IDS` names a JSON file of that other
workspace's ids; when it is set,

- a parameter that looks like an id (`id`, `*_id`, `*_ids`) in the path, the
  query (declared ones too, though the generator left them out) or the body is
  sometimes one of them, so the request really asks about another tenant's
  object, and
- `no_foreign_ids` fails a response that contains one the request did not
  itself name, and a successful GET of an object by one (a 404 that repeats the
  id it was asked about is not a leak, nor is a write that echoes it).

`SWITCH_STATUS_COUNTS` names a file the status codes seen are written to when
the run ends, so the test can tell a run that was refused throughout from one
that tested something.
"""

from __future__ import annotations

import atexit
import json
import os
import random
from collections import Counter
from pathlib import Path
from typing import Any

import schemathesis
from hypothesis import strategies as st

_FILE = os.environ.get("SWITCH_FOREIGN_IDS")
FOREIGN_IDS: list[str] = json.loads(Path(_FILE).read_text()) if _FILE else []

STATUSES: Counter[str] = Counter()


def _write_statuses() -> None:
    if destination := os.environ.get("SWITCH_STATUS_COUNTS"):
        Path(destination).write_text(json.dumps(STATUSES))


atexit.register(_write_statuses)


def _looks_like_an_id(name: str) -> bool:
    return name == "id" or name.endswith(("_id", "_ids"))


def _sometimes_foreign(
    parameters: dict[str, Any] | None, declared: list[str]
) -> st.SearchStrategy[Any]:
    """`parameters` with each id-like one, declared or generated, sometimes
    replaced by an id of the other workspace."""
    if not FOREIGN_IDS:
        return st.just(parameters)
    present = parameters or {}
    names = [name for name in {*present, *declared} if _looks_like_an_id(name)]
    if not names:
        return st.just(parameters)
    chosen = {
        name: st.one_of(
            st.just(present[name]) if name in present else st.none(),
            st.sampled_from(FOREIGN_IDS),
        )
        for name in names
    }
    return st.fixed_dictionaries(chosen).map(
        lambda picked: {**present, **{k: v for k, v in picked.items() if v is not None}}
    )


def _foreignise(value: Any, chooser: random.Random, key: str = "") -> Any:
    if isinstance(value, dict):
        return {k: _foreignise(v, chooser, k) for k, v in value.items()}
    if isinstance(value, list):
        return [_foreignise(item, chooser, key) for item in value]
    if isinstance(value, str) and _looks_like_an_id(key) and chooser.random() < 0.5:
        return chooser.choice(FOREIGN_IDS)
    return value


@schemathesis.hook
def flatmap_path_parameters(
    context: schemathesis.HookContext, path_parameters: dict[str, Any] | None
) -> st.SearchStrategy[Any]:
    return _sometimes_foreign(path_parameters, [])


@schemathesis.hook
def flatmap_query(
    context: schemathesis.HookContext, query: dict[str, Any] | None
) -> st.SearchStrategy[Any]:
    declared = [parameter.name for parameter in context.operation.query]
    return _sometimes_foreign(query, declared)


@schemathesis.hook
def flatmap_body(
    context: schemathesis.HookContext, body: Any
) -> st.SearchStrategy[Any]:
    if not FOREIGN_IDS or not isinstance(body, dict | list):
        return st.just(body)
    return st.randoms(use_true_random=False).map(
        lambda chooser: _foreignise(body, chooser)
    )


@schemathesis.hook
def after_call(
    context: schemathesis.HookContext,
    case: schemathesis.Case,
    response: Any,
) -> None:
    STATUSES[str(response.status_code)] += 1


@schemathesis.check
def no_foreign_ids(
    ctx: schemathesis.CheckContext,
    response: schemathesis.Response,
    case: schemathesis.Case,
) -> None:
    """`tenancy.no-cross-tenant-ids`: no response contains an id of the other
    workspace that the request did not itself name, and a read of an object by
    an id of the other workspace is never answered with it.

    A write that echoes an id it was sent (an idempotent delete answering with
    the id it was asked to delete) is not a leak, so the second part is for
    GET alone."""
    if not FOREIGN_IDS:
        return
    asked = json.dumps(
        [case.path_parameters, case.query, case.body, case.headers], default=str
    )
    named_in_path = json.dumps(case.path_parameters, default=str)
    read_succeeded = case.method.upper() == "GET" and 200 <= response.status_code < 300
    found = sorted(
        foreign
        for foreign in FOREIGN_IDS
        if foreign in response.text
        and (foreign not in asked or (read_succeeded and foreign in named_in_path))
    )
    if found:
        raise AssertionError(
            f"the {response.status_code} response to {case.method} "
            f"{case.formatted_path} names another workspace's id(s): "
            f"{', '.join(found[:5])}"
        )
