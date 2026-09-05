import { describe, expect, it } from 'vitest';
import { parseAckBody, parseAlertKey, parseRange, parseStoreQuery, toRecord } from '../src/lib/api/params';
import { badRequest, notFound, ok, withParsed } from '../src/lib/api/respond';

const params = (query: string): URLSearchParams => new URLSearchParams(query);

describe('parseRange', () => {
  it('defaults rather than failing when the parameter is absent', () => {
    expect(parseRange(params(''))).toEqual({ ok: true, value: '7d' });
  });

  it('accepts the named ranges and refuses anything else', () => {
    expect(parseRange(params('range=90d'))).toEqual({ ok: true, value: '90d' });
    const bad = parseRange(params('range=400d'));
    expect(bad.ok).toBe(false);
  });
});

describe('parseStoreQuery', () => {
  it('reads filters, sort and paging', () => {
    const parsed = parseStoreQuery(params('platform=demo&status=active&plan=growth&sort=coverage&cursor=50&limit=10'));
    expect(parsed).toEqual({
      ok: true,
      value: {
        filter: { platform: 'demo', status: 'active', plan: 'growth', needsAttention: false },
        sort: 'coverage',
        cursor: 50,
        limit: 10,
      },
    });
  });

  it('treats a CLEARED filter as absent, not as a filter for the empty string', () => {
    // `?status=` is what a UI sends when its dropdown is reset. Filtering on it
    // would return nothing and look like a bug in the data.
    const parsed = parseStoreQuery(params('status=&plan=%20%20'));
    expect(parsed.ok && parsed.value.filter).toEqual({
      platform: undefined,
      status: undefined,
      plan: undefined,
      needsAttention: false,
    });
  });

  it('reads needsAttention only from the literal string', () => {
    // `Boolean('false')` is true, so a coerced boolean would turn a filter that
    // was explicitly switched off back on.
    const on = parseStoreQuery(params('needsAttention=true'));
    expect(on.ok && on.value.filter.needsAttention).toBe(true);
    const off = parseStoreQuery(params('needsAttention=false'));
    expect(off.ok && off.value.filter.needsAttention).toBe(false);
  });

  it('refuses a sort it does not recognise', () => {
    const parsed = parseStoreQuery(params('sort=%3B+drop+table+stores'));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.issues[0]).toContain('sort');
  });

  it('refuses a negative cursor and an unbounded limit', () => {
    expect(parseStoreQuery(params('cursor=-1')).ok).toBe(false);
    expect(parseStoreQuery(params('limit=50000')).ok).toBe(false);
    expect(parseStoreQuery(params('limit=0')).ok).toBe(false);
  });

  it('defaults paging when nothing is asked for', () => {
    const parsed = parseStoreQuery(params(''));
    expect(parsed.ok && parsed.value).toMatchObject({ sort: 'orders', cursor: 0, limit: 50 });
  });
});

describe('toRecord', () => {
  it('keeps the first value of a repeated key', () => {
    // `?status=a&status=b` is either a bug or an attempt to confuse the parser;
    // either way one answer beats an array nothing downstream expects.
    expect(toRecord(params('status=a&status=b'))).toEqual({ status: 'a' });
  });
});

describe('parseAlertKey', () => {
  it('decodes and accepts a real key', () => {
    expect(parseAlertKey('silent_store%3Ademo%3Ademo%3A1')).toEqual({
      ok: true,
      value: 'silent_store:demo:demo:1',
    });
  });

  it('refuses an empty or oversized key, because it is written to our database', () => {
    expect(parseAlertKey('   ').ok).toBe(false);
    expect(parseAlertKey('x'.repeat(300)).ok).toBe(false);
  });
});

describe('parseAckBody', () => {
  it('accepts an absent body as an acknowledgement with no note', () => {
    expect(parseAckBody(undefined)).toEqual({ ok: true, value: {} });
    expect(parseAckBody({})).toEqual({ ok: true, value: {} });
  });

  it('accepts and trims a note', () => {
    expect(parseAckBody({ note: '  chasing the merchant  ' })).toEqual({
      ok: true,
      value: { note: 'chasing the merchant' },
    });
  });

  it('refuses a note long enough to be a paste of something else', () => {
    expect(parseAckBody({ note: 'x'.repeat(1001) }).ok).toBe(false);
  });
});

describe('respond', () => {
  it('never lets a proxy cache an operator page', async () => {
    // An operator refreshing during an incident must not be served whatever a
    // proxy decided to keep.
    for (const response of [ok({}), badRequest(['bad']), notFound('store')]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('always shapes an error the same way', async () => {
    const response = badRequest(['sort: invalid']);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad_request', issues: ['sort: invalid'] });
    expect(notFound('store').status).toBe(404);
  });

  it('delegates on a good parse and answers 400 on a bad one', async () => {
    const good = await withParsed({ ok: true, value: 7 }, async (value) => ok({ value }));
    expect(await good.json()).toEqual({ value: 7 });

    const bad = await withParsed({ ok: false, issues: ['nope'] }, async () => ok({}));
    expect(bad.status).toBe(400);
  });
});
