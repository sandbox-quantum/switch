"""Visibility and management: the shared pieces every set uses.

- `reason_codes`: the fixed list of why an agent stopped.
- `keyed_id`: the keyed hash operators see instead of names and raw ids.
- `operators`: the Switch operator list, read from a file Core owns.
- `audit_log`: admin changes and operator actions, on the existing audit tables.
- `guards`: the three roles as request dependencies.
"""
