// How one piece of owned work passes between processes: a process lease on the
// database's clock, a work lease with a token, and a holder that stops by its
// own clock before anyone else may take over (`process_lease.py`,
// `ownership.py`).
//
// One key, a few processes. Time is the database's `now`, which moves in steps
// of two; each process's own monotonic clock moves by one to three in the
// same step, so one can run at half the rate of the database's and another at
// one and a half times. Half is the bound `surely_held` is sound for.
//
// Left out on purpose: rendezvous hashing (a claim by any process is allowed;
// who should own is a placement choice, and the lease is what keeps two from
// running), and the signal bus (a lost nudge only delays a balance).
module ownership {
  const PROCS: Set[int]
  const MAX_NOW: int
  const BUGS: Set[str]

  // `LEASE_TTL`, in the database's units. A process is held while its beat is
  // younger than this, and stops by its own clock at half of it.
  pure val TTL = 4

  // Bounds on what repeats without time passing: claims, and writes.
  pure val MAX_TOKEN = 2
  pure val MAX_WRITES = 2

  // One process: its row in `switch_core_processes` (`beat`, `stopped`), its
  // own clock (`local`), the renewal it has sent and not yet seen land
  // (`pending`, the local time it was sent at), the local time of the last
  // renewal that landed (`sent`, -1 for none), and the work it runs.
  type Proc = {
    row: bool,
    beat: int,
    stopped: bool,
    local: int,
    inflight: bool,
    pending: int,
    sent: int,
    crashed: bool,
    stalled: bool,
    running: bool,
    token: int,
  }

  type State = {
    now: int,
    procs: int -> Proc,
    // The `ownership_leases` row: who holds the key (0 for no one) and the
    // token of the last claim, which is kept on release.
    holder: int,
    token: int,
    // The token of every write that was accepted, in order.
    writes: List[int],
  }

  var s: State

  // `ProcessLease.surely_held`: by this process's own clock, from when the last
  // renewal that landed was sent. The mutant `stop-at-full-lease` counts to the
  // whole lease.
  def deadline(p: Proc): int =
    p.sent + (if (BUGS.contains("stop-at-full-lease")) TTL else TTL / 2)

  def surely_held(p: Proc): bool = p.sent >= 0 and p.local < deadline(p)

  // The database's reading of a process lease (`ProcessLeases.holds`).
  def holds(now: int, p: Proc): bool = p.row and not(p.stopped) and now - p.beat < TTL

