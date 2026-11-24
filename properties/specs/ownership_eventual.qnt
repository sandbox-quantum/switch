// Whether owned work whose holder died, or stopped renewing, is picked up by a
// live process (`process_lease.py`, `ownership.py`), with no clock.
//
// `ownership.qnt` follows the timing that keeps two processes from running a
// key at once, on a bounded clock, which cannot carry a property about what
// happens eventually. Here time is gone. A process lease is read two ways: by
// the process itself, sure of it until its own deadline (`surely_held`), and
// by the database, which holds it until `LEASE_TTL` after the last renewal
// (`ProcessLeases.holds`). The process's deadline comes first, at half the
// lease, which `ownership.qnt` checks against clocks that drift; here that is
// the order the two lapses are allowed to happen in. Each lapse is an event
// fairness promises once nothing renews the lease, and so are the balance's
// claim and hand-off, the suspension of work whose lease is no longer sure,
// and the renewal of a live process.
//
// Placement is in: only the process the key is placed on claims it, and a
// holder it is not placed on hands it off (`OwnedKind._balance`). With one
// key, rendezvous hashing over a set of processes is a fixed order on them,
// so the key is placed on the highest-numbered process the database holds a
// lease for. Faults (a process dying, shutting down, or
// losing its lease while it lives) are bounded, so a run has a point after
// which none happens, and the property is about what holds from there on.
//
// Left out on purpose: how long anything takes (`ownership.qnt`), the token
// and the fence, the hash itself (only the order it puts processes in), and
// the signal bus (a lost nudge only delays a balance, which runs on an
// interval besides).
module ownership_eventual {
  const PROCS: Set[int]
  const MAX_FAULTS: int
  const BUGS: Set[str]

  // One process: whether it is up, whether it is sure of its own lease
  // (`ProcessLease.surely_held`), whether the database holds it
  // (`ProcessLeases.holds`), whether it runs the key (`OwnedKind._held`), and
  // whether it suspended its work and has not resumed (`Ownership._suspended`).
  type Proc = {
    alive: bool,
    sure: bool,
    fresh: bool,
    running: bool,
    suspended: bool,
  }

  type State = {
    procs: int -> Proc,
    // The `ownership_leases` row: who holds the key, 0 for no one.
    holder: int,
    faults: int,
  }

  var s: State

