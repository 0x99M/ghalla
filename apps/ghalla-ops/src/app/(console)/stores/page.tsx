import { getStoreList } from '../../../lib/data';
import { usingFixtures } from '../../../lib/data/source';
import { parseFixtureFlags } from '../../../lib/fixtures/flags';
import { parseStoreQuery } from '../../../lib/api/params';
import { applyStoreView, filterByIdentifier, isStoreView, savedViewCounts } from '../../../lib/ui/presentation';
import { PageMeta } from '../../_components/shell/page-meta';
import { FilterBar } from '../../_components/stores/filter-bar';
import { StoreTable } from '../../_components/stores/store-table';
import { Card, CardHeader } from '../../_components/ui/primitives';
import { NoStores, SectionError } from '../../_components/ui/states';

export const dynamic = 'force-dynamic';

/**
 * Every merchant, filterable.
 *
 * The query parameters go through `parseStoreQuery` — the SAME zod schema the
 * API route uses — rather than being read off `searchParams` by hand. A page
 * that parsed its own filters would be a second definition of what `?status=`
 * means, and the two would drift on the first change.
 */
export default async function StoresPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const flags = parseFixtureFlags(raw, usingFixtures(process.env));
  const now = new Date();

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') params.set(key, value);
  }
  const parsed = parseStoreQuery(params);

  if (!parsed.ok) {
    return (
      <SectionError
        title="That filter is not valid"
        error={parsed.issues.join(' · ')}
        at={now.toISOString()}
      />
    );
  }

  // 200 is the API's own cap. Above that the table pages, and the saved-view
  // chips below narrow the loaded rows rather than the whole set — stated on
  // the chips themselves rather than left for somebody to discover.
  const result = await getStoreList({ ...parsed.value, limit: 200, cursor: 0 }, flags);

  const view = typeof raw['view'] === 'string' && isStoreView(raw['view']) ? raw['view'] : null;
  const q = typeof raw['q'] === 'string' ? raw['q'] : '';
  const narrowed = applyStoreView(filterByIdentifier(result.stores, q), view);
  const platforms = [...new Set(result.stores.map((store) => store.platform))].sort();

  return (
    <>
      <PageMeta capturedAt={result.capturedAt} partial={result.partial} />

      {result.partial ? (
        <SectionError
          title="Some platforms could not be read"
          error={result.missing.map((entry) => `${entry.platform}: ${entry.reason}`).join(' · ')}
          at={result.capturedAt}
        />
      ) : null}

      <FilterBar
        platforms={platforms}
        counts={savedViewCounts(result.stores)}
        showing={narrowed.length}
        total={result.total}
      />

      {narrowed.length === 0 ? (
        <Card>
          <CardHeader title="Stores" />
          {result.total === 0 ? (
            <NoStores />
          ) : (
            <p className="px-[14px] py-[26px] text-cell-lg text-muted">
              No stores match these filters. {result.total} exist in total.
            </p>
          )}
        </Card>
      ) : (
        <StoreTable stores={narrowed} now={now} />
      )}
    </>
  );
}
