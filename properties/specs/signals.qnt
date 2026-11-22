// How a change in the database reaches what other processes hold, when the
// `NOTIFY` that announces it can be lost (`signals.py`, `bridges/agent/
// held_rows.py`, `messages/notify.py`).
//
// One row, the processes that hold it, and three things a process keeps current by
// signals, each a family that a check switches on alone:
//
// - `view`: what a process holds about the row and acts on, the way the holder
//   of a controller's socket holds its revocation. A signal is published after
//   the commit, through the `Announcer`, and is lost if its sender dies first.
//   The handler queues a re-read (`PendingWork`); a reconnect resyncs; every
//   process re-checks `RECHECK` ticks after its last re-check finished. Each
//   of the three is a read of the database that takes time, can fail, and
//   applies what it read when it finishes.
// - `cache`: rows read on every request and kept in memory (`HeldRows`). A
//   trigger announces every write, so a signal is lost only when the
//   receiving process is not listening. An entry is kept past its TTL only
//   while the connection it was read under is the one listening, a read that
//   an invalidation overtook is not stored, and the TTL counts from when the
//   read began.
// - `room`: the room wake-up. Every insert is announced by a trigger; the
//   listener keeps the highest position per room and wakes the room's
//   subscribers, which read every row after their own cursor; a reconnect
//   wakes every room.
//
// A signal that reaches a listening connection is delivered, in any order
// with the others. Disconnecting loses every signal not yet handled.
//
// A change can also come from process 0, which holds nothing: a process not
// modelled, so a check can follow a single holder and still have changes
// made elsewhere.
//
// Left out: the content of a change (the row is a version number), several
// rows (a signal names one, and each is kept the same way), and the batching
// and retry of `Announcer` (a batch that fails to send is sent again, so a
// loss is only its sender dying).
module signals {
  const PROCS: Set[int]
  const FAMILIES: Set[str]
  const MAX_VERSION: int
  const MAX_ROWS: int
  const MAX_CONN: int
  const MAX_CLOCK: int
  const BUGS: Set[str]

  // `HeldRows` TTL and `RECHECK_SECONDS`, in ticks.
  pure val TTL = 1
  pure val RECHECK = 2

  type Signal = { family: str, version: int }

  // A read of the row for the `view` family, in flight or not, and what it
  // read when it began.
  type Read = { busy: bool, value: int }

  // The three ways a process re-reads the row for its view.
  pure val READERS = Set("work", "recheck", "resync")

  // One process. `up` and `conn` are its listening connection (`connected`
  // and `listens`); `inbox` the signals it has received and not yet handled.
  //
  // `view`, `pending`, `next_recheck` and `reads` are the `view` family: what
  // it holds, a re-read queued, when its re-check is next due, and each
  // reader's read in flight. `slack` and `failed` are ghosts the bound reads:
  // the ticks since the last change that some read was in flight, and the
  // re-checks that failed since then.
  //
  // `cached`, `value`, `expires`, `held` and `generation` are a `HeldRows`
  // entry and its generation; `reading`, `ticket_generation`,
  // `ticket_listening` and `read_value` a read in flight with its ticket.
  // `held` and `ticket_listening` are -1 for none; `read_at` is when the read
  // in flight began, which the ticket records.
  //
  // `cursor`, `got` and `wake` are a room subscriber: its place, the rows it
  // has read, and the position the listener keeps for it (-1 for no wake-up,
  // 0 for "read everything").
  //
  // `missed` is a ghost: what the process holds is out of date and no signal
  // will say so, until a re-read brings it the row as committed. Either a
  // `view` signal for it was lost while it listened, because its sender died,
  // or a re-read that began before a change applied what it read after the
  // change: nothing discards a re-read that a change overtook, the way
  // `HeldRows`' generation does.
  type Proc = {
    up: bool,
    conn: int,
    inbox: Set[Signal],
    view: int,
    pending: bool,
    next_recheck: int,
    missed: bool,
    reads: str -> Read,
    slack: int,
    failed: int,
    cached: bool,
    value: int,
    expires: int,
    held: int,
    generation: int,
    reading: bool,
    ticket_generation: int,
    ticket_listening: int,
    read_value: int,
    read_at: int,
    cursor: int,
    got: Set[int],
    wake: int,
  }

  // `version` is the row as committed and `changed_at` when it last changed;
  // `rows` the room's committed rows.
  type State = {
    clock: int,
    version: int,
    changed_at: int,
    rows: int,
    procs: int -> Proc,
  }

