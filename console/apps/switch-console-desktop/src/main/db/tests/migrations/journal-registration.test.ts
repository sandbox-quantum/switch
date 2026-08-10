/**
 * Every bundled migration must be listed in the journal (CHOO-1809).
 *
 * The runner iterates `_journal.json`, so a `.sql` file the journal does not
 * list is not "pending" — it is invisible. It can never be applied on any
 * machine, and the app boots reporting migration success with the table absent.
 * Migration 0046 shipped in exactly that state: the SQL and its snapshot were
 * committed, the journal entry was not, and the only symptom was `no such
 * table: remote_host_setup_plans` at the point something tried to use it.
 *
 * Running the migrations cannot detect this, because the missing entry is the
 * thing that would have driven the run. It is only visible by comparing the two
 * sets, which is what these tests do.
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { orphanedMigrationTags } from '@main/db/initialize';
import journal from '@root/drizzle/meta/_journal.json';

const drizzleDir = fileURLToPath(new URL('../../../../../drizzle', import.meta.url));

const journalTags = journal.entries.map((entry) => entry.tag);
const sqlTags = readdirSync(drizzleDir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''));

describe('migration journal registration', () => {
  it('finds the migration files at all, so the checks below are not vacuous', () => {
    expect(sqlTags.length).toBeGreaterThan(0);
  });

  it('lists every bundled .sql file in the journal', () => {
    expect(orphanedMigrationTags(sqlTags, journalTags)).toEqual([]);
  });

  it('has a bundled .sql file for every journal entry', () => {
    // The runner already throws on this one; asserting it here reports the whole
    // set at once rather than whichever entry the loop reached first.
    const missing = journalTags.filter((tag) => !sqlTags.includes(tag));
    expect(missing).toEqual([]);
  });

  it('numbers journal entries contiguously from zero', () => {
    // A gap means an entry was hand-edited out; a duplicate means two branches
    // claimed the same number and the merge kept both.
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      journal.entries.map((_, index) => index)
    );
  });

  it('has no duplicate tags', () => {
    expect(new Set(journalTags).size).toBe(journalTags.length);
  });

  /**
   * The runner skips with `entry.when <= lastTimestamp`, where `lastTimestamp`
   * is the highest `created_at` in the ledger — not a record of which
   * migrations ran. So an entry whose `when` is below a preceding entry's can
   * never be applied on any machine: it is skipped on every boot, silently,
   * while migration reports success and the table it creates is simply absent.
   *
   * Two branches landing migrations out of order is enough to cause it, which
   * is the same class of merge accident that produced the 0045/0046 renumber.
   * Keying the ledger per migration would remove the dependency entirely; until
   * then the precondition is at least asserted rather than assumed.
   */
  it('orders journal entries by strictly increasing timestamp', () => {
    const whens = journal.entries.map((entry) => entry.when);

    expect(whens).toEqual([...whens].sort((a, b) => a - b));
    expect(new Set(whens).size).toBe(whens.length);
  });
});

describe('orphanedMigrationTags', () => {
  it('reports a bundled file the journal does not list', () => {
    expect(orphanedMigrationTags(['/x/0001_a.sql', '/x/0002_b.sql'], ['0001_a'])).toEqual([
      '0002_b',
    ]);
  });

  it('accepts full paths, as the bundler produces', () => {
    expect(orphanedMigrationTags(['/build/drizzle/0002_b.sql'], ['0001_a'])).toEqual(['0002_b']);
  });

  it('reports nothing when every file is registered', () => {
    expect(orphanedMigrationTags(['/x/0001_a.sql'], ['0001_a', '0002_unbundled'])).toEqual([]);
  });

  it('matches tags exactly, not by prefix', () => {
    // `0012_foo` must not vouch for a bundled `0012_foo_bar.sql`. The runner
    // resolves SQL the same way, where a prefix match would apply one
    // migration's file under another's name.
    expect(orphanedMigrationTags(['/x/0012_foo_bar.sql'], ['0012_foo'])).toEqual(['0012_foo_bar']);
  });
});
