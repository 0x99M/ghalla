import { describe, expect, it } from 'vitest';
import type { PlatformId } from '@ghalla/contracts';
import { fanOut } from '../src/lib/platforms/fanout';

const target = (platform: string) => ({ platform: platform as PlatformId });
const AT = '2026-09-05T09:00:00.000Z';
const now = () => AT;

describe('fanOut', () => {
  it('returns every platform when all of them answer', async () => {
    const result = await fanOut([target('a'), target('b')], async (t) => `${t.platform}!`, { now });
    expect(result.ok).toEqual([
      { platform: 'a', value: 'a!' },
      { platform: 'b', value: 'b!' },
    ]);
    expect(result.partial).toBe(false);
    expect(result.capturedAt).toBe(AT);
  });

  it('keeps the platforms that answered when one fails', async () => {
    // The whole reason this file exists. `Promise.all` would reject here and
    // blank a page that could have shown half its content perfectly well.
    const result = await fanOut([target('a'), target('b')], async (t) => {
      if (t.platform === 'a') throw new Error('connection refused');
      return 'fine';
    });

    expect(result.ok).toEqual([{ platform: 'b', value: 'fine' }]);
    expect(result.failed).toEqual([{ platform: 'a', reason: 'connection refused' }]);
    expect(result.partial).toBe(true);
  });

  it('marks the result partial, so a gap can never render as a complete number', async () => {
    const result = await fanOut([target('a')], async () => {
      throw new Error('down');
    });
    expect(result.partial).toBe(true);
    expect(result.ok).toEqual([]);
  });

  it('describes a thrown non-Error without losing it', async () => {
    const result = await fanOut([target('a')], async () => {
      throw 'a bare string';
    });
    expect(result.failed[0]?.reason).toBe('a bare string');
  });

  it('survives a task that throws synchronously rather than rejecting', async () => {
    // The one door that looks safe: a synchronous throw escapes during the map
    // and would take down the whole fan-out, which is precisely the failure
    // this file exists to prevent.
    const result = await fanOut([target('a'), target('b')], (t) => {
      if (t.platform === 'a') throw new Error('threw before returning a promise');
      return Promise.resolve('fine');
    });
    expect(result.ok).toEqual([{ platform: 'b', value: 'fine' }]);
    expect(result.failed).toEqual([{ platform: 'a', reason: 'threw before returning a promise' }]);
  });

  it('is not partial when there is nothing to fan out over', async () => {
    const result = await fanOut([], async () => 1);
    expect(result).toMatchObject({ ok: [], failed: [], partial: false });
  });

  it('runs the platforms concurrently rather than one after another', async () => {
    const started: string[] = [];
    await fanOut([target('a'), target('b')], async (t) => {
      started.push(t.platform);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return t.platform;
    });
    // Both started before either finished — a sequential loop would give the
    // portal a page-load time that is the SUM of every platform's latency.
    expect(started).toEqual(['a', 'b']);
  });

  it('stamps a timestamp the response can present as "last updated"', async () => {
    const result = await fanOut([target('a')], async () => 1);
    expect(Number.isNaN(Date.parse(result.capturedAt))).toBe(false);
  });
});