  action init = {
    s' = {
      now: 0,
      procs: PROCS.mapBy(_ => {
        row: false, beat: 0, stopped: false, local: 0, inflight: false,
        pending: 0, sent: -1, crashed: false, stalled: false, running: false,
        token: 0,
      }),
      holder: 0,
      token: 0,
      writes: List(),
    }
  }

  def with_proc(p: int, f: Proc): State =
    { ...s, procs: s.procs.set(p, f) }

  // `ProcessLease.renew`: sent now by the process's clock, stamped when the
  // database gets it. The deadline counts from when it was sent.
  action renew_send(p: int): bool = {
    val me = s.procs.get(p)
    all {
      not(me.crashed),
      not(me.stalled),
      not(me.inflight),
      s' = with_proc(p, { ...me, inflight: true, pending: me.local }),
    }
  }

  action renew_land(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.inflight,
      not(me.stalled),
      // A process past its deadline has stopped before it handles the answer.
      not(me.running) or surely_held(me),
      s' = with_proc(p, {
        ...me, inflight: false, row: true, beat: s.now, stopped: false,
        sent: me.pending,
      }),
    }
  }

  // `Ownership.balance` claiming a key: the process must be sure of its own
  // lease and see it held by the database's clock. `_CLAIM` takes the key when
  // no one holds it, when the process held it before, or when the holder's
  // process lease no longer holds. The mutant `claim-ignores-holder` takes it
  // from a holder whose lease still holds.
  action claim(p: int): bool = {
    val me = s.procs.get(p)
    val holder_lapsed =
      if (s.holder == 0) true else not(holds(s.now, s.procs.get(s.holder)))
    val holder_gone = BUGS.contains("claim-ignores-holder")
      or s.holder == p
      or holder_lapsed
    all {
      not(me.crashed),
      not(me.stalled),
      not(me.running),
      s.token < MAX_TOKEN,
      surely_held(me),
      holds(s.now, me),
      holder_gone,
      s' = {
        ...s,
        holder: p,
        token: s.token + 1,
        procs: s.procs.set(p, { ...me, running: true, token: s.token + 1 }),
      },
    }
  }

  // `OwnedKind._stop_held`: the work stops here. `_suspend` does it once the
  // lease stops being sure; a handover does it earlier.
  action stop_work(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.running,
      not(me.stalled),
      s' = with_proc(p, { ...me, running: false }),
    }
  }

  // `OwnershipLeaseStore.release` and `release_all`: after the work has
  // stopped. The mutant `release-before-stop` lets go with the work running.
  action release(p: int): bool = {
    val me = s.procs.get(p)
    all {
      s.holder == p,
      not(me.stalled),
      not(me.running) or BUGS.contains("release-before-stop"),
      s' = { ...s, holder: 0 },
    }
  }

  // The process shuts down cleanly (`ProcessLease.stop`): its lease is marked
  // stopped and it takes no further steps.
  action shutdown(p: int): bool = {
    val me = s.procs.get(p)
    all {
      not(me.crashed),
      not(me.stalled),
      not(me.running),
      s' = with_proc(p, { ...me, crashed: true, inflight: false, stopped: me.row }),
    }
  }

  // The process dies, or is gone from the cluster's point of view: its work
  // stops and its leases lapse.
  action crash(p: int): bool = {
    val me = s.procs.get(p)
    all {
      not(me.crashed),
      s' = with_proc(p, { ...me, crashed: true, running: false, inflight: false }),
    }
  }

  // The process stops running for a while (a pause of the runtime, a blocked
  // event loop) and goes on from where it was: its timers have not fired and
  // it does not know how long it was away.
  action stall(p: int): bool = {
    val me = s.procs.get(p)
    all {
      not(me.crashed),
      not(me.stalled),
      s' = with_proc(p, { ...me, stalled: true }),
    }
  }

  action resume(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.stalled,
      s' = with_proc(p, { ...me, stalled: false }),
    }
  }

  // A write under a fence (`DeliveryCursorStore.advance`): accepted only where
  // the key is still held by this process under the token its claim returned.
  // The mutant `write-without-token` writes whatever the holder is, which is a
  // stale holder writing after it was taken over.
  action write(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.running,
      not(me.stalled),
      s.writes.length() < MAX_WRITES,
      s.holder == p and s.token == me.token or BUGS.contains("write-without-token"),
      s' = { ...s, writes: s.writes.append(me.token) },
    }
  }

  // Time passes: the database's clock by two, each process's own by one to
  // three. Some process may run slowest and some fastest.
  action tick = {
    nondet slow = PROCS.oneOf()
    nondet fast = PROCS.oneOf()
    all {
      s.now < MAX_NOW,
      // `Ownership.run` wakes the moment the lease stops being sure, so time
      // does not pass a running process's deadline before it has stopped; a
      // stalled process is the one that misses it.
      PROCS.forall(q => {
        val me = s.procs.get(q)
        val step = if (q == slow) 1 else if (q == fast) 3 else 2
        not(me.running) or me.stalled or me.local + step < deadline(me)
      }),
      s' = {
        ...s,
        now: s.now + 2,
        procs: s.procs.keys().mapBy(q => {
          val me = s.procs.get(q)
          val step = if (q == slow) 1 else if (q == fast) 3 else 2
          { ...me, local: me.local + step }
        }),
      },
    }
  }

  action step = {
    nondet p = PROCS.oneOf()
    any {
      renew_send(p),
      renew_land(p),
      claim(p),
      stop_work(p),
      release(p),
      shutdown(p),
      crash(p),
      write(p),
      stall(p),
      resume(p),
      tick,
    }
  }

  // Who is running the key by their own account: working, and still sure of
  // the lease by their own clock. A process past its deadline has been woken
  // by `Ownership.run` to stop, and a write it still attempts is the fence's
  // to refuse.
  def active(p: Proc): bool = p.running and surely_held(p)

  /// @property lease.no-overlap
  /// At most one process is running the key and sure of its lease.
  val NoOverlap = PROCS.filter(p => active(s.procs.get(p))).size() <= 1

  /// @property lease.fenced-takeover
  /// The token only rises, and the tokens of the writes accepted never fall:
  /// once the key is taken over, every write by an earlier holder is refused.
  val FencedTakeover = and {
    s.writes.indices().forall(i => s.writes[i] <= s.token),
    s.writes.indices().forall(i =>
      i == 0 or s.writes[i - 1] <= s.writes[i]
    ),
  }
}
