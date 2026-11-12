// How a room's rows reach an agent: the bus, the router's decision, the agent's
// own events, retention and a client resuming.
//
// Each definition below says which code it follows. The state is named so that
// `properties/specs/README.md` can map it to tables.
//
// Left out on purpose: the wake-up (`messages/notify.py`; a lost wake-up only
// delays a read, and the model reads the way a cursor reader does), room
// commands (`EventBuffer.enqueue` stores those in a transaction of their own),
// and everything an agent does that is not receiving.
module delivery {
  // A row of `agent_events`. `born` is its `created_at`, the clock when the
  // event was numbered (`clock_timestamp()` in `_own_event_insert`). Numbering
  // is in commit order, so this is the order of the numbers. Mutant
  // `created-at-transaction-start` is the code before that: `now()`, the
  // start of the transaction, which two transactions can reverse.
  type Event = { seq: int, room: str, room_seq: int, born: int }

  // A row of `messages`, with what the router decided about it. `planned` is
  // who it was for when it was written, `stored` those that were given an
  // event and `skipped` those that left the room before theirs was stored.
  type Row = {
    seq: int,
    addressed: Set[int],
    planned: Set[int],
    stored: Set[int],
    skipped: Set[int],
  }

  // An agent's row in `agent_event_heads`.
  type Head = { exists: bool, first: int, last: int }

  // One writer's open transaction: the router writing one room row and
  // numbering the events decided for it (`EventBuffer.store`).
  type Tx = {
    phase: str,
    room: str,
    addressed: Set[int],
    seq: int,
    planned: Set[int],
    todo: Set[int],
    claims: int -> Event,
    skipped: Set[int],
    began: int,
  }

  type State = {
    // Committed rows in commit order, and the room's highest `seq`.
    rows: str -> List[Row],
    head: str -> int,
    // A database sequence's counter, used only by the mutant that numbers
    // rows from one.
    room_counter: str -> int,
    agent_counter: int -> int,
    // Who holds the room's advisory lock and the agent's head row, 0 for no
    // one. Both are held to commit.
    room_lock: str -> int,
    agent_lock: int -> int,
    txs: int -> Tx,
    // `client_rooms`.
    members: str -> Set[int],
    // `agent_event_heads`, committed.
    heads: int -> Head,
    // `agent_events`, committed and retained.
    events: int -> Set[Event],
    // `agent_event_drops`: the newest number retention deleted, per room.
    drops: int -> (str -> int),
    // The server's boot number; a new boot numbers new agents from a higher
    // floor.
    boot: int,
    clock: int,
    // A client's position in its agent's own events, and what it has been
    // given or told it lost.
    position: int -> int,
    accounted: int -> Set[int],
    // Ghosts, never read by the system: the events each agent is owed (every
    // committed one, except those removed because it left the room), the
    // numbers handed to committed events in commit order, and the source of
    // each event.
    owed: int -> Set[Event],
    numbered: int -> List[int],
    sources: int -> List[(str, int)],
  }

  // The bounds a check runs at, set where the module is instantiated
  // (`configs.qnt`).
  const ROOMS: Set[str]
  const AGENTS: Set[int]
  const WRITERS: Set[int]
  const MAX_ROWS: int
  const MAX_BOOT: int
  const MAX_CLOCK: int

  // Behaviours that are not in the code, which `configs.qnt` switches on one at
  // a time so each invariant is seen to fail. Empty is the system as it is.
  const BUGS: Set[str]

  pure def floor(boot: int): int = 10 * (boot + 1)

  pure def smallest(xs: Set[int]): int = xs.fold(1000, (m, x) => if (x < m) x else m)
  pure def largest(xs: Set[int]): int = xs.fold(0, (m, x) => if (x > m) x else m)

  pure val NO_CLAIMS: int -> Event = Map()
  pure val IDLE: Tx = {
    phase: "idle",
    room: "",
    addressed: Set(),
    seq: 0,
    planned: Set(),
    todo: Set(),
    claims: NO_CLAIMS,
    skipped: Set(),
    began: 0,
  }

  var s: State

