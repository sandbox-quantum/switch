// The bounds each check runs at, and the behaviours not in the code that each
// invariant must fail on. `just properties-model` verifies every `checks`
// module; `just properties-mutants` expects every `mutants` module to fail.
//
// A bound is as small as the interleaving it needs, because the state space
// TLC searches grows with every room, agent and row: the retention race needs
// two rooms and two writers but one agent; who a row is for needs two agents
// but one room.

module bus {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3, BUGS = Set()
  ).* from "./delivery"
}

module retention {
  import delivery(
    ROOMS = Set("r1", "r2"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 1, MAX_BOOT = 0, MAX_CLOCK = 3, BUGS = Set()
  ).* from "./delivery"
}

module recipients {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1, 2), WRITERS = Set(1, 2),
    MAX_ROWS = 1, MAX_BOOT = 1, MAX_CLOCK = 2, BUGS = Set()
  ).* from "./delivery"
}

// The same with two rows a room: minutes, so it runs nightly.
module recipients_deep {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1, 2), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 1, MAX_CLOCK = 2, BUGS = Set()
  ).* from "./delivery"
}

// Each module below is a check's bounds with one behaviour that is not in the
// code switched on. `just properties-mutants` expects the invariant named for
// it in `run.py` to fail, which shows the invariant can see that bug.

module mutant_room_seq_from_counter {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("room-seq-from-counter")
  ).* from "./delivery"
}

module mutant_late_delivery {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("late-delivery")
  ).* from "./delivery"
}

module mutant_number_from_highest_retained {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("number-from-highest-retained")
  ).* from "./delivery"
}

module mutant_no_source_dedupe {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("no-source-dedupe")
  ).* from "./delivery"
}

module mutant_forget_without_lock {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("forget-without-lock")
  ).* from "./delivery"
}

module mutant_store_skips_membership_recheck {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("store-skips-membership-recheck")
  ).* from "./delivery"
}

module mutant_expire_without_drop_mark {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 2, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("expire-without-drop-mark")
  ).* from "./delivery"
}

module mutant_own_seq_released_early {
  import delivery(
    ROOMS = Set("r1", "r2"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 1, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("own-seq-released-early")
  ).* from "./delivery"
}

module mutant_created_at_transaction_start {
  import delivery(
    ROOMS = Set("r1", "r2"), AGENTS = Set(1), WRITERS = Set(1, 2),
    MAX_ROWS = 1, MAX_BOOT = 0, MAX_CLOCK = 3,
    BUGS = Set("created-at-transaction-start")
  ).* from "./delivery"
}
