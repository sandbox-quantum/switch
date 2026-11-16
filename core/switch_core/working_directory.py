"""What may be a managed agent's working directory.

Its definition names the folder the machine runs it in, and the server hands
that to the machine as given, so the server checks it first rather than trust
the controller alone: absolute in a form the controller takes as absolute
(`runtime.ts`, `workingDirectory`), with no `..` segment, no control
character and a bounded length. Whether the folder exists is for the machine
to say.
"""

from __future__ import annotations

import re
import unicodedata

# Linux's PATH_MAX, the longest of the systems a controller runs on to cap a
# path at all (Windows allows longer only with long paths turned on).
MAX_DIRECTORY_CHARS = 4096

# POSIX, the home directory (`~`, `~/...`, and `~\...` on Windows), a Windows
# drive (`C:\...` or `C:/...`), or a UNC share (`\\server\share...`). A path
# starting `\\?\` or `\\.\` names a Windows device, not a folder.
_ABSOLUTE_DIRECTORY = re.compile(
    r"/|~$|~[/\\]|[A-Za-z]:[/\\]|\\\\[^\\/?.][^\\/]*[\\/][^\\/]"
)
_PATH_SEPARATORS = re.compile(r"[/\\]")


def check_directory(value: str) -> str:
    """`value` as a working directory a controller may be told to run an agent
    in, unchanged, or a ValueError saying what is wrong with it."""
    if not value.strip():
        raise ValueError(
            "directory must not be blank; leave it out for the machine's own "
            "workspace for the agent"
        )
    if len(value) > MAX_DIRECTORY_CHARS:
        raise ValueError(f"directory must be at most {MAX_DIRECTORY_CHARS} characters")
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise ValueError("directory must not contain control characters")
    if not _ABSOLUTE_DIRECTORY.match(value):
        raise ValueError(
            "directory must be an absolute path, such as /home/me/project, "
            "~/project or C:\\Users\\me\\project"
        )
    if ".." in _PATH_SEPARATORS.split(value):
        raise ValueError("directory must not contain a '..' segment")
    return value
