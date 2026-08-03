"""The agent operation registry — the single definition of what an agent can do.

Both agent-facing front doors are built from this: the HTTP operations endpoint
dispatches into it, and the MCP server registers its tools from it. Neither
owns the operations, so neither can drift from the other, and removing a door
is removing a door rather than a refactor of everything underneath.

An operation is a plain async function. It takes its arguments and nothing
else — who is calling and which connection they belong to come from the call
context, so operations carry no transport types in their signatures.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from pydantic import create_model

OperationFn = Callable[..., Awaitable[Any]]


@dataclass(frozen=True)
class Operation:
    name: str
    fn: OperationFn
    description: str
    input_schema: dict[str, Any]


def _input_schema(fn: OperationFn) -> dict[str, Any]:
    """JSON Schema for an operation's arguments, derived from its signature.

    Built here rather than taken from a transport library, so the schema a
    client sees is the same whichever door it came through — and so the
    operations layer stays free of transport dependencies.
    """
    fields: dict[str, Any] = {}
    for name, param in inspect.signature(fn).parameters.items():
        annotation = (
            param.annotation if param.annotation is not inspect.Parameter.empty else Any
        )
        default = ... if param.default is inspect.Parameter.empty else param.default
        fields[name] = (annotation, default)

    if not fields:
        return {"type": "object", "properties": {}}

    model = create_model(f"{fn.__name__}_arguments", **fields)  # type: ignore[call-overload]
    schema = model.model_json_schema()
    schema.pop("title", None)
    return schema


_REGISTRY: dict[str, Operation] = {}


def operation(fn: OperationFn) -> OperationFn:
    """Register an agent operation under its own function name.

    The name is the function name verbatim — it is what an agent calls over
    MCP and what appears in `POST /ops/{operation}`. One vocabulary, so a
    translating runtime needs no mapping table.
    """
    name = fn.__name__
    if name in _REGISTRY:
        raise RuntimeError(f"operation {name!r} is already registered")
    _REGISTRY[name] = Operation(
        name=name,
        fn=fn,
        description=(fn.__doc__ or "").strip(),
        input_schema=_input_schema(fn),
    )
    return fn


def all_operations() -> dict[str, Operation]:
    return dict(_REGISTRY)


def get_operation(name: str) -> Operation | None:
    return _REGISTRY.get(name)
