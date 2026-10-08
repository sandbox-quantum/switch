"""Each provider's advanced-configuration schema, and how a definition is held to it."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from switch_core.management.advanced_config import (
    advanced_config_schema,
    providers_schema,
    validate_advanced_config,
)
from switch_core.management.schemas import DefinitionV1


def test_a_definition_refuses_a_provider_switch_does_not_run() -> None:
    with pytest.raises(ValidationError) as raised:
        DefinitionV1(provider="gemini")
    assert (
        "unknown provider 'gemini'; one of claude, codex, opencode, antigravity, cursor"
        in str(raised.value)
    )


def test_the_served_provider_list() -> None:
    providers = providers_schema()["providers"]

    assert [(provider["id"], provider["label"]) for provider in providers] == [
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("opencode", "OpenCode"),
        ("antigravity", "Antigravity"),
        ("cursor", "Cursor CLI"),
    ]
    by_id = {provider["id"]: provider for provider in providers}
    served = advanced_config_schema()["providers"]
    for provider_id, provider in by_id.items():
        assert provider["advanced_fields"] == served[provider_id]["fields"]
    assert by_id["cursor"]["advanced_fields"] == []


def test_the_served_schema() -> None:
    providers = advanced_config_schema()["providers"]

    assert set(providers) == {"claude", "codex", "opencode", "cursor", "antigravity"}
    assert [field["key"] for field in providers["claude"]["fields"]] == [
        "tools",
        "disallowedTools",
        "permissionMode",
        "color",
        "maxTurns",
        "background",
        "isolation",
        "effort",
        "memory",
    ]
    assert [field["key"] for field in providers["opencode"]["fields"]] == [
        "variant",
        "temperature",
        "topP",
        "maxSteps",
        "webSearch",
        "smallModel",
    ]
    assert providers["cursor"] == {"fields": []}
    assert providers["antigravity"] == {"fields": []}
    claude = {field["key"]: field for field in providers["claude"]["fields"]}
    assert claude["isolation"] == {
        "key": "isolation",
        "label": "Isolation",
        "type": "select",
        "help": None,
        "placeholder": None,
        "options": [
            {"value": "", "label": "None"},
            {"value": "worktree", "label": "worktree (isolated git copy)"},
        ],
        "catalogue": None,
    }
    assert claude["maxTurns"]["options"] is None
    opencode = {field["key"]: field for field in providers["opencode"]["fields"]}
    assert opencode["variant"]["catalogue"] == {
        "kind": "model-variant",
        "model_field": "model",
    }
    assert opencode["smallModel"]["catalogue"] == {"kind": "model"}


@pytest.mark.parametrize(
    ("provider", "config"),
    [
        ("claude", {}),
        (
            "claude",
            {
                "tools": ["Read", "Grep"],
                "disallowedTools": ["Write"],
                "permissionMode": "plan",
                "color": "cyan",
                "maxTurns": 20,
                "background": False,
                "isolation": "worktree",
                "effort": "xhigh",
                "memory": "project",
            },
        ),
        (
            "codex",
            {
                "effort": "none",
                "verbosity": "low",
                "reasoningSummary": "none",
                "webSearch": "false",
            },
        ),
        (
            "opencode",
            {
                "variant": "high",
                "temperature": 0.2,
                "topP": 1,
                "maxSteps": 40,
                "webSearch": "true",
                "smallModel": "ollama/gemma4:latest",
            },
        ),
        ("cursor", {}),
    ],
)
def test_valid_settings_pass(provider: str, config: dict[str, Any]) -> None:
    validate_advanced_config(provider, config)


@pytest.mark.parametrize(
    ("provider", "config", "message"),
    [
        ("claude", {"verbosity": "low"}, "claude has no setting 'verbosity'"),
        ("cursor", {"effort": "high"}, "it has no advanced configuration"),
        ("claude", {"effort": "huge"}, "claude setting 'effort' must be one of"),
        ("claude", {"effort": ""}, "leave the field out to leave it unset"),
        ("claude", {"effort": None}, "leave the field out to leave it unset"),
        ("claude", {"tools": []}, "leave the field out to leave it unset"),
        ("codex", {"webSearch": True}, "codex setting 'webSearch' must be one of"),
        ("claude", {"maxTurns": "10"}, "claude setting 'maxTurns' must be a number"),
        ("claude", {"maxTurns": True}, "must be a number"),
        ("opencode", {"temperature": float("nan")}, "must be a finite number"),
        ("claude", {"background": "true"}, "must be true or false"),
        ("claude", {"tools": "Read"}, "must be a list of strings"),
        ("claude", {"tools": ["Read", 3]}, "must be a list of strings"),
        ("claude", {"tools": ["x"] * 65}, "at most 64 items"),
        ("claude", {"tools": ["x" * 257]}, "items must be 1 to 256 characters"),
        ("claude", {"tools": [""]}, "items must be 1 to 256 characters"),
        ("opencode", {"variant": 3}, "opencode setting 'variant' must be a string"),
        ("opencode", {"variant": "x" * 4097}, "at most 4096 characters"),
        ("claude", {f"k{n}": "v" for n in range(33)}, "at most 32 fields"),
    ],
)
def test_invalid_settings_are_refused(
    provider: str, config: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValueError, match="advanced_config") as raised:
        validate_advanced_config(provider, config)
    assert message in str(raised.value)


def test_every_problem_is_named() -> None:
    with pytest.raises(ValueError) as raised:
        validate_advanced_config("codex", {"tools": ["Read"], "effort": "low!"})
    assert "codex has no setting 'tools'" in str(raised.value)
    assert "codex setting 'effort' must be one of" in str(raised.value)


def test_a_definition_holds_its_settings_to_its_provider() -> None:
    accepted = DefinitionV1(provider="codex", advanced_config={"effort": "high"})
    with pytest.raises(ValidationError) as raised:
        DefinitionV1(provider="opencode", advanced_config={"effort": "high"})

    assert accepted.model_dump()["advanced_config"] == {"effort": "high"}
    assert DefinitionV1(provider="claude").advanced_config == {}
    assert "opencode has no setting 'effort'" in str(raised.value)


def test_a_definition_refuses_model_options() -> None:
    with pytest.raises(ValidationError, match="model_options"):
        DefinitionV1.model_validate(
            {"provider": "claude", "model": "opus", "model_options": {"effort": "high"}}
        )