  var s: State

  def has(family: str): bool = FAMILIES.contains(family)

  def listening(me: Proc): int = if (me.up) me.conn else -1

  action init = {
    s' = {
      clock: 0,
      version: 0,
      changed_at: 0,
      rows: 0,
      procs: PROCS.mapBy(_ => {
        up: true, conn: 1, inbox: Set(),
        view: 0, pending: false, next_recheck: RECHECK, missed: false,
        reads: READERS.mapBy(_ => { busy: false, value: 0 }), slack: 0, failed: 0,
        cached: false, value: 0, expires: 0, held: -1, generation: 0,
        reading: false, ticket_generation: 0, ticket_listening: -1, read_value: 0,
        read_at: 0,
        // `MessageListener.subscribe` wakes a new subscriber once.
        cursor: 0, got: Set(), wake: 0,
      }),
    }
  }

  def with_proc(p: int, me: Proc): State = { ...s, procs: s.procs.set(p, me) }

  // A process (or 0, one not modelled) commits a change to the row. It acts on it locally at once: its
  // own view is current, and its cache drops the row and bumps the generation.
  //
  // The trigger's `cache` signal reaches every process listening at the
  // commit. The `view` signal is published after the commit to every other
  // listening process, unless its sender dies first (`lost`); then each of
  // them has missed it.
  action change(p: int): bool = {
    nondet lost = Set(false, true).oneOf()
    val bumped = s.version + 1
    all {
      has("view") or has("cache"),
      s.version < MAX_VERSION,
      lost implies has("view"),
      s' = {
        ...s,
        version: bumped,
        changed_at: s.clock,
        procs: s.procs.keys().mapBy(q => {
          val me = s.procs.get(q)
          val heard = me.up
          val cache_signal =
            if (has("cache") and heard) Set({ family: "cache", version: bumped })
            else Set()
          val view_signal =
            if (has("view") and heard and q != p and not(lost))
              Set({ family: "view", version: bumped })
            else Set()
          {
            ...me,
            inbox: me.inbox.union(cache_signal).union(view_signal),
            view: if (has("view") and q == p) bumped else me.view,
            missed: me.missed or (has("view") and heard and q != p and lost),
            slack: 0,
            failed: 0,
            cached: if (has("cache") and q == p) false else me.cached,
            generation:
              if (has("cache") and q == p) me.generation + 1 else me.generation,
          }
        }),
      },
    }
  }

  // A row is committed in the room; the trigger announces its position to
  // every process listening.
  action post: bool = all {
    has("room"),
    s.rows < MAX_ROWS,
    s' = {
      ...s,
      rows: s.rows + 1,
      procs: s.procs.keys().mapBy(q => {
        val me = s.procs.get(q)
        if (me.up) { ...me, inbox: me.inbox.union(Set({ family: "room", version: s.rows + 1 })) }
        else me
      }),
    },
  }

  // `SignalBus._dispatch_forever` and `MessageListener._on_notify`: one signal
  // handled, in any order.
  //
  // A `view` handler queues a re-read; the mutant `view-acts-on-payload` takes
  // the version the signal carries. A `cache` handler drops the row and bumps
  // the generation; the mutant `cache-acts-on-payload` stores what the signal
  // carries. A `room` announcement raises the position kept for the room.
  action handle(p: int, signal: Signal): bool = {
    val me = s.procs.get(p)
    val rest = { ...me, inbox: me.inbox.exclude(Set(signal)) }
    all {
      me.inbox.contains(signal),
      s' = with_proc(p,
        if (signal.family == "view")
          if (BUGS.contains("view-acts-on-payload")) { ...rest, view: signal.version }
          else { ...rest, pending: true }
        else if (signal.family == "cache")
          if (BUGS.contains("cache-acts-on-payload"))
            { ...rest, value: if (me.cached) signal.version else me.value }
          else { ...rest, cached: false, generation: me.generation + 1 }
        else
          { ...rest, wake: if (me.wake > signal.version) me.wake else signal.version }
      ),
    }
  }

  def begin_read(me: Proc, reader: str): Proc =
    { ...me, reads: me.reads.set(reader, { busy: true, value: s.version }) }

  // `PendingWork.work_all` takes the queued key and reads the row.
  action work(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.pending,
      not(me.reads.get("work").busy),
      s' = with_proc(p, begin_read({ ...me, pending: false }, "work")),
    }
  }

  // `SignalBus._recheck_forever`, which runs whether or not the bus listens,
  // reads the row once its sleep is over. The mutant `no-recheck` has none.
  action recheck(p: int): bool = {
    val me = s.procs.get(p)
    all {
      has("view"),
      not(BUGS.contains("no-recheck")),
      not(me.reads.get("recheck").busy),
      s.clock >= me.next_recheck,
      s' = with_proc(p, begin_read(me, "recheck")),
    }
  }

  // A read finishes. One that worked applies what it read when it began. One
  // that failed is logged and changes nothing: `PendingWork` keeps its key to
  // try again, a failed resync leaves what was missed while the bus was down
  // to the re-check, and the re-check tries again at its next turn. A
  // re-check sleeps `RECHECK` from when it finishes.
  action finish(p: int, reader: str, ok: bool): bool = {
    val me = s.procs.get(p)
    val read = me.reads.get(reader)
    val done = { ...me, reads: me.reads.set(reader, { ...read, busy: false }) }
    val after =
      if (ok) {
        ...done,
        view: read.value,
        missed: read.value != s.version,
      }
      else if (reader == "work") { ...done, pending: true }
      else if (reader == "resync") { ...done, missed: me.view != s.version }
      else { ...done, failed: me.failed + 1 }
    all {
      read.busy,
      s' = with_proc(p,
        if (reader == "recheck") { ...after, next_recheck: s.clock + RECHECK }
        else after
      ),
    }
  }

  // The listening connection drops: whatever it had not handled is gone.
  action disconnect(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.up,
      s' = with_proc(p, { ...me, up: false, inbox: Set() }),
    }
  }

  // A new listening connection (`_listen_once`): `listens` counts it, every
  // resync begins to re-read the row, and the message listener wakes every
  // room. The mutants `no-resync` and `no-wake-on-reconnect` skip those.
  action reconnect(p: int): bool = {
    val me = s.procs.get(p)
    val resync = has("view") and not(BUGS.contains("no-resync"))
    val wake_all = has("room") and not(BUGS.contains("no-wake-on-reconnect"))
    val connected = {
      ...me,
      up: true,
      conn: me.conn + 1,
      wake: if (wake_all and me.wake < 0) 0 else me.wake,
    }
    all {
      not(me.up),
      me.conn < MAX_CONN,
      not(me.reads.get("resync").busy),
      s' = with_proc(p, if (resync) begin_read(connected, "resync") else connected),
    }
  }

  // What the cache answers from memory (`HeldRows.get`): the entry, before its
  // TTL, or after it while the connection it was read under is the one
  // listening. The mutant `hold-survives-reconnect` keeps it under any
  // connection once it was held under one.
  def answers(me: Proc): bool =
    me.cached and (
      s.clock < me.expires
      or me.held >= 0 and (
        me.held == listening(me) or BUGS.contains("hold-survives-reconnect")
      )
    )

  // A cache miss reads the database: the ticket is taken, with the time, and
  // the row read.
  action read(p: int): bool = {
    val me = s.procs.get(p)
    all {
      has("cache"),
      not(me.reading),
      not(answers(me)),
      s' = with_proc(p, {
        ...me,
        reading: true,
        ticket_generation: me.generation,
        ticket_listening: listening(me),
        read_value: s.version,
        read_at: s.clock,
      }),
    }
  }

  // The read hands back its ticket (`HeldRows.fresh`, `held_under`): stored
  // only if nothing was invalidated while it was in flight, and held only if
  // one connection listened through it, for the TTL from when the read began.
  // The mutant `no-generation` stores it whatever was invalidated, and
  // `ttl-from-store` counts the TTL from the store, as the code did.
  action store(p: int): bool = {
    val me = s.procs.get(p)
    val fresh =
      me.ticket_generation == me.generation or BUGS.contains("no-generation")
    all {
      me.reading,
      s' = with_proc(p,
        if (fresh) {
          ...me,
          reading: false,
          cached: true,
          value: me.read_value,
          expires:
            (if (BUGS.contains("ttl-from-store")) s.clock else me.read_at) + TTL,
          held: if (me.ticket_listening == listening(me)) me.ticket_listening else -1,
        }
        else { ...me, reading: false }
      ),
    }
  }

  // A subscriber woken reads the rows after its cursor (`_wake_room`, then
  // the consumer's read). The mutant `reads-announced-row` reads only the row
  // the announcement named.
  action read_room(p: int): bool = {
    val me = s.procs.get(p)
    val only = BUGS.contains("reads-announced-row") and me.wake > 0
    all {
      me.wake >= 0,
      s' = with_proc(p,
        if (only) {
          ...me,
          wake: -1,
          got: me.got.union(Set(me.wake)),
          cursor: if (me.cursor > me.wake) me.cursor else me.wake,
        }
        else {
          ...me,
          wake: -1,
          got: me.got.union((me.cursor + 1).to(s.rows)),
          cursor: s.rows,
        }
      ),
    }
  }

  // Time passes. `_recheck_forever` wakes when a re-check is due, so time does
  // not pass one before it has begun; a read takes as long as it takes.
  action tick: bool = all {
    s.clock < MAX_CLOCK,
    PROCS.forall(q => {
      val me = s.procs.get(q)
      not(has("view")) or BUGS.contains("no-recheck")
      or me.reads.get("recheck").busy or s.clock < me.next_recheck
    }),
    s' = {
      ...s,
      clock: s.clock + 1,
      procs: s.procs.keys().mapBy(q => {
        val me = s.procs.get(q)
        if (READERS.exists(r => me.reads.get(r).busy)) { ...me, slack: me.slack + 1 }
        else me
      }),
    },
  }

  action step = {
    nondet p = PROCS.oneOf()
    nondet writer = PROCS.union(Set(0)).oneOf()
    nondet reader = READERS.oneOf()
    nondet ok = Set(false, true).oneOf()
    nondet signal = Set("view", "cache", "room")
      .map(f => 1.to(MAX_VERSION + MAX_ROWS).map(v => { family: f, version: v }))
      .flatten()
      .oneOf()
    any {
      change(writer),
      post,
      handle(p, signal),
      work(p),
      recheck(p),
      finish(p, reader, ok),
      disconnect(p),
      reconnect(p),
      read(p),
      store(p),
      read_room(p),
      tick,
    }
  }

  def heard_about(me: Proc, family: str): bool =
    me.inbox.exists(signal => signal.family == family)

  // A re-read in flight that read the row as it is now.
  def bringing(me: Proc): bool =
    READERS.exists(r => me.reads.get(r).busy and me.reads.get(r).value == s.version)

  /// @property revocation.takes-effect-everywhere
  /// @property signal.loss-only-delays
  /// What a process acts on is the row as committed once the bound has passed
  /// since the change, whichever signals were lost: its view after one
  /// re-check period, one more for each re-check that failed, and the time
  /// its reads were in flight; its cache after the TTL, unless the signal that
  /// drops the row is still waiting to be handled.
  val NoWrongAnswerPastBound = PROCS.forall(p => {
    val me = s.procs.get(p)
    and {
      has("view") and me.view != s.version implies
        s.clock <= s.changed_at + RECHECK * (1 + me.failed) + me.slack,
      has("cache") and answers(me) and me.value != s.version implies
        (s.clock < s.changed_at + TTL or heard_about(me, "cache")),
    }
  })

  /// @property signal.loss-only-delays
  /// A process that has listened through every signal sent it, or re-read
  /// since it missed one, holds the row as committed, or has the signal or
  /// the re-read still to do: nothing it acts on depends on what a signal
  /// carried, and a reconnect loses nothing. A re-read a change overtook is
  /// repaired by the re-check alone, which `NoWrongAnswerPastBound` bounds.
  val LossOnlyDelays = PROCS.forall(p => {
    val me = s.procs.get(p)
    has("view") and me.up and not(me.missed) implies
      (me.view == s.version or me.pending or heard_about(me, "view") or bringing(me))
  })

  /// @property signal.loss-only-delays
  /// A row committed after a subscriber's cursor is never stranded: the
  /// subscriber has a wake-up kept, the announcement still to handle, or no
  /// connection, and the reconnect wakes it.
  val NoStrandedRow = PROCS.forall(p => {
    val me = s.procs.get(p)
    has("room") and s.rows > me.cursor and me.up implies
      (me.wake >= 0 or heard_about(me, "room"))
  })

  /// @property signal.loss-only-delays
  /// A subscriber has read every row up to its cursor.
  val ReadsEveryRow = PROCS.forall(p => {
    val me = s.procs.get(p)
    me.got == 1.to(me.cursor)
  })
}