  action init = {
    s' = {
      procs: PROCS.mapBy(_ => {
        alive: true, sure: true, fresh: true, running: false, suspended: false,
      }),
      holder: 0,
      faults: 0,
    }
  }

  def with_proc(p: int, f: Proc): State =
    { ...s, procs: s.procs.set(p, f) }

  // `Ownership.balance`'s `live`: the processes whose lease the database
  // holds. The mutant `live-ignores-lapse` reads every process with a lease
  // row, lapsed or not, as a balance that skipped `leases.holds` would.
  def live(st: State): Set[int] =
    if (BUGS.contains("live-ignores-lapse")) PROCS
    else PROCS.filter(q => st.procs.get(q).fresh)

  // `owner_of` over `live`, as process `p` computes it. The mutant
  // `owner-excludes-self` has each process place the key among the others,
  // so each believes another wins.
  def placed_on(st: State, p: int): int = {
    val among =
      if (BUGS.contains("owner-excludes-self")) live(st).exclude(Set(p))
      else live(st)
    among.fold(0, (best, q) => if (q > best) q else best)
  }

  // `_CLAIM` from `OwnedKind._balance`: the process the key is placed on, sure
  // of its own lease and in `live`, takes the key when no one holds it, when
  // it held it before, or when the holder's process lease no longer holds.
  // The mutant `claim-ignores-holder` takes it from a holder whose lease still
  // holds; `lapsed-holder-kept` never takes it from one whose lease lapsed.
  action claim(p: int): bool = {
    val me = s.procs.get(p)
    val holder_lapsed =
      s.holder != 0 and not(s.procs.get(s.holder).fresh)
    val free = s.holder == 0
      or s.holder == p
      or (holder_lapsed and not(BUGS.contains("lapsed-holder-kept")))
      or BUGS.contains("claim-ignores-holder")
    all {
      me.alive,
      me.sure,
      me.fresh,
      not(me.suspended),
      not(me.running),
      placed_on(s, p) == p,
      free,
      s' = { ...s, holder: p, procs: s.procs.set(p, { ...me, running: true }) },
    }
  }

  // `OwnedKind._balance` handing a key off: a holder sure of its lease that
  // the key is no longer placed on stops it and releases the row. The mutant
  // `no-handoff` keeps it.
  action handoff(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.running,
      me.sure,
      me.fresh,
      not(me.suspended),
      placed_on(s, p) != p,
      not(BUGS.contains("no-handoff")),
      s' = {
        ...with_proc(p, { ...me, running: false }),
        holder: if (s.holder == p) 0 else s.holder,
      },
    }
  }

  // `Ownership._suspend`: a live process no longer sure of its lease stops
  // its work and keeps its rows. The mutant `no-suspend` keeps the work
  // running.
  action suspend(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.alive,
      not(me.sure),
      not(me.suspended),
      not(BUGS.contains("no-suspend")),
      s' = with_proc(p, { ...me, running: false, suspended: true }),
    }
  }

  // `Ownership.balance` once the lease holds again by both readings: the
  // rows the suspension kept are let go of, and the next balance claims back
  // this process's share. The mutant `keeps-rows-on-resume` keeps them, so a
  // key now placed on another process stays held by a row nothing runs.
  action resume(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.alive,
      me.sure,
      me.fresh,
      me.suspended,
      s' = {
        ...with_proc(p, { ...me, suspended: false }),
        holder:
          if (s.holder == p and not(BUGS.contains("keeps-rows-on-resume"))) 0
          else s.holder,
      },
    }
  }

  // `ProcessLease.renew` landing on a live process. One past its deadline
  // has stopped its work before it handles the answer (`ownership.qnt`'s
  // `renew_land`). The mutant `renews-after-death` has something renew a dead
  // process's lease, as a renewal task that outlived its process's work would.
  action renew(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.alive or BUGS.contains("renews-after-death"),
      not(me.sure) or not(me.fresh),
      not(me.running),
      s' = with_proc(p, { ...me, sure: true, fresh: true }),
    }
  }

  // The database's reading lapses: `LEASE_TTL` after the last renewal, which
  // is after the process's own deadline.
  action expire(p: int): bool = {
    val me = s.procs.get(p)
    all {
      not(me.sure),
      me.fresh,
      s' = with_proc(p, { ...me, fresh: false }),
    }
  }

  // Faults, bounded by `MAX_FAULTS`.

  // The process dies: its work stops with it, and its lease is left to lapse.
  action die(p: int): bool = {
    val me = s.procs.get(p)
    all {
      s.faults < MAX_FAULTS,
      me.alive,
      s' = {
        ...with_proc(p, { ...me, alive: false, sure: false, running: false }),
        faults: s.faults + 1,
      },
    }
  }

  // `ProcessLease.stop` after the owned work stopped and was let go of
  // (`release_all`): the database reads the lease stopped at once.
  action shutdown(p: int): bool = {
    val me = s.procs.get(p)
    all {
      s.faults < MAX_FAULTS,
      me.alive,
      s' = {
        procs: s.procs.set(p, {
          alive: false, sure: false, fresh: false, running: false,
          suspended: false,
        }),
        holder: if (s.holder == p) 0 else s.holder,
        faults: s.faults + 1,
      },
    }
  }

  // A live process whose renewals stop landing (its database connection is
  // down, its event loop is blocked) until it is no longer sure of its lease.
  action lose_lease(p: int): bool = {
    val me = s.procs.get(p)
    all {
      s.faults < MAX_FAULTS,
      me.alive,
      me.sure,
      s' = { ...with_proc(p, { ...me, sure: false }), faults: s.faults + 1 },
    }
  }

  // Nothing happens. A run that has settled and spent its faults has nothing
  // left to do, and goes on in this state.
  action idle = s' = s

  action step = {
    nondet p = PROCS.oneOf()
    any {
      idle,
      claim(p),
      handoff(p),
      suspend(p),
      resume(p),
      renew(p),
      expire(p),
      die(p),
      shutdown(p),
      lose_lease(p),
    }
  }

  // The balance (claim and hand-off) runs on an interval, the suspension wakes when the lease stops
  // being sure, a live process renews on an interval, and a lease nobody renews
  // lapses: each happens if it stays possible.
  temporal Fair = PROCS.forall(p => and {
    weakFair(claim(p), s),
    weakFair(handoff(p), s),
    weakFair(suspend(p), s),
    weakFair(resume(p), s),
    weakFair(renew(p), s),
    weakFair(expire(p), s),
  })

  // One process runs the key: the one it is placed on, up, sure of its lease,
  // held by the database, and named by the key's row.
  def settled(st: State): bool = {
    val runners = PROCS.filter(p => st.procs.get(p).running)
    and {
      runners.size() == 1,
      runners.forall(p => and {
        st.procs.get(p).alive,
        st.procs.get(p).sure,
        st.procs.get(p).fresh,
        st.holder == p,
        placed_on(st, p) == p,
      }),
    }
  }

  /// @property replica.ownership-eventual
  /// Some process outlives the faults, and from some point on exactly one
  /// live process holds and runs the key, the one it is placed on: whoever
  /// died or stopped renewing, the work is picked up and stays picked up.
  temporal OwnershipEventual = Fair implies eventually(always(settled(s)))
}
