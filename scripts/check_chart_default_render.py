#!/usr/bin/env python3
"""Check that this branch renders the switch chart exactly as its base does, with default values.

Hosted agents v2's chart changes promise that with v2 off (every v2 value at its
default) the chart renders byte for byte as before, so a deployment that sets
none of them sees no change at all. This renders the chart twice from the same
values files (the base's render-check-values.yaml, alone and with
render-check-optional-values.yaml): once from the base commit's chart, extracted
with `git archive`, and once from this tree's. The decision service's token, which
`randAlphaNum` generates afresh on every render, is masked first (that key, in a
Secret, only). Any other difference fails,
and the first lines of the diff are printed.

It is for the pull request that adds v2's chart values, so CI runs it only there
(see pr-ci.yml); a later chart change that is meant to alter the default render
would rightly fail it.

Needs `helm` and `git` on PATH, and the base commit fetched. Run from the repo root:

    python3 scripts/check_chart_default_render.py <base-commit>
"""

from __future__ import annotations

import difflib
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HELM_DIR = "deploy/remote/helm"
CHART = f"{HELM_DIR}/switch"
VALUES = f"{HELM_DIR}/render-check-values.yaml"
OPTIONAL = f"{HELM_DIR}/render-check-optional-values.yaml"
RELEASE = "rel"
#: The one value the chart generates afresh on every `helm template`: the decision
#: service's token (templates/decision/secret.yaml, `randAlphaNum 48 | b64enc`,
#: under the key `token`, 64 base64 characters). Only that key, and only inside a
#: Secret, is masked, so a real change to any other value still shows.
RANDOM = re.compile(r"^(\s+token: )[A-Za-z0-9+/]{64}$", re.MULTILINE)


def mask(rendered: str) -> str:
    docs = rendered.split("\n---\n")
    return "\n---\n".join(
        RANDOM.sub(r"\1<random>", d)
        if re.search(r"^kind: Secret$", d, re.MULTILINE)
        else d
        for d in docs
    )


def render(chart: Path, values: list[Path]) -> str:
    args = ["helm", "template", RELEASE, str(chart)]
    for v in values:
        args += ["-f", str(v)]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(f"helm template failed for {chart}:\n{result.stderr}")
    return mask(result.stdout)


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9a-f]{7,40}", sys.argv[1]):
        sys.exit(__doc__)
    base = sys.argv[1]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        archive = subprocess.run(
            ["git", "archive", base, HELM_DIR], capture_output=True, check=True
        ).stdout
        subprocess.run(["tar", "-x", "-C", str(root)], input=archive, check=True)
        base_values = [root / VALUES, root / OPTIONAL]
        failed = False
        for label, n in (("defaults", 1), ("defaults with the optional workloads", 2)):
            want = render(root / CHART, base_values[:n])
            got = render(Path(CHART), base_values[:n])
            if want == got:
                print(
                    f"identical to {base[:12]}: {label} ({len(got.splitlines())} lines)"
                )
                continue
            failed = True
            print(f"DIFFERS from {base[:12]}: {label}")
            diff = difflib.unified_diff(
                want.splitlines(), got.splitlines(), "base", "this tree", lineterm=""
            )
            for line in list(diff)[:60]:
                print("  " + line)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
