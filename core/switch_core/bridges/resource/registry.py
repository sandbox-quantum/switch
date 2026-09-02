"""Built-in external reference types.

The four types defined here ship with Switch and are never database rows: their
agent-facing ``instructions`` stay under code review. User-defined types live in
the ``reference_types`` table and are resolved per-principal by
``ResourceService``; a built-in wins any slug collision.

Every type shares one value shape — a non-empty list of URLs — so what varies
per type is prose: ``display_name``, ``instructions`` for agents, and
``value_hint`` for the human filling in the form.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field


class ReferenceValue(BaseModel):
    """Value shape for every reference: one or more URLs identifying the material."""

    urls: list[str] = Field(min_length=1)


class ReferenceTypeSpec(BaseModel):
    type: str
    display_name: str
    instructions: str
    value_hint: str

    def value_json_schema(self) -> dict[str, Any]:
        return ReferenceValue.model_json_schema()

    def to_public_dict(self, *, origin: Literal["builtin", "user"]) -> dict[str, Any]:
        return {
            "type": self.type,
            "display_name": self.display_name,
            "instructions": self.instructions,
            "value_schema": self.value_json_schema(),
            "value_hint": self.value_hint,
            "origin": origin,
        }


BUILTIN_REFERENCE_TYPES: dict[str, ReferenceTypeSpec] = {
    "google_drive": ReferenceTypeSpec(
        type="google_drive",
        display_name="Google Drive",
        instructions=(
            "To access this Google Drive resource you need (1) read access to "
            "the linked document(s) or folder, and (2) an agent connector that "
            "can fetch Drive content on your behalf. The recommended path is "
            "the Glean MCP connector when available."
        ),
        value_hint="Paste links to Google Drive documents or folders.",
    ),
    "confluence": ReferenceTypeSpec(
        type="confluence",
        display_name="Confluence",
        instructions=(
            "To access this Confluence resource you need (1) read access to "
            "the linked page(s) or space, and (2) an agent connector that can "
            "fetch Confluence content on your behalf — typically the Atlassian "
            "MCP connector (e.g. getConfluencePage, searchConfluenceUsingCql)."
        ),
        value_hint="Paste links to Confluence pages or spaces.",
    ),
    "github": ReferenceTypeSpec(
        type="github",
        display_name="GitHub",
        instructions=(
            "To access this GitHub resource you need (1) read access to the "
            "linked repository (and write access if you intend to push branches "
            "or open PRs), and (2) an agent connector that can interact with "
            "GitHub on your behalf — typically the `gh` CLI for issue/PR "
            "operations and standard `git` for branch work. The repository "
            "URL(s) in this reference's value identify which repo(s) to "
            "operate on."
        ),
        value_hint=(
            "Paste links to GitHub repositories (e.g. https://github.com/org/repo)."
        ),
    ),
    "jira": ReferenceTypeSpec(
        type="jira",
        display_name="Jira",
        instructions=(
            "To access this Jira resource you need (1) access to the linked "
            "project, issue(s), or board, and (2) an agent connector that can "
            "fetch Jira content on your behalf — typically the Atlassian MCP "
            "connector (e.g. getJiraIssue, searchJiraIssuesUsingJql, "
            "getVisibleJiraProjects). The URL(s) in this reference's value "
            "identify which Jira project / issue / board to operate on."
        ),
        value_hint=(
            "Paste links to Jira projects, issues, or boards "
            "(e.g. https://your-org.atlassian.net/browse/PROJ-123)."
        ),
    ),
}


def validate_reference_value(value: dict[str, Any]) -> dict[str, Any]:
    """Validate ``value`` against the shared value model. Returns the
    parsed-and-redumped dict (so unknown fields are stripped). Raises
    ``ValueError`` on failure."""
    try:
        parsed = ReferenceValue.model_validate(value)
    except Exception as exc:
        raise ValueError(f"Invalid reference value: {exc}") from exc
    return parsed.model_dump(mode="json")


def is_builtin_type(type_: str) -> bool:
    return type_ in BUILTIN_REFERENCE_TYPES
