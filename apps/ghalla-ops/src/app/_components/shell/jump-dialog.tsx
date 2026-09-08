'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { JUMP_MAX_PAGES, JUMP_PAGE_LIMIT, moveHighlight, rankJump } from '../../../lib/ui/jump';
import { storeHref } from '../../../lib/ui/nav';
import { severityOf } from '../../../lib/ui/presentation';
import type { StoreIdentity } from '../../../lib/ui/presentation';
import type { HealthFlag } from '../../../lib/queries/store-health';
import { count } from '../../../lib/ui/format';
import { cn } from '../../../lib/ui/cn';
import { Chip } from '../ui/primitives';
import { StoreRef } from '../ui/store-ref';

/**
 * "Jump to store": type part of an identifier, pick a row, land on the store.
 *
 * Reads `/api/stores` when it is OPENED and not before — the console's rule
 * that nothing fetches on its own holds here too, and a dialog that pre-loaded
 * every store on every page would be the one exception. The list is kept for
 * the life of the shell after that; reopening does not re-read. The Refresh
 * button in the topbar remounts the shell's server parent, which is the moment
 * a stale list is expected to change.
 *
 * Which rows match, in what order and how many, is decided in `lib/ui/jump`
 * and tested there. This file is the fetch, the keyboard, and the markup.
 *
 * A platform that could not be read is named in the footer rather than
 * silently missing from the results, because "no store matches" and "one of
 * the databases is down" are different facts.
 */

/** The fields a row needs, as `/api/stores` serialises them. */
interface JumpStore extends StoreIdentity {
  readonly ordersInPeriod: number;
  readonly health: { readonly flags: readonly HealthFlag[] };
}

interface JumpPage {
  readonly stores: readonly JumpStore[];
  readonly total: number;
  readonly nextCursor: number | null;
  readonly partial: boolean;
  readonly missing: readonly { readonly platform: string; readonly reason: string }[];
}

type Load =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly error: string }
  | {
      readonly kind: 'ready';
      readonly stores: readonly JumpStore[];
      readonly total: number;
      readonly missing: JumpPage['missing'];
      readonly truncated: boolean;
    };

async function readAllStores(): Promise<Load> {
  const stores: JumpStore[] = [];
  let cursor = 0;
  let pages = 0;
  let total = 0;
  let missing: JumpPage['missing'] = [];

  while (pages < JUMP_MAX_PAGES) {
    const params = new URLSearchParams({ limit: String(JUMP_PAGE_LIMIT), cursor: String(cursor) });
    const response = await fetch(`/api/stores?${params.toString()}`, { credentials: 'same-origin' });
    if (!response.ok) return { kind: 'failed', error: `GET /api/stores answered ${String(response.status)}` };
    const page = (await response.json()) as JumpPage;
    stores.push(...page.stores);
    total = page.total;
    missing = page.missing;
    pages += 1;
    if (page.nextCursor === null) return { kind: 'ready', stores, total, missing, truncated: false };
    cursor = page.nextCursor;
  }
  return { kind: 'ready', stores, total, missing, truncated: true };
}

