# Property tests

The checkers for the claims in `properties/catalog/`. Before writing one, read
the `testing` skill (`.claude/skills/testing/SKILL.md`); this file is only what
is local to this directory.

- **Tag every checker** with `@pytest.mark.property("area.name")`.
  `just properties check` fails if the catalog and the tags disagree.
- **Profiles** are in `conftest.py`: `ci` (the default) and `nightly`, chosen
  with `HYPOTHESIS_PROFILE`. There is no deadline: steps wait on a real
  database.
- **Sharding.** A machine's main test takes `shard: Shard` (`shards.py`) and
  runs with `settings=shard.of(settings())`. Under `nightly` it is split into
  shards that `pytest -n` runs side by side.
- **Reach.** A machine counts what it reached in `COVERAGE` and lists in
  `SHOULD_REACH` what it must reach. Calling `shard.reached(COVERAGE,
  SHOULD_REACH)` records it, and the session fails if no shard reached a
  target.
- **Layout.** `<name>_machine.py` holds the machine and its model, and
  `test_<name>_machine.py` holds the tests that run it, plus fixed scenarios
  for sequences worth replaying every time.
- **Shared harnesses:**
  - `tests/switch_core/bridges/collaboration/bridge_processes.py` runs one
    bridge on several processes sharing Postgres, with a fake platform that
    can refuse.
  - `revocation_resources.py` holds the revocation machines' resources.
  - `addressing_reference.py` is the oracle for addressing.
- **Running** from the repository root:
  `properties/run-machine.sh [ci|nightly] [test files]`. It also checks the
  server's `always`/`sometimes` assertions in the log.
