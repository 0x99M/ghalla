'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { cn } from '../../../lib/ui/cn';

/**
 * The only place this console can change anything, and it is quarantined.
 *
 * Red ground, red border, its own corner of the page, below everything that is
 * merely information. That separation is the design's, and it is right: every
 * other pixel on this screen is a read, and an operator scrolling fast should
 * never be one misplaced click away from re-running a backfill.
 *
 * Actions dispatch to the integration's own authenticated admin API, never to
 * its database — the portal holds a read-only Postgres role and could not write
 * even if this code tried.
 */

export interface ActionDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The exact operation, shown in mono in the dialog. Never paraphrased. */
  readonly target: string;
}

export function OperatorActions({
  actions,
  available,
  unavailableReason,
}: {
  readonly actions: readonly ActionDescriptor[];
  readonly available: boolean;
  readonly unavailableReason: string;
}) {
  const [confirming, setConfirming] = useState<ActionDescriptor | null>(null);

  return (
    <section className="rounded-card border border-bad-fill bg-bad-row shadow-card">
      <div className="flex items-center gap-3 border-b border-bad-fill px-[14px] py-[11px]">
        <h2 className="text-title font-extrabold text-bad">Operator actions</h2>
        <span className="text-meta text-muted">writes to production</span>
      </div>

      <div className="grid grid-cols-2 gap-2 p-[14px]">
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => {
              setConfirming(action);
            }}
            className="cursor-pointer rounded-pill-lg border border-bad-fill bg-surface px-[11px] py-[9px] text-left transition-colors hover:border-bad-dot"
          >
            <span className="block text-cell-lg font-bold text-ink">{action.label}</span>
            <span className="mt-[2px] block text-meta text-muted">{action.description}</span>
          </button>
        ))}
      </div>

      {available ? null : (
        <p className="border-t border-bad-fill px-[14px] py-[9px] text-meta text-muted">{unavailableReason}</p>
      )}

      <ConfirmDialog
        action={confirming}
        available={available}
        unavailableReason={unavailableReason}
        onClose={() => {
          setConfirming(null);
        }}
      />
    </section>
  );
}

/**
 * The confirmation, with the target line in mono and the consequence in words.
 *
 * The mono line is the whole reason this dialog exists rather than a
 * `window.confirm`. An operator confirms "Re-run backfill" without reading it;
 * they do not confirm `POST /admin/backfill/restart · salla:1305146709 ·
 * resource=orders` without reading it, because the identifier is the thing they
 * came here to check.
 */
function ConfirmDialog({
  action,
  available,
  unavailableReason,
  onClose,
}: {
  readonly action: ActionDescriptor | null;
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/72" />
        <Dialog.Content
          className={cn(
            'fixed top-1/2 left-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2',
            'rounded-card bg-surface shadow-modal motion-safe:animate-fadein',
          )}
        >
          <div className="border-b border-line px-[16px] py-[13px]">
            <Dialog.Title className="text-section font-extrabold">{action?.label ?? ''}</Dialog.Title>
          </div>

          <div className="flex flex-col gap-3 px-[16px] py-[14px]">
            <Dialog.Description className="text-cell-lg text-muted">
              {action?.description ?? ''}
            </Dialog.Description>

            <p className="rounded-chip-lg border border-line bg-subtle px-[10px] py-2 font-mono text-meta break-all">
              {action?.target ?? ''}
            </p>

            <p className="text-meta-lg font-semibold text-bad">
              This hits production and cannot be undone from this console.
            </p>

            {available ? null : <p className="text-meta text-muted">{unavailableReason}</p>}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-[16px] py-[11px]">
            <Dialog.Close className="cursor-pointer rounded-pill-lg border border-line px-[13px] py-[7px] text-cell-lg font-semibold text-muted hover:text-ink">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              disabled={!available}
              className="cursor-pointer rounded-pill-lg bg-bad-badge px-[13px] py-[7px] text-cell-lg font-bold text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              {action?.label ?? 'Confirm'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