  action init = s' = {
    rows: ROOMS.mapBy(r => List()),
    head: ROOMS.mapBy(r => 0),
    room_counter: ROOMS.mapBy(r => 0),
    agent_counter: AGENTS.mapBy(a => 0),
    room_lock: ROOMS.mapBy(r => 0),
    agent_lock: AGENTS.mapBy(a => 0),
    txs: WRITERS.mapBy(w => IDLE),
    members: ROOMS.mapBy(r => AGENTS),
    heads: AGENTS.mapBy(a => { exists: false, first: 0, last: 0 }),
    events: AGENTS.mapBy(a => Set()),
    drops: AGENTS.mapBy(a => ROOMS.mapBy(r => 0)),
    boot: 0,
    clock: 0,
    position: AGENTS.mapBy(a => 0),
    accounted: AGENTS.mapBy(a => Set()),
    owed: AGENTS.mapBy(a => Set()),
    numbered: AGENTS.mapBy(a => List()),
    sources: AGENTS.mapBy(a => List()),
  }

  // `MessageStore._next_seq`: the room's lock, then one above its highest
  // `seq`, and the router's decision: who the row is for, from the room's
  // membership as it is now.
  action begin(w: int, room: str, addressed: Set[int]): bool = {
    val numbered_from_counter = BUGS.contains("room-seq-from-counter")
    val seq =
      if (numbered_from_counter) s.room_counter.get(room) + 1
      else s.head.get(room) + 1
    val planned = addressed.filter(a => s.members.get(room).contains(a))
    all {
      s.txs.get(w).phase == "idle",
      s.room_lock.get(room) == 0,
      s.head.get(room) < MAX_ROWS,
      s.room_counter.get(room) < MAX_ROWS,
      s' = { ...s,
        room_lock:
          if (numbered_from_counter) s.room_lock else s.room_lock.set(room, w),
        room_counter:
          if (numbered_from_counter) s.room_counter.set(room, seq)
          else s.room_counter,
        txs: s.txs.set(w, {
          phase: "routing",
          room: room,
          addressed: addressed,
          seq: seq,
          planned: planned,
          todo: planned,
          claims: NO_CLAIMS,
          skipped: Set(),
          began: s.clock,
        }),
      },
    }
  }

  // `EventBuffer.store` for the next agent, in agent order: claim the next
  // number from the agent's head row, which stays locked to commit, then store
  // the event only if the agent is still a member of the room.
  action claim(w: int): bool = {
    val tx = s.txs.get(w)
    val a = smallest(tx.todo)
    val hd = s.heads.get(a)
    val numbered_from_counter = BUGS.contains("own-seq-released-early")
    val retained = s.events.get(a).map(e => e.seq)
    val number =
      if (numbered_from_counter) s.agent_counter.get(a) + 1
      else if (BUGS.contains("number-from-highest-retained"))
        (if (retained == Set()) floor(s.boot) else largest(retained) + 1)
      else if (hd.exists) hd.last + 1
      else floor(s.boot)
    val member = s.members.get(tx.room).contains(a)
    val storing = member or BUGS.contains("store-skips-membership-recheck")
    val event = {
      seq: number,
      room: tx.room,
      room_seq: tx.seq,
      born:
        if (BUGS.contains("created-at-transaction-start")) tx.began
        else s.clock,
    }
    all {
      tx.phase == "routing",
      tx.todo != Set(),
      s.agent_lock.get(a) == 0,
      if (storing)
        s' = { ...s,
          agent_lock:
            if (numbered_from_counter) s.agent_lock else s.agent_lock.set(a, w),
          agent_counter:
            if (numbered_from_counter) s.agent_counter.set(a, number)
            else s.agent_counter,
          txs: s.txs.set(w, { ...tx,
            todo: tx.todo.exclude(Set(a)),
            claims: tx.claims.put(a, event),
          }),
        }
      else
        s' = { ...s,
          txs: s.txs.set(w, { ...tx,
            todo: tx.todo.exclude(Set(a)),
            skipped: tx.skipped.union(Set(a)),
          }),
        },
    }
  }

  // The transaction commits: the row, its events and the heads advanced by
  // them become visible together, and both locks are released.
  action commit(w: int): bool = {
    val tx = s.txs.get(w)
    val agents = tx.claims.keys()
    val row = {
      seq: tx.seq,
      addressed: tx.addressed,
      planned: tx.planned,
      stored: agents,
      skipped: tx.skipped,
    }
    all {
      tx.phase == "routing",
      tx.todo == Set(),
      s' = { ...s,
        rows: s.rows.set(tx.room, s.rows.get(tx.room).append(row)),
        head: s.head.set(tx.room, largest(Set(s.head.get(tx.room), tx.seq))),
        room_lock: s.room_lock.keys().mapBy(r =>
          if (s.room_lock.get(r) == w) 0 else s.room_lock.get(r)),
        agent_lock: s.agent_lock.keys().mapBy(a =>
          if (s.agent_lock.get(a) == w) 0 else s.agent_lock.get(a)),
        heads: s.heads.keys().mapBy(a =>
          if (agents.contains(a)) {
            exists: true,
            first:
              if (s.heads.get(a).exists) s.heads.get(a).first
              else tx.claims.get(a).seq,
            last: largest(Set(s.heads.get(a).last, tx.claims.get(a).seq)),
          } else s.heads.get(a)),
        events: s.events.keys().mapBy(a =>
          if (agents.contains(a)) s.events.get(a).union(Set(tx.claims.get(a)))
          else s.events.get(a)),
        owed: s.owed.keys().mapBy(a =>
          if (agents.contains(a)) s.owed.get(a).union(Set(tx.claims.get(a)))
          else s.owed.get(a)),
        numbered: s.numbered.keys().mapBy(a =>
          if (agents.contains(a)) s.numbered.get(a).append(tx.claims.get(a).seq)
          else s.numbered.get(a)),
        sources: s.sources.keys().mapBy(a =>
          if (agents.contains(a))
            s.sources.get(a).append((tx.room, tx.seq))
          else s.sources.get(a)),
        txs: s.txs.set(w, IDLE),
      },
    }
  }

  // The transaction rolls back: its numbers go back with it, and so do its
  // locks.
  action rollback(w: int): bool = all {
    s.txs.get(w).phase == "routing",
    s' = { ...s,
      room_lock: s.room_lock.keys().mapBy(r =>
        if (s.room_lock.get(r) == w) 0 else s.room_lock.get(r)),
      agent_lock: s.agent_lock.keys().mapBy(a =>
        if (s.agent_lock.get(a) == w) 0 else s.agent_lock.get(a)),
      txs: s.txs.set(w, IDLE),
    },
  }

  action join(a: int, room: str): bool = all {
    not(s.members.get(room).contains(a)),
    s' = { ...s, members: s.members.set(room, s.members.get(room).union(Set(a))) },
  }

  // `EventBuffer.forget_room`, in the transaction that removes the member: it
  // locks the agent's head row first, so it waits for a transaction that has
  // numbered an event for the agent, and deletes the agent's events in the
  // room. No gap is recorded and the numbers stay used.
  action leave(a: int, room: str): bool = {
    val hd = s.heads.get(a)
    val gone = s.events.get(a).filter(e => e.room == room)
    all {
      s.members.get(room).contains(a),
      or {
        BUGS.contains("forget-without-lock"),
        s.agent_lock.get(a) == 0,
      },
      s' = { ...s,
        members: s.members.set(room, s.members.get(room).exclude(Set(a))),
        heads: s.heads.set(a,
          if (hd.exists) hd
          else { exists: true, first: floor(s.boot), last: floor(s.boot) - 1 }),
        events: s.events.set(a, s.events.get(a).exclude(gone)),
        owed: s.owed.set(a, s.owed.get(a).exclude(
          s.owed.get(a).filter(e => e.room == room))),
      },
    }
  }

  // `EventBuffer.expire`: delete the agent's events whose `created_at` is
  // before the cutoff, and record per room the newest number deleted.
  action expire(a: int, cutoff: int): bool = {
    val gone = s.events.get(a).filter(e => e.born < cutoff)
    all {
      gone != Set(),
      cutoff <= s.clock,
      s' = { ...s,
        events: s.events.set(a, s.events.get(a).exclude(gone)),
        drops:
          if (BUGS.contains("expire-without-drop-mark")) s.drops
          else s.drops.set(a, ROOMS.mapBy(r =>
            largest(Set(
              s.drops.get(a).get(r),
              largest(gone.filter(e => e.room == r).map(e => e.seq)),
            )))),
      },
    }
  }

  // A client of the agent reads its own events from its position: the stream's
  // resume (`stream.py`) followed by `EventBuffer.read_from`. A position below
  // where the agent's numbering starts is from an earlier server and is told
  // as a gap in every room; one below what retention deleted is told as a gap
  // naming the rooms it deleted from (`check_cursor`), and moves to
  // `before_retained`.
  action read(a: int): bool = {
    val at = s.position.get(a)
    val stored = s.heads.get(a)
    val hd =
      if (stored.exists) stored
      else { exists: true, first: floor(s.boot), last: floor(s.boot) - 1 }
    val earlier_boot = 0 < at and at < hd.first - 1
    val at1 = if (earlier_boot) hd.first - 1 else at
    val dropped = ROOMS.filter(r => s.drops.get(a).get(r) > at1)
    val newest_drop = largest(ROOMS.map(r => s.drops.get(a).get(r)))
    val retained = s.events.get(a).map(e => e.seq)
    val oldest = if (retained == Set()) 0 else smallest(retained)
    val at2 =
      if (dropped == Set()) at1
      else largest(Set(newest_drop, oldest - 1, 0))
    val delivered = s.events.get(a).filter(e => e.seq > at2 and e.seq <= hd.last)
    val told_lost = s.owed.get(a).filter(e =>
      or {
        earlier_boot and e.seq > at and e.seq <= at1,
        dropped.contains(e.room) and e.seq > at1 and e.seq <= at2,
      })
    all {
      // A reader of an agent with no head row inserts one, and waits for a
      // transaction that is inserting it.
      or { stored.exists, s.agent_lock.get(a) == 0 },
      s' = { ...s,
        heads: s.heads.set(a, hd),
        position: s.position.set(a, largest(Set(at2, hd.last))),
        accounted: s.accounted.set(a,
          s.accounted.get(a)
            .union(delivered.map(e => e.seq))
            .union(told_lost.map(e => e.seq))),
      },
    }
  }

  // Time passes.
  action tick: bool = all {
    s.clock < MAX_CLOCK,
    s' = { ...s, clock: s.clock + 1 },
  }

  // A restart: every open transaction is lost, and the next boot numbers
  // agents that have no head row from a higher floor.
  action restart: bool = all {
    s.boot < MAX_BOOT,
    s' = { ...s,
      boot: s.boot + 1,
      room_lock: ROOMS.mapBy(r => 0),
      agent_lock: AGENTS.mapBy(a => 0),
      txs: WRITERS.mapBy(w => IDLE),
    },
  }

  // Mutant: the router works out who a row was for again later, from the room
  // as it is then, instead of keeping what it decided as the row was written.
  action late_delivery(room: str, i: int, a: int): bool = {
    val row = s.rows.get(room).nth(i)
    val hd = s.heads.get(a)
    val number = if (hd.exists) hd.last + 1 else floor(s.boot)
    val event = { seq: number, room: room, room_seq: row.seq, born: s.clock }
    all {
      BUGS.contains("late-delivery"),
      i >= 0 and i < s.rows.get(room).length(),
      row.addressed.contains(a),
      not(row.stored.contains(a)),
      s.members.get(room).contains(a),
      s.agent_lock.get(a) == 0,
      s' = { ...s,
        heads: s.heads.set(a, {
          exists: true,
          first: if (hd.exists) hd.first else number,
          last: number,
        }),
        events: s.events.set(a, s.events.get(a).union(Set(event))),
        owed: s.owed.set(a, s.owed.get(a).union(Set(event))),
        numbered: s.numbered.set(a, s.numbered.get(a).append(number)),
        sources: s.sources.set(a, s.sources.get(a).append((room, row.seq))),
      },
    }
  }

  // Mutant: a write repeated after a commit whose acknowledgement was lost is
  // stored again under a new number, because nothing recognises its source
  // (`uq_agent_events_source`).
  action repeated_write(room: str, i: int, a: int): bool = {
    val row = s.rows.get(room).nth(i)
    val hd = s.heads.get(a)
    val event = { seq: hd.last + 1, room: room, room_seq: row.seq, born: s.clock }
    all {
      BUGS.contains("no-source-dedupe"),
      i >= 0 and i < s.rows.get(room).length(),
      row.stored.contains(a),
      s.members.get(room).contains(a),
      s.agent_lock.get(a) == 0,
      s' = { ...s,
        heads: s.heads.set(a, { ...hd, last: event.seq }),
        events: s.events.set(a, s.events.get(a).union(Set(event))),
        owed: s.owed.set(a, s.owed.get(a).union(Set(event))),
        numbered: s.numbered.set(a, s.numbered.get(a).append(event.seq)),
        sources: s.sources.set(a, s.sources.get(a).append((room, row.seq))),
      },
    }
  }

  action step = {
    nondet w = WRITERS.oneOf()
    nondet room = ROOMS.oneOf()
    nondet agent = AGENTS.oneOf()
    nondet addressed = AGENTS.powerset().oneOf()
    nondet cutoff = 1.to(MAX_CLOCK).oneOf()
    nondet i = 0.to(MAX_ROWS - 1).oneOf()
    any {
      begin(w, room, addressed),
      claim(w),
      commit(w),
      rollback(w),
      join(agent, room),
      leave(agent, room),
      expire(agent, cutoff),
      read(agent),
      tick,
      restart,
      late_delivery(room, i, agent),
      repeated_write(room, i, agent),
    }
  }

  /// @property bus.room-seq-dense
  /// A room's committed rows, in commit order, are numbered 1, 2, 3, with
  /// none missing and none out of order.
  val RoomSeqDense = ROOMS.forall(r =>
    s.rows.get(r).indices().forall(i => s.rows.get(r).nth(i).seq == i + 1))

  /// @property delivery.decided-at-write
  /// Every event is for a row that decided it, at the time it was written
  /// (`stored`), from the agents it addressed that were in the room then
  /// (`planned`).
  val DecidedAtWrite = and {
    ROOMS.forall(r => s.rows.get(r).indices().forall(i => {
      val row = s.rows.get(r).nth(i)
      and {
        row.stored.subseteq(row.planned),
        row.planned.subseteq(row.addressed),
      }
    })),
    AGENTS.forall(a => s.owed.get(a).forall(e =>
      s.rows.get(e.room).indices().exists(i => {
        val row = s.rows.get(e.room).nth(i)
        row.seq == e.room_seq and row.stored.contains(a)
      }))),
  }

  /// @property delivery.own-seq-contiguous
  /// An agent's own-event numbers, in commit order, are its first number and
  /// each one above the last, and its head row says where they stand.
  val OwnSeqContiguous = AGENTS.forall(a => {
    val hd = s.heads.get(a)
    val log = s.numbered.get(a)
    and {
      log.length() > 0 implies hd.exists,
      hd.exists implies hd.last == hd.first - 1 + log.length(),
      log.indices().forall(i => log.nth(i) == hd.first + i),
    }
  })

  /// @property delivery.addressed-exactly-once
  /// Each agent a row was for has one event for it, and no two events of an
  /// agent come from the same row.
  val AddressedExactlyOnce = and {
    ROOMS.forall(r => s.rows.get(r).indices().forall(i => {
      val row = s.rows.get(r).nth(i)
      and {
        row.stored.union(row.skipped) == row.planned,
        row.stored.intersect(row.skipped) == Set(),
        row.stored.forall(a =>
          s.sources.get(a).indices().exists(j => s.sources.get(a).nth(j) == (r, row.seq))),
      }
    })),
    AGENTS.forall(a => {
      val log = s.sources.get(a)
      log.indices().forall(i => log.indices().forall(j =>
        log.nth(i) == log.nth(j) implies i == j))
    }),
  }

  /// @property delivery.no-silent-loss
  /// Whatever a client's position has passed, it was given or was told it
  /// lost.
  val NoSilentLoss = AGENTS.forall(a =>
    s.owed.get(a).forall(e =>
      e.seq <= s.position.get(a) implies s.accounted.get(a).contains(e.seq)))

  /// @property delivery.no-events-after-leave
  /// An agent that has left a room has none of its events in it.
  val NoEventsAfterLeave = AGENTS.forall(a =>
    s.owed.get(a).forall(e => s.members.get(e.room).contains(a)))
}
