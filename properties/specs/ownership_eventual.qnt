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
// fairness promises once nothing renews the lease, and so is the balance that
// claims a free key, the suspension of work whose lease is no longer sure, and
// the renewal of a live process. Faults (a process dying, shutting down, or
// losing its lease while it lives) are bounded, so a run has a point after
// which none happens, and the property is about what holds from there on.
//
// Left out on purpose: how long anything takes (`ownership.qnt`), the token
// and the fence, rendezvous hashing (any process may claim; placement is a
// preference, not what makes work run), and the signal bus (a lost nudge only
// delays a balance, which runs on an interval besides).
module ownership_eventual {
  const PROCS: Set[int]
  const MAX_FAULTS: int
  const BUGS: Set[str]

  // One process: whether it is up, whether it is sure of its own lease
  // (`ProcessLease.surely_held`), whether the database holds it
  // (`ProcessLeases.holds`), and whether it runs the key (`OwnedKind._held`).
  type Proc = {
    alive: bool,
    sure: bool,
    fresh: bool,
    running: bool,
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
        alive: true, sure: true, fresh: true, running: false,
      }),
      holder: 0,
      faults: 0,
    }
  }

  def with_proc(p: int, f: Proc): State =
    { ...s, procs: s.procs.set(p, f) }

  // `_CLAIM` in `Ownership.balance`: a process sure of its own lease, which
  // the database holds, takes the key when no one holds it, when it held it
  // before, or when the holder's process lease no longer holds. The mutant
  // `claim-ignores-holder` takes it from a holder whose lease still holds;
  // `lapsed-holder-kept` never takes it from one whose lease lapsed.
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
      not(me.running),
      free,
      s' = { ...s, holder: p, procs: s.procs.set(p, { ...me, running: true }) },
    }
  }

  // `OwnedKind._suspend`: work whose process is no longer sure of its lease
  // stops. The mutant `no-suspend` keeps it running.
  action suspend(p: int): bool = {
    val me = s.procs.get(p)
    all {
      me.running,
      not(me.sure),
      not(BUGS.contains("no-suspend")),
      s' = with_proc(p, { ...me, running: false }),
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
      suspend(p),
      renew(p),
      expire(p),
      die(p),
      shutdown(p),
      lose_lease(p),
    }
  }

  // The balance runs on an interval, the suspension wakes when the lease stops
  // being sure, a live process renews on an interval, and a lease nobody renews
  // lapses: each happens if it stays possible.
  temporal Fair = PROCS.forall(p => and {
    weakFair(claim(p), s),
    weakFair(suspend(p), s),
    weakFair(renew(p), s),
    weakFair(expire(p), s),
  })

  // One process runs the key: it is up, sure of its lease, the database holds
  // that lease, and the key's row names it.
  def settled(st: State): bool = {
    val runners = PROCS.filter(p => st.procs.get(p).running)
    and {
      runners.size() == 1,
      runners.forall(p => and {
        st.procs.get(p).alive,
        st.procs.get(p).sure,
        st.procs.get(p).fresh,
        st.holder == p,
      }),
    }
  }

  /// @property replica.ownership-eventual
  /// Some process outlives the faults, and from some point on exactly one
  /// live process holds and runs the key: whoever died or stopped renewing,
  /// the work is picked up and stays picked up.
  temporal OwnershipEventual = Fair implies eventually(always(settled(s)))
}
