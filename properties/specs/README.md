# Specs

Quint models of the concurrent parts of Switch. `delivery.qnt` follows how a
room's rows reach an agent; `ownership.qnt` follows how owned work passes
between processes, and `ownership_eventual.qnt` whether it always comes back
to one; `signals.qnt` follows how a change reaches what other
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

A liveness check needs fairness over time that this bounded clock cannot give
honestly, so whether work is picked up at all is a second model with no clock.

## Whether ownership comes back

`ownership_eventual.qnt` has one key and a few processes, and no time. A
process lease is read twice: by the process, sure of it until its own deadline
(`surely_held`), and by the database, holding it until it lapses
(`ProcessLeases.holds`). The process's deadline comes first; `ownership.qnt`
is where that is checked against drifting clocks, and here it is the order the
two lapses may happen in.

| Field | Is | In the code |
| --- | --- | --- |
| `procs[p].alive` | The process is up | |
| `procs[p].sure`, `fresh` | Its own reading of its lease, and the database's | `ProcessLease.surely_held`, `ProcessLeases.holds` |
| `procs[p].running` | It runs the key | `OwnedKind._held` |
| `holder` | Who the key's row names | `ownership_leases` |
| `faults` | Faults so far, bounded by `MAX_FAULTS` | |

`claim`, `suspend`, `renew` and `expire` (the database's reading lapsing,
once the process is no longer sure) are what the system does, each under weak
fairness: the balance and the renewal run on intervals, the suspension wakes
when the lease stops being sure, and a lease nobody renews lapses. `die`,
`shutdown` and `lose_lease` (a live process whose renewals stop landing) are
faults, at most `MAX_FAULTS` of them and fewer than there are processes, so
one outlives them and a run has a point after which none happens. A renewal
reaching a process past its deadline lands only once its work has stopped, as
in `ownership.qnt`.

| Temporal property | Property | It says |
| --- | --- | --- |
| `OwnershipEventual` | `replica.ownership-eventual` | Under that fairness, from some point on exactly one process runs the key, and it is up, sure of its lease, held by the database, and named by the key's row |

TLC checks it over every run (`--temporal`), not state by state: `lease_eventual`
is three processes and two faults (477 states, about a second), and
`lease_eventual_deep` four and three. It says nothing about how long the
pickup takes.

## Signals

`signals.qnt` has one row, the processes that hold it, and three families, one
switched on per check (`signals_view`, `signals_cache`, `signals_room`). A check
follows one holder; a change is made by it or by a process not modelled, so the
holder still misses changes made elsewhere. `signals_view` takes a few minutes,
the others a few seconds.

| Family | Is | In the code |
| --- | --- | --- |
| `view` | What a process holds about the row and acts on; a signal published after the commit, lost if its sender dies first; a queued re-read; resync on reconnect; a re-check `RECHECK` ticks after the last one finished. Each re-read takes time, can fail, and applies what it read when it finishes, unless the view came from a re-read or change of the process's own that began after it | `SignalBus`, `PendingWork`, each family's `on_resync` and `on_recheck` |
| `cache` | An entry kept past its TTL only while the connection it was read under listens, a read an invalidation overtook not stored, and the TTL counted from when the read began | `HeldRows`, `ReadTicket` |
| `room` | The highest announced position kept per room, a subscriber that reads every row after its cursor, every room woken on reconnect | `MessageListener` |

A signal that reaches a listening connection is delivered, in any order;
dropping the connection loses what was not yet handled. A trigger's signal
(`cache`, `room`) is lost only that way, while a published one (`view`) is also
lost when its sender dies between the commit and the send.

| Invariant | Property | It says |
| --- | --- | --- |
| `NoWrongAnswerPastBound` | `revocation.takes-effect-everywhere`, `signal.loss-only-delays` | Past the bound since a change, a process's view is current (one re-check period, one more per failed re-check, and the time its reads were in flight), and its cache answers the current row (the TTL) unless the signal dropping it is still to be handled |
| `LossOnlyDelays` | `signal.loss-only-delays` | A process that listened through every signal, or re-read since one was lost, is current or has the signal or a re-read still to do: no re-read puts back what something newer replaced |
| `NoStrandedRow` | `signal.loss-only-delays` | A row past a listening subscriber's cursor has a wake-up kept or its announcement still to handle |
| `ReadsEveryRow` | `signal.loss-only-delays` | A subscriber has read every row up to its cursor |

The view's bound includes the time its reads take: a read that began before a
change it did not see still applies, until a newer read does. Every read and
every change a process makes takes a stamp as it begins, and a read applies
only if the view came from an older stamp, so whichever began last wins
whatever order they finish in. A read has no timeout of its own: one stuck
on the database fails through the pool and TCP timeouts and is tried again,
and those bound it. The model keeps each stamp as its rank among those in use,
which bounds the states without changing which reads apply.

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
| `lapsed_holder_kept` | A key never taken from a holder whose process lease lapsed | `OwnershipEventual` |
| `eventual_claim_ignores_holder` | A key taken from a holder whose process lease still holds, which goes on running beside the new one | `OwnershipEventual` |
| `no_suspend` | Work goes on running once its process is no longer sure of its lease | `OwnershipEventual` |
| `renews_after_death` | A dead process's lease kept renewed, as by a renewal task that outlived its work | `OwnershipEventual` |
| `view_acts_on_payload` | A handler takes the version a signal carries instead of re-reading | `LossOnlyDelays` |
| `no_resync` | Nothing re-read when the listening connection comes back | `LossOnlyDelays` |
| `no_recheck` | No periodic re-check, so a signal lost with its sender is lost for good | `NoWrongAnswerPastBound` |
| `applies_overtaken_reread` | A re-read applies what it read whenever it finishes, over a newer change | `LossOnlyDelays` |
| `skips_if_changed_since` | A re-read is skipped if anything was applied since it began, so an older read applied first makes the newer one lose | `LossOnlyDelays` |
| `cache_acts_on_payload` | The cache stores what a signal carries instead of dropping the row | `NoWrongAnswerPastBound` |
| `hold_survives_reconnect` | An entry held under one connection is kept under the next | `NoWrongAnswerPastBound` |
| `no_generation` | A read that an invalidation overtook is stored anyway | `NoWrongAnswerPastBound` |
| `ttl_from_store` | The TTL counted from when the read is stored, so a slow read is kept longer | `NoWrongAnswerPastBound` |
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
