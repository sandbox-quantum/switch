"""The agent operation registry — the single definition of what an agent can do.

The HTTP operations endpoint dispatches into it and lists it at
`GET /agents/{id}/ops`, which is where each session's runtime reads the tools
it serves its agent.

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

# Operations declared in a group that is off until something enables it: the
# operations of an optional module that exist only while that module runs.
# Declared at import like every other operation, so their names are reserved
# and checked for duplicates; listed and dispatched only once enabled.
_GATED: dict[str, dict[str, Operation]] = {}


def _build(fn: OperationFn) -> Operation:
    name = fn.__name__
    if name in _REGISTRY or any(name in group for group in _GATED.values()):
        raise RuntimeError(f"operation {name!r} is already registered")
    return Operation(
        name=name,
        fn=fn,
        description=(fn.__doc__ or "").strip(),
        input_schema=_input_schema(fn),
    )


def operation(fn: OperationFn) -> OperationFn:
    """Register an agent operation under its own function name.

    The name is the function name verbatim — it is what an agent calls over
    MCP and what appears in `POST /ops/{operation}`. One vocabulary, so a
    translating runtime needs no mapping table.
    """
    _REGISTRY[fn.__name__] = _build(fn)
    return fn


def gated_operation(group: str) -> Callable[[OperationFn], OperationFn]:
    """Declare an operation that exists only while `group` is enabled.

    Named and described exactly as `operation` does, but on neither front
    door until `enable_operation_group(group)`.
    """

    def declare(fn: OperationFn) -> OperationFn:
        _GATED.setdefault(group, {})[fn.__name__] = _build(fn)
        return fn

    return declare


def _gated_group(group: str) -> dict[str, Operation]:
    operations = _GATED.get(group)
    if operations is None:
        raise KeyError(f"no operations are declared in group {group!r}")
    return operations


def enable_operation_group(group: str) -> None:
    """Put every operation declared in `group` on the agent surface."""
    _REGISTRY.update(_gated_group(group))


def disable_operation_group(group: str) -> None:
    """Take every operation declared in `group` off the agent surface again."""
    for name in _gated_group(group):
        _REGISTRY.pop(name, None)


def all_operations() -> dict[str, Operation]:
    """Every operation that exists now: the ungated ones, and those of the
    groups that are enabled."""
    return dict(_REGISTRY)


def declared_operations() -> dict[str, Operation]:
    """Every operation declared, enabled or not."""
    declared = dict(_REGISTRY)
    for group in _GATED.values():
        declared.update(group)
    return declared


def get_operation(name: str) -> Operation | None:
    return _REGISTRY.get(name)
