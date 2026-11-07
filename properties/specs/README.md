# Specs

Quint models of the concurrent parts of Switch. `delivery.qnt` follows how a
room's rows reach an agent; `configs.qnt` says what bounds each check runs at
and which behaviours that are not in the code each invariant must fail on.

```bash
just properties-model     # model-check every invariant (needs quint and Java)
just properties-mutants   # see every invariant fail on its bug
```

Both run `run.py`, which has TLC (through `quint verify --backend=tlc`) search
every state the model can reach. A pass is exhaustive in the bounds `configs.qnt`
gives a module, and says nothing about more rooms, agents, rows or writers; the
bounds are small because the states TLC searches multiply with each (`bus` is
5,000 states, `retention` 35,000, `recipients` 44,000, `recipients_deep` 2.3
million and minutes). `just properties-model --deep` adds the larger ones, which `properties-scheduled.yml` runs nightly.

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

The last is the code as it was. `created_at` defaulted to `now()`, the start of
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
