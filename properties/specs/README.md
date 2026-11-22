# Specs

Quint models of the concurrent parts of Switch. `delivery.qnt` follows how a
room's rows reach an agent; `ownership.qnt` follows how owned work passes
between processes; `signals.qnt` follows how a change reaches what other
processes hold when the `NOTIFY` announcing it is lost; `configs.qnt` says what bounds each check runs at and which
behaviours that are not in the code each invariant must fail on.

```bash
just properties-model     # model-check every invariant (needs quint and Java)
just properties-mutants   # see every invariant fail on its bug
```

Both run `run.py`, which has TLC (through `quint verify --backend=tlc`) search
every state the model can reach. A pass is exhaustive in the bounds `configs.qnt`
gives a module, and says nothing about more rooms, agents, rows or writers; the
bounds are small because the states TLC searches multiply with each (`bus` is
5,000 states, `retention` 35,000, `recipients` 44,000, `lease` 6.4 million
and 20 seconds, `recipients_deep` 2.3 million and minutes, `lease_deep` 65
million and three). `just properties-model --deep` adds the larger ones, which `properties-scheduled.yml` runs nightly.

## What the state is

`delivery.qnt` keeps one record, `s`. Each field is a table, or what a process
holds, in the code.

| Field | Is | In the code |
| --- | --- | --- |
| `rows`, `head` | Committed room rows, and the room's highest `seq` | `messages`; `MessageStore._next_seq` |
| `room_lock` | Who holds the room's advisory lock, to commit | `pg_advisory_xact_lock(hashtext(room))` |
| `agent_lock` | Who holds the agent's head row, to commit | the row `EventBuffer._claim` upserts |
| `txs` | One writer's open transaction: the room row, the agents still to number an event for, the numbers claimed | `MessageRouter` calling `EventBuffer.store` |
| `members` | Who is in each room | `client_rooms` |
| `heads` | Where each agent's numbering starts and stands | `agent_event_heads` (`first_seq`, `last_seq`) |
| `events` | An agent's retained own events | `agent_events` |
| `drops` | The newest number retention deleted, per agent and room | `agent_event_drops` |
| `boot`, `clock` | The server's boot number; time | `sequence_floor`; `created_at` |
| `position`, `accounted` | A client's place in its agent's events, and what it was given or told it lost | the stream's cursor (`stream.py`) |
| `owed`, `numbered`, `sources` | Ghosts the invariants read, never the system: what each agent is owed, the numbers given to committed events in order, where each came from | |

An action is a step of one process; the code it follows is named above each in
`delivery.qnt`.

- `begin`, `claim`, `commit` and `rollback` are a router transaction: the room's
  lock, the row's `seq`, who it is for (decided here, from the room as it is),
  each agent's number and event (stored only if the agent is still a member),
  and the commit that makes all of it visible and releases the locks.
- `join` and `leave` change membership; leaving is `forget_room`, which waits for
  the agent's head row and deletes the agent's events in the room.
- `expire` is retention, `read` is a client reading from its position (the
  stream's resume and `read_from`), `tick` is time, `restart` is a new boot.

Left out: the wake-up (a lost one only delays a read), room commands, and what an
agent does that is not receiving.

## The invariants

| Invariant | Property | It says |
| --- | --- | --- |
| `RoomSeqDense` | `bus.room-seq-dense` | Committed rows are numbered 1, 2, 3 in commit order |
| `DecidedAtWrite` | `delivery.decided-at-write` | An event is for a row that decided it, from the agents it addressed that were in the room then |
| `OwnSeqContiguous` | `delivery.own-seq-contiguous` | An agent's numbers, in commit order, each follow the last, and its head row says where they stand |
| `AddressedExactlyOnce` | `delivery.addressed-exactly-once` | Each agent a row was for has one event for it, and no two events come from one row |
| `NoSilentLoss` | `delivery.no-silent-loss` | Whatever a client's position has passed, it was given or told it lost |
| `NoEventsAfterLeave` | `delivery.no-events-after-leave` | A member who has left has no events in the room |

## Leases and ownership

`ownership.qnt` has one key and two processes. Time is the database's `now`;
each process's own monotonic clock moves one to three for every two, so one can
run at half the rate and another at one and a half. A process can also stall
(a paused runtime) and go on from where it was.

| Field | Is | In the code |
| --- | --- | --- |
| `procs[p].row`, `beat`, `stopped` | A process's lease as the database holds it | `switch_core_processes` |
| `procs[p].local`, `sent`, `pending`, `inflight` | The process's clock; when the last renewal that landed was sent; one in flight | `ProcessLease._renewed_at` |
| `procs[p].running`, `token` | Whether it runs the key, and under which token | `OwnedKind._held`, `Fence` |
| `holder`, `token` | The key's lease row, whose token survives a release | `ownership_leases` |
| `writes` | The token of every write accepted | `DeliveryCursorStore.advance` |

Actions are `renew_send` and `renew_land` (a renewal is stamped when it lands,
and counted from when it was sent), `claim`, `stop_work`, `release`, `shutdown`,
`crash`, `stall`, `resume`, `write` and `tick`. Time cannot pass a running,
unstalled process's deadline: `Ownership.run` wakes it as the lease stops being
sure. A stalled process is the one that misses it, and the fence is what then
refuses its writes. A running process past its deadline also stops before it
handles the answer to a renewal, so a late answer cannot revive it.

| Invariant | Property | It says |
| --- | --- | --- |
| `NoOverlap` | `lease.no-overlap` | At most one process is running the key and sure of its lease |
| `FencedTakeover` | `lease.fenced-takeover` | Accepted writes carry non-decreasing tokens, none above the key's |

`lease.eventual-owner` is not modelled: a liveness check needs fairness over
time that this bounded model cannot give honestly, so it stays a property of
the running system.

## Signals

`signals.qnt` has one row, the processes that hold it, and three families, one
switched on per check (`signals_view`, `signals_cache`, `signals_room`). A check
follows one holder; a change is made by it or by a process not modelled, so the
holder still misses changes made elsewhere. Each check is a few seconds.

| Family | Is | In the code |
| --- | --- | --- |
| `view` | What a process holds about the row and acts on; a signal published after the commit, lost if its sender dies first; a queued re-read; resync on reconnect; a re-check every `RECHECK` ticks | `SignalBus`, `PendingWork`, each family's `on_resync` and `on_recheck` |
| `cache` | An entry kept past its TTL only while the connection it was read under listens, and a read an invalidation overtook not stored | `HeldRows`, `ReadTicket` |
| `room` | The highest announced position kept per room, a subscriber that reads every row after its cursor, every room woken on reconnect | `MessageListener` |

A signal that reaches a listening connection is delivered, in any order;
dropping the connection loses what was not yet handled. A trigger's signal
(`cache`, `room`) is lost only that way, while a published one (`view`) is also
lost when its sender dies between the commit and the send.

| Invariant | Property | It says |
| --- | --- | --- |
| `NoWrongAnswerPastBound` | `revocation.takes-effect-everywhere`, `signal.loss-only-delays` | Past the bound since a change, a process's view is current (one re-check), and its cache answers the current row (the TTL plus the time the entry's read took) unless the signal dropping it is still to be handled |
| `LossOnlyDelays` | `signal.loss-only-delays` | A process that listened through every signal, or re-read since one was lost, is current or has the signal or re-read still to do |
| `NoStrandedRow` | `signal.loss-only-delays` | A row past a listening subscriber's cursor has a wake-up kept or its announcement still to handle |
| `ReadsEveryRow` | `signal.loss-only-delays` | A subscriber has read every row up to its cursor |

