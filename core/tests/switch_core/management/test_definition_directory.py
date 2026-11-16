"""The working directory a managed agent's definition names.

The server is told it by a person's client or by an agent, stores it, and
hands it to the machine that runs the agent, so it is checked here rather
than trusted to the controller alone: absolute in a form the controller takes
as absolute, no `..` segment, no control character, and bounded. Whether the
folder exists, and whether it is a sensible one to run in, is not the
schema's to say: a person may run an agent in any folder of theirs, and an
agent asking for a folder of its choosing waits for its owner to confirm it
(`agent_change_requests`).
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from switch_core.management.schemas import DefinitionV1
from switch_core.working_directory import MAX_DIRECTORY_CHARS


@pytest.mark.parametrize(
    "directory",
    [
        "/home/ada/project",
        "/",
        "/home/ada/.config/app",
        "/srv/a..b",
        "~",
        "~/project",
        "~\\project",
        "C:\\Users\\ada\\project",
        "C:/Users/ada/project",
        "d:\\",
        "\\\\fileserver\\share",
        "\\\\fileserver\\share\\project",
        "/" + "a" * (MAX_DIRECTORY_CHARS - 1),
    ],
)
def test_an_absolute_directory_is_kept_as_given(directory: str) -> None:
    assert DefinitionV1(provider="claude", directory=directory).directory == directory


def test_no_directory_is_the_machines_own_workspace() -> None:
    assert DefinitionV1(provider="claude").directory is None


@pytest.mark.parametrize(
    ("directory", "says"),
    [
        ("relative/no/leading/slash", "absolute path"),
        ("project", "absolute path"),
        ("./project", "absolute path"),
        ("~ada/project", "absolute path"),
        ("C:project", "absolute path"),
        ("\\project", "absolute path"),
        ("\\\\?\\C:\\Windows", "absolute path"),
        ("\\\\.\\PhysicalDrive0", "absolute path"),
        ("../../../etc", "absolute path"),
        ("/home/ada/../../etc", "'..' segment"),
        ("/srv/..", "'..' segment"),
        ("~/../root", "'..' segment"),
        ("C:\\Users\\..\\Windows", "'..' segment"),
        ("/srv/has\x00nul", "control characters"),
        ("/srv/has\nnewline", "control characters"),
        ("/srv/has\x1bescape", "control characters"),
        ("/srv/has\x85next-line", "control characters"),
        ("", "blank"),
        ("   ", "blank"),
        ("/" + "a" * MAX_DIRECTORY_CHARS, f"at most {MAX_DIRECTORY_CHARS}"),
    ],
)
def test_a_directory_that_is_no_place_to_work_is_refused(
    directory: str, says: str
) -> None:
    with pytest.raises(ValidationError, match=says):
        DefinitionV1(provider="claude", directory=directory)


def test_checking_it_leaves_the_assignment_format_alone() -> None:
    """The definition's JSON schema is part of every assignment's ETag
    (`controller_routes.ASSIGNMENT_FORMAT`), so a check that changed it would
    make every controller pull its assignment again for nothing."""
    directory = DefinitionV1.model_json_schema()["properties"]["directory"]

    assert directory == {
        "anyOf": [{"type": "string"}, {"type": "null"}],
        "default": None,
        "title": "Directory",
    }
