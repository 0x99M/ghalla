import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as schema from '../src/db/schema.js';
import {
  compareMigrations,
  countAppliedMigrations,
  extractCount,
  readJournalTags,
  readMigrationState,
} from '../src/db/migration-state.js';

const REAL_FOLDER = path.resolve(import.meta.dirname, '..', 'drizzle');

describe('reading what the code expects', () => {
  it('reads the tags drizzle-kit recorded, newest last', () => {
    const tags = readJournalTags(REAL_FOLDER);
    expect(tags.length).toBeGreaterThanOrEqual(2);
    expect(tags[0]).toBe('0000_init');
    expect(tags.at(-1)).toBe('0001_webhook_queue');
  });

  it('reports no tags rather than throwing when the journal is missing', () => {
    // Diagnostic code. A health endpoint that dies trying to report health is
    // worse than one that says it does not know.
    expect(readJournalTags(path.join(os.tmpdir(), 'ghalla-no-such-folder'))).toStrictEqual([]);
  });

  it('survives a journal that is not what it should be', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghalla-journal-'));
    const meta = path.join(dir, 'meta');
    fs.mkdirSync(meta);
    const journal = path.join(meta, '_journal.json');

    fs.writeFileSync(journal, 'not json at all');
    expect(readJournalTags(dir)).toStrictEqual([]);

    fs.writeFileSync(journal, '"a string, not an object"');
    expect(readJournalTags(dir)).toStrictEqual([]);

    fs.writeFileSync(journal, 'null');
    expect(readJournalTags(dir)).toStrictEqual([]);

    fs.writeFileSync(journal, '{"version":"7"}');
    expect(readJournalTags(dir)).toStrictEqual([]);

    fs.writeFileSync(journal, '{"entries":"not an array"}');
    expect(readJournalTags(dir)).toStrictEqual([]);

    // Entries without a tag are skipped rather than counted as anonymous ones,
    // which would make `expected` too high and report a healthy database behind.
    fs.writeFileSync(journal, '{"entries":[{"tag":"0000_init"},{"idx":1},null,"x"]}');
    expect(readJournalTags(dir)).toStrictEqual(['0000_init']);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('reading one count out of two driver shapes', () => {
  it('takes the pg Result shape', () => {
    expect(extractCount({ rows: [{ n: 2 }] })).toBe(2);
  });

  it('takes the bare array the PGlite driver returns', () => {
    expect(extractCount([{ n: 7 }])).toBe(7);
  });

  it('reports zero for anything it cannot read', () => {
    expect(extractCount(null)).toBe(0);
    expect(extractCount(undefined)).toBe(0);
    expect(extractCount({})).toBe(0);
    expect(extractCount({ rows: 'nope' })).toBe(0);
    expect(extractCount([])).toBe(0);
    expect(extractCount([{ n: '3' }])).toBe(0);
    expect(extractCount([{}])).toBe(0);
  });
});

describe('comparing the two', () => {
  it('calls it current when they agree', () => {
    expect(compareMigrations(['a', 'b'], 2)).toStrictEqual({
      expected: 2,
      applied: 2,
      latest: 'b',
      status: 'current',
    });
  });

  it('calls it behind when the database has fewer', () => {
    // The pre-deploy hook makes this impossible, which is exactly why it is
    // worth asserting: it means the hook did not run.
    expect(compareMigrations(['a', 'b'], 1).status).toBe('behind');
  });

  it('calls it ahead when the database has more', () => {
    // A rollback to an image older than the schema. Reported separately because
    // the remedy is the opposite one: rolling forward is safe, "fixing" it by
    // migrating is not.
    expect(compareMigrations(['a'], 3).status).toBe('ahead');
  });

  it('calls it unknown when the database could not be asked', () => {
    // Distinct from zero. A database that is down and one that is empty are
    // opposite problems.
    expect(compareMigrations(['a', 'b'], -1)).toStrictEqual({
      expected: 2,
      applied: 0,
      latest: 'b',
      status: 'unknown',
    });
  });

  it('has no latest tag when there are no migrations at all', () => {
    expect(compareMigrations([], 0)).toStrictEqual({
      expected: 0,
      applied: 0,
      latest: null,
      status: 'current',
    });
  });
});

describe('against a real database', () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle({ client, schema });
  });

  afterAll(async () => {
    await client.close();
  });

  it('says it cannot tell before anything has been migrated', async () => {
    // drizzle's bookkeeping table does not exist yet, so the query throws — and
    // -1 keeps that distinct from a database that legitimately has none.
    expect(await countAppliedMigrations(db)).toBe(-1);
    expect((await readMigrationState(db, REAL_FOLDER)).status).toBe('unknown');
  });

  it('counts them once they are applied, and calls the schema current', async () => {
    await migrate(db, { migrationsFolder: REAL_FOLDER });
    const expected = readJournalTags(REAL_FOLDER).length;
    expect(await countAppliedMigrations(db)).toBe(expected);

    const state = await readMigrationState(db, REAL_FOLDER);
    expect(state).toStrictEqual({
      expected,
      applied: expected,
      latest: '0001_webhook_queue',
      status: 'current',
    });
  });

  it('reports behind when the code knows of a migration the database lacks', async () => {
    // Simulated by handing it a journal with one more entry than was applied,
    // which is what a deploy whose pre-deploy hook was unset actually looks
    // like from in here.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghalla-ahead-'));
    fs.mkdirSync(path.join(dir, 'meta'));
    const tags = [...readJournalTags(REAL_FOLDER), '0002_not_yet_applied'];
    fs.writeFileSync(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({ entries: tags.map((tag) => ({ tag })) }),
    );

    const state = await readMigrationState(db, dir);
    expect(state.status).toBe('behind');
    expect(state.expected).toBe(state.applied + 1);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