The cache's bound is the TTL plus the read's duration because `HeldRows.put`
starts the TTL when the read is stored: a read that began before a missed
change and finished later is kept for the whole TTL from then.

## Mutants

Each module `mutant_*` in `configs.qnt` switches on one behaviour that is not
in the code, and `run.py` expects the invariant it names to be violated. An
invariant that held on such a system could not have caught that bug.

| Mutant | The bug | Fails |
| --- | --- | --- |
| `room_seq_from_counter` | Rows numbered from a database sequence, which hands out numbers outside the transaction | `RoomSeqDense` |
| `late_delivery` | Who a row was for worked out again later, from the room as it is then | `DecidedAtWrite` |
| `number_from_highest_retained` | Numbers taken from the highest stored event, not the head row | `OwnSeqContiguous` |
| `no_source_dedupe` | A repeated write stored again under a new number | `AddressedExactlyOnce` |
| `forget_without_lock` | Leaving deletes events without waiting for a transaction numbering one | `NoEventsAfterLeave` |
| `store_skips_membership_recheck` | An event stored for an agent that left after the decision | `NoEventsAfterLeave` |
| `expire_without_drop_mark` | Retention deletes without recording where | `NoSilentLoss` |
| `own_seq_released_early` | Agent numbers taken from a sequence and not held to commit | `NoSilentLoss` |
| `created_at_transaction_start` | An event's `created_at` is when its transaction began | `NoSilentLoss` |
| `claim_ignores_holder` | A key taken from a holder whose process lease still holds | `NoOverlap` |
| `release_before_stop` | The key released while its work still runs | `NoOverlap` |
| `stop_at_full_lease` | The holder stops at the whole lease, not half | `NoOverlap` |
| `write_without_token` | A write accepted whoever the holder is | `FencedTakeover` |
| `view_acts_on_payload` | A handler takes the version a signal carries instead of re-reading | `LossOnlyDelays` |
| `no_resync` | Nothing re-read when the listening connection comes back | `LossOnlyDelays` |
| `no_recheck` | No periodic re-check, so a signal lost with its sender is lost for good | `NoWrongAnswerPastBound` |
| `cache_acts_on_payload` | The cache stores what a signal carries instead of dropping the row | `NoWrongAnswerPastBound` |
| `hold_survives_reconnect` | An entry held under one connection is kept under the next | `NoWrongAnswerPastBound` |
| `no_generation` | A read that an invalidation overtook is stored anyway | `NoWrongAnswerPastBound` |
| `no_wake_on_reconnect` | The message listener does not wake every room on reconnect | `NoStrandedRow` |
| `reads_announced_row` | A woken subscriber reads the row the announcement named, not everything after its cursor | `ReadsEveryRow` |

`created_at_transaction_start` is the code as it was. `created_at` defaulted to `now()`, the start of
the transaction, so a transaction that began earlier and numbered its event later
had a lower number and a later `created_at` than one that began later. Retention
deletes by `created_at` and a reader takes everything numbered below what
retention kept as deleted, so `expire` could delete the higher number, keep the
lower, and a client resuming from before both was told about the room of the
higher and moved past the lower without a word. The counterexample is nine
steps: two transactions begin in different rooms, the later one numbers and
commits first, the earlier one numbers and commits, time passes, retention
deletes the earlier one's event and a client reads. The fix is `clock_timestamp()`
in `EventBuffer._own_event_insert`, and `test_event_buffer_created_at.py` holds it.
