from __future__ import annotations

import pytest

from switch_core.bridges.resource.registry import (
    BUILTIN_REFERENCE_TYPES,
    is_builtin_type,
    validate_reference_value,
)


@pytest.mark.parametrize(
    ("slug", "display_name"),
    [
        ("google_drive", "Google Drive"),
        ("confluence", "Confluence"),
        ("github", "GitHub"),
        ("jira", "Jira"),
    ],
)
def test_builtin_types_are_registered(slug: str, display_name: str):
    spec = BUILTIN_REFERENCE_TYPES[slug]
    assert spec.type == slug
    assert spec.display_name == display_name
    assert spec.instructions
    assert spec.value_hint


def test_jira_instructions_point_at_the_atlassian_connector():
    assert "Atlassian" in BUILTIN_REFERENCE_TYPES["jira"].instructions


def test_is_builtin_type():
    assert is_builtin_type("jira")
    assert not is_builtin_type("not_a_real_type")


def test_public_dict_carries_schema_hint_and_origin():
    public = BUILTIN_REFERENCE_TYPES["jira"].to_public_dict(origin="builtin")
    assert public["type"] == "jira"
    assert public["display_name"] == "Jira"
    assert public["instructions"]
    assert public["origin"] == "builtin"
    assert public["value_hint"] == BUILTIN_REFERENCE_TYPES["jira"].value_hint
    assert "urls" in public["value_schema"]["properties"]


def test_public_dict_origin_user():
    public = BUILTIN_REFERENCE_TYPES["github"].to_public_dict(origin="user")
    assert public["origin"] == "user"


def test_value_validates_url_list():
    normalised = validate_reference_value(
        {"urls": ["https://your-org.atlassian.net/browse/PROJ-123"]},
    )
    assert normalised == {"urls": ["https://your-org.atlassian.net/browse/PROJ-123"]}


def test_value_strips_unknown_fields():
    normalised = validate_reference_value(
        {"urls": ["https://x.atlassian.net/browse/AB-1"], "bogus": "drop me"},
    )
    assert normalised == {"urls": ["https://x.atlassian.net/browse/AB-1"]}


def test_empty_url_list_is_rejected():
    with pytest.raises(ValueError):
        validate_reference_value({"urls": []})


def test_missing_urls_key_is_rejected():
    """Regression: ``urls`` used to carry ``default_factory=list``, and pydantic
    does not validate defaults, so an empty bag silently became ``{"urls": []}``
    instead of failing ``min_length=1``."""
    with pytest.raises(ValueError):
        validate_reference_value({})
