import { describe, expect, it, vi } from 'vitest';
import { liveness } from '../src/lib/health';

const AT = '2026-09-05T09:00:00.000Z';

describe('liveness', () => {
  it('is ok when the portal can reach its own database', async () => {
    expect(await liveness(async () => undefined, { now: () => AT })).toEqual({
      status: 'ok',
      checkedAt: AT,
    });
  });

  it('answers with a WORD and a timestamp, and puts the cause in the log', async () => {
    // Anyone on the internet can call this. A body naming platforms and quoting
    // connection errors would tell an unauthenticated caller which integrations
    // exist, which are down, and occasionally part of a connection string.
    const log = vi.fn();
    const report = await liveness(
      async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
      },
      { now: () => AT, log },
    );

    expect(report).toEqual({ status: 'error', checkedAt: AT });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('stamps a real timestamp and logs to the console by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const report = await liveness(async () => {
      throw new Error('down');
    });
    expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
