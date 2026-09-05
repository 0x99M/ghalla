import { describe, expect, it } from 'vitest';
import { DATA_SOURCE_VAR, dataSource, usingFixtures } from '../src/lib/data/source';

describe('dataSource', () => {
  it('defaults to live when the variable is absent', () => {
    // The asymmetry is the point: an unset variable in production must produce
    // an error about an unreachable database, never a page of invented figures.
    expect(dataSource({})).toBe('live');
    expect(usingFixtures({})).toBe(false);
  });

  it('only accepts the exact word', () => {
    expect(dataSource({ [DATA_SOURCE_VAR]: 'fixtures' })).toBe('fixtures');
    expect(dataSource({ [DATA_SOURCE_VAR]: 'true' })).toBe('live');
    expect(dataSource({ [DATA_SOURCE_VAR]: 'Fixtures' })).toBe('live');
    expect(dataSource({ [DATA_SOURCE_VAR]: '' })).toBe('live');
  });
});
