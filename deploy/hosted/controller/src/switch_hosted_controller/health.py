from __future__ import annotations

import argparse
from pathlib import Path
from time import time


def check_health(path: Path, max_age: float) -> int:
    if not 0 < max_age <= 3600:
        raise ValueError("--max-age must be greater than zero and at most 3600 seconds")
    try:
        updated = float(path.read_text().strip())
    except (OSError, ValueError):
        return 1
    return 0 if 0 <= time() - updated <= max_age else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-age", required=True, type=float)
    args = parser.parse_args()
    try:
        return check_health(Path("/tmp/switch-hosted-controller-health"), args.max_age)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())
