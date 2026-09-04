"""Operator commands that ship inside the image.

These live in the package rather than under `scripts/` because the deployed
image contains only `switch_core` — a script outside it cannot be run by a
Kubernetes Job or a Compose service, which is where the migration commands
have to run. They reach the homeserver and the database directly, so they are
invoked deliberately, never on every release.
"""