export function JumpDialog({
  open,
  onOpenChange,
  onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (href: string) => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'idle' });
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const read = useCallback(() => {
    setLoad({ kind: 'loading' });
    readAllStores()
      .then(setLoad)
      .catch((error: unknown) => {
        setLoad({ kind: 'failed', error: error instanceof Error ? error.message : String(error) });
      });
  }, []);

  // A fresh query each time it opens; the list itself is kept. Two effects,
  // because the reset must key on `open` alone: keyed on the load as well, it
  // would wipe what the operator typed while the list was still arriving.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHighlight(-1);
  }, [open]);

  useEffect(() => {
    if (open && load.kind === 'idle') read();
  }, [open, load.kind, read]);

  const rows = load.kind === 'ready' ? rankJump(load.stores, query) : [];

  const pickRow = useCallback(
    (store: StoreIdentity) => {
      onPick(storeHref(store.platform, store.storeId));
    },
    [onPick],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = moveHighlight(highlight, event.key === 'ArrowDown' ? 1 : -1, rows.length);
        setHighlight(next);
        listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        // Enter with nothing highlighted takes the first row: the exact match,
        // when there is one, is ranked to be there.
        const target = rows[highlight] ?? rows[0];
        if (target !== undefined) pickRow(target);
      }
    },
    [highlight, rows, pickRow],
  );

  const listId = 'jump-store-options';
  const activeId = highlight >= 0 && rows[highlight] !== undefined ? `jump-option-${String(highlight)}` : undefined;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/72" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed top-[12vh] left-1/2 z-50 w-[min(520px,calc(100vw-32px))] -translate-x-1/2',
            'overflow-hidden rounded-card bg-surface shadow-modal motion-safe:animate-fadein',
          )}
        >
          <Dialog.Title className="sr-only">Jump to store</Dialog.Title>

          <label className="flex items-center gap-[10px] border-b border-line px-[14px] py-[11px]">
            <Search size={15} strokeWidth={2} aria-hidden className="shrink-0 text-faint" />
            <span className="sr-only">Store id or platform</span>
            <input
              type="search"
              role="combobox"
              aria-expanded={rows.length > 0}
              aria-controls={listId}
              aria-activedescendant={activeId}
              aria-autocomplete="list"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={query}
              placeholder="Store id or platform"
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(-1);
              }}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 bg-transparent font-mono text-cell-lg text-ink outline-none placeholder:text-faint"
            />
          </label>

          {load.kind === 'loading' || load.kind === 'idle' ? (
            <div className="flex flex-col gap-2 p-[10px]" aria-busy role="status">
              <span className="sr-only">Loading stores</span>
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  aria-hidden
                  className="h-[42px] rounded-chip-lg bg-[linear-gradient(90deg,var(--color-subtle)_0%,var(--color-line)_50%,var(--color-subtle)_100%)] bg-[length:320px_100%] motion-safe:animate-shimmer"
                  style={{ opacity: 1 - index * 0.2 }}
                />
              ))}
            </div>
          ) : null}

          {load.kind === 'failed' ? (
            <div className="flex flex-col gap-[10px] p-[14px]">
              <p className="rounded-chip-lg border border-bad-fill bg-bad-row px-[10px] py-2 font-mono text-meta break-words text-bad">
                {load.error}
              </p>
              <button
                type="button"
                onClick={read}
                className="cursor-pointer self-start rounded-pill-lg border border-line px-[13px] py-[7px] text-cell-lg font-semibold text-muted hover:text-ink"
              >
                Try again
              </button>
            </div>
          ) : null}

          {load.kind === 'ready' ? (
            <>
              {rows.length === 0 ? (
                <p className="px-[14px] py-[18px] text-cell-lg text-muted">
                  {load.stores.length === 0 ? 'No stores yet.' : `No store matches “${query.trim()}”.`}
                </p>
              ) : (
                <ul ref={listRef} id={listId} role="listbox" className="max-h-[52vh] overflow-y-auto p-[6px]">
                  {rows.map((store, index) => {
                    const severity = severityOf(store.health.flags);
                    const active = index === highlight;
                    return (
                      <li
                        key={store.storeId}
                        id={`jump-option-${String(index)}`}
                        role="option"
                        aria-selected={active}
                        onMouseEnter={() => {
                          setHighlight(index);
                        }}
                        onMouseDown={(event) => {
                          // Before the input loses focus, so the dialog does not
                          // flicker through a blur before it closes.
                          event.preventDefault();
                          pickRow(store);
                        }}
                        className={cn(
                          'flex cursor-pointer items-center gap-3 rounded-chip-lg px-[10px] py-[7px]',
                          active ? 'bg-primary-tint' : 'hover:bg-subtle',
                        )}
                      >
                        <StoreRef
                          link={false}
                          platform={store.platform}
                          platformStoreId={store.platformStoreId}
                          storeId={store.storeId}
                          className="flex-1"
                        />
                        {severity === 'ok' ? null : (
                          <Chip tone={severity}>{severity === 'bad' ? 'Attention' : 'Check'}</Chip>
                        )}
                        <span className="w-[72px] shrink-0 text-right text-meta text-muted">
                          {count(store.ordersInPeriod)} orders
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}

              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-[14px] py-[8px] text-meta text-muted">
                <span>
                  {count(rows.length)} of {count(load.total)} stores
                </span>
                {load.truncated ? <span>Only the first {count(load.stores.length)} were read.</span> : null}
                {load.missing.map((entry) => (
                  <span key={entry.platform} className="text-bad">
                    {entry.platform} could not be read: {entry.reason}
                  </span>
                ))}
              </div>
            </>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
