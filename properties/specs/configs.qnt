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

// Two ticks of the database's clock: enough for a lease to lapse and be taken
// over, and for the holder to stall across it.
module lease {
  import ownership(PROCS = Set(1, 2), MAX_NOW = 4, BUGS = Set()).* from "./ownership"
}

// Three ticks: minutes, so `properties-scheduled.yml` runs it nightly.
module lease_deep {
  import ownership(PROCS = Set(1, 2), MAX_NOW = 6, BUGS = Set()).* from "./ownership"
}

module recipients {
  import delivery(
    ROOMS = Set("r1"), AGENTS = Set(1, 2), WRITERS = Set(1, 2),
    MAX_ROWS = 1, MAX_BOOT = 1, MAX_CLOCK = 2, BUGS = Set()
  ).* from "./delivery"
}

// The same with two rows a room: minutes, so `properties-scheduled.yml` runs it
// nightly and a pull request does not.
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

module mutant_claim_ignores_holder {
  import ownership(
    PROCS = Set(1, 2), MAX_NOW = 4, BUGS = Set("claim-ignores-holder")
  ).* from "./ownership"
}

module mutant_release_before_stop {
  import ownership(
    PROCS = Set(1, 2), MAX_NOW = 4, BUGS = Set("release-before-stop")
  ).* from "./ownership"
}

module mutant_stop_at_full_lease {
  import ownership(
    PROCS = Set(1, 2), MAX_NOW = 4, BUGS = Set("stop-at-full-lease")
  ).* from "./ownership"
}

module mutant_write_without_token {
  import ownership(
    PROCS = Set(1, 2), MAX_NOW = 4, BUGS = Set("write-without-token")
  ).* from "./ownership"
}

// The untimed lease: three processes and two faults, so one outlives them
// however they fall (two dying, one losing its lease twice, a death and a
// shutdown).
module lease_eventual {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set()
  ).* from "./ownership_eventual"
}

// Four processes and three faults: nightly.
module lease_eventual_deep {
  import ownership_eventual(
    PROCS = Set(1, 2, 3, 4), MAX_FAULTS = 3, BUGS = Set()
  ).* from "./ownership_eventual"
}

module mutant_lapsed_holder_kept {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("lapsed-holder-kept")
  ).* from "./ownership_eventual"
}

module mutant_eventual_claim_ignores_holder {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("claim-ignores-holder")
  ).* from "./ownership_eventual"
}

module mutant_no_suspend {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("no-suspend")
  ).* from "./ownership_eventual"
}

module mutant_renews_after_death {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("renews-after-death")
  ).* from "./ownership_eventual"
}

module mutant_live_ignores_lapse {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("live-ignores-lapse")
  ).* from "./ownership_eventual"
}

module mutant_owner_excludes_self {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("owner-excludes-self")
  ).* from "./ownership_eventual"
}

module mutant_no_handoff {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("no-handoff")
  ).* from "./ownership_eventual"
}

module mutant_keeps_rows_on_resume {
  import ownership_eventual(
    PROCS = Set(1, 2, 3), MAX_FAULTS = 2, BUGS = Set("keeps-rows-on-resume")
  ).* from "./ownership_eventual"
}

// The signals model, one family a check: what a process holds and re-reads
// (`view`), the held cache (`cache`), and the room wake-up (`room`). One
// process holding the row, changes made by it or by one not modelled, two
// changes or rows, and one reconnect.

module signals_view {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set()
  ).* from "./signals"
}

module signals_cache {
  import signals(
    PROCS = Set(1), FAMILIES = Set("cache"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 3, BUGS = Set()
  ).* from "./signals"
}

module signals_room {
  import signals(
    PROCS = Set(1), FAMILIES = Set("room"), MAX_VERSION = 0, MAX_ROWS = 2,
    MAX_CONN = 2, MAX_CLOCK = 0, BUGS = Set()
  ).* from "./signals"
}

module mutant_view_acts_on_payload {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set("view-acts-on-payload")
  ).* from "./signals"
}

module mutant_no_resync {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set("no-resync")
  ).* from "./signals"
}

module mutant_no_recheck {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set("no-recheck")
  ).* from "./signals"
}

module mutant_cache_acts_on_payload {
  import signals(
    PROCS = Set(1), FAMILIES = Set("cache"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 3, BUGS = Set("cache-acts-on-payload")
  ).* from "./signals"
}

module mutant_hold_survives_reconnect {
  import signals(
    PROCS = Set(1), FAMILIES = Set("cache"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 3, BUGS = Set("hold-survives-reconnect")
  ).* from "./signals"
}

module mutant_no_generation {
  import signals(
    PROCS = Set(1), FAMILIES = Set("cache"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 3, BUGS = Set("no-generation")
  ).* from "./signals"
}

module mutant_no_wake_on_reconnect {
  import signals(
    PROCS = Set(1), FAMILIES = Set("room"), MAX_VERSION = 0, MAX_ROWS = 2,
    MAX_CONN = 2, MAX_CLOCK = 0, BUGS = Set("no-wake-on-reconnect")
  ).* from "./signals"
}

module mutant_reads_announced_row {
  import signals(
    PROCS = Set(1), FAMILIES = Set("room"), MAX_VERSION = 0, MAX_ROWS = 2,
    MAX_CONN = 2, MAX_CLOCK = 0, BUGS = Set("reads-announced-row")
  ).* from "./signals"
}

module mutant_ttl_from_store {
  import signals(
    PROCS = Set(1), FAMILIES = Set("cache"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 3, BUGS = Set("ttl-from-store")
  ).* from "./signals"
}

module mutant_applies_overtaken_reread {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set("applies-overtaken-reread")
  ).* from "./signals"
}

module mutant_skips_if_changed_since {
  import signals(
    PROCS = Set(1), FAMILIES = Set("view"), MAX_VERSION = 2, MAX_ROWS = 0,
    MAX_CONN = 2, MAX_CLOCK = 4, BUGS = Set("skips-if-changed-since")
  ).* from "./signals"
}
