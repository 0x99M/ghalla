import type { ReactNode } from 'react';
import { cn } from '../../../lib/ui/cn';

/**
 * The console's shared surfaces and marks.
 *
 * Presentational only — no decisions, no data access, no formatting rules.
 * Everything that could be WRONG lives in `lib/ui`; what is here is how it
 * looks. That split is what keeps the coverage gate meaningful when the app
 * directory is excluded from it.
 */

export type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent';

// ------------------------------------------------------------------ card --

export function Card({
  children,
  className,
  tone = 'neutral',
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly tone?: 'neutral' | 'accent' | 'danger';
}) {
  return (
    <section
      className={cn(
        'rounded-card shadow-card',
        tone === 'accent' && 'bg-accent-surface text-accent-ink',
        tone === 'danger' && 'border border-bad-fill bg-bad-row',
        tone === 'neutral' && 'border border-line bg-surface',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  meta,
  action,
  tone = 'neutral',
}: {
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly action?: ReactNode;
  readonly tone?: 'neutral' | 'accent';
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b px-[14px] py-[11px]',
        tone === 'accent' ? 'border-accent-line' : 'border-line',
      )}
    >
      <h2 className="text-title font-extrabold">{title}</h2>
      {meta === undefined ? null : (
        <span className={cn('text-meta', tone === 'accent' ? 'text-accent-muted' : 'text-muted')}>{meta}</span>
      )}
      {action === undefined ? null : <div className="ml-auto flex items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return <div className={cn('p-[14px]', className)}>{children}</div>;
}

// ------------------------------------------------------------------ chip --

const CHIP_TONES: Readonly<Record<Tone, string>> = {
  neutral: 'bg-subtle text-muted',
  ok: 'bg-ok-fill text-ok',
  warn: 'bg-warn-fill text-warn',
  bad: 'bg-bad-fill text-bad',
  info: 'bg-info-fill text-info',
  accent: 'bg-accent-muted text-primary-deep',
};

/** Uppercase status marks: LIVE, DEGRADED, PAST DUE, PHASE 2. */
export function Chip({
  children,
  tone = 'neutral',
  className,
}: {
  readonly children: ReactNode;
  readonly tone?: Tone;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-chip px-[6px] py-[2px] text-chip font-extrabold tracking-chip uppercase',
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const DOT_TONES: Readonly<Record<Tone, string>> = {
  neutral: 'bg-faint shadow-[0_0_0_3px_var(--color-subtle)]',
  ok: 'bg-ok-dot shadow-[0_0_0_3px_var(--color-ok-fill)]',
  warn: 'bg-warn-dot shadow-[0_0_0_3px_var(--color-warn-fill)]',
  bad: 'bg-bad-dot shadow-[0_0_0_3px_var(--color-bad-fill)]',
  info: 'bg-primary shadow-[0_0_0_3px_var(--color-primary-tint)]',
  accent: 'bg-accent-ink shadow-[0_0_0_3px_var(--color-accent-line)]',
};

/** A 7px dot with a 3px halo. Never the only signal — always beside a word. */
export function StatusDot({ tone = 'neutral' }: { readonly tone?: Tone }) {
  return <span aria-hidden className={cn('inline-block size-[7px] shrink-0 rounded-full', DOT_TONES[tone])} />;
}

// ------------------------------------------------------------------- type --

export function Kicker({ children, className }: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={cn('text-kicker font-bold tracking-caps uppercase text-muted', className)}>{children}</div>
  );
}

export function Figure({
  children,
  size = 'md',
  className,
}: {
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md' | 'lg' | 'hero';
  readonly className?: string;
}) {
  return (
    <div
      className={cn(
        'font-extrabold tracking-figure',
        size === 'sm' && 'text-figure-sm',
        size === 'md' && 'text-figure',
        size === 'lg' && 'text-figure-xl',
        size === 'hero' && 'text-hero tracking-figure-tight',
        className,
      )}
    >
      {children}
    </div>
  );
}

// -------------------------------------------------------------------- bar --

const FILL_TONES: Readonly<Record<Tone, string>> = {
  neutral: 'bg-ink',
  ok: 'bg-ok-dot',
  warn: 'bg-warn-dot',
  bad: 'bg-bad-dot',
  info: 'bg-primary',
  accent: 'bg-accent-ink',
};

/**
 * A track with a fill. The width is CLAMPED by the caller, never here.
 *
 * A store at 112% of its cap must read `112%` in text — that number is why
 * somebody opened the row — while the bar stops at the end of its track,
 * because a 112%-wide fill overflows and reads as a rendering fault rather than
 * an overage.
 */
export function Bar({
  width,
  tone = 'neutral',
  className,
  height = 7,
}: {
  readonly width: string;
  readonly tone?: Tone;
  readonly className?: string;
  readonly height?: number;
}) {
  return (
    <div
      aria-hidden
      className={cn('overflow-hidden rounded-full bg-track', className)}
      style={{ height: `${String(height)}px` }}
    >
      <div className={cn('h-full rounded-full', FILL_TONES[tone])} style={{ width }} />
    </div>
  );
}

// ---------------------------------------------------------------- layout --

export function Row({
  label,
  value,
  className,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-3 text-cell-lg', className)}>
      <span className="text-muted">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  );
}

export function Divider({ className }: { readonly className?: string }) {
  return <div className={cn('border-t border-line', className)} />;
}
