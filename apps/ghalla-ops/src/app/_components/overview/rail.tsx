import type { Overview } from '../../../lib/queries/overview';
import type { PlatformStore } from '../../../lib/queries/stores';
import { activationFunnel } from '../../../lib/ui/presentation';
import { NO_VALUE, count, minorToRiyals } from '../../../lib/ui/format';
import { Bar, Card, CardBody, CardHeader, Figure } from '../ui/primitives';

/**
 * The revenue card, in the one place the console inverts its palette.
 *
 * The indigo ground is spent here and nowhere else, because this is the only
 * figure on the screen that is not about something being broken. Muted text on
 * it is `--color-accent-muted`, which is the 4.5:1 floor ON indigo — the white
 * ground's muted colour would fail there.
 *
 * There is no delta chip. A month-over-month change needs a previous month, and
 * integration databases hold only the present; the snapshot job brings it.
 * Drawing a `+0%` would be an invented number in the largest type on the page.
 */
export function MrrCard({ report }: { readonly report: Overview }) {
  const { totals } = report;

  return (
    <Card tone="accent">
      <CardHeader title="List MRR" meta="SAR, ex-VAT" tone="accent" />
      <CardBody className="flex flex-col gap-3">
        <div>
          <Figure size="hero">{minorToRiyals(totals.listMrrMinor)}</Figure>
          <p className="mt-1 text-meta text-accent-muted">
            {minorToRiyals(totals.listArrMinor)} annualised · list price, before discounts and collection
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 border-t border-accent-line pt-3">
          {[
            ['Paid', totals.active],
            ['Trialing', totals.trialing],
            ['Past due', totals.pastDue],
          ].map(([label, value]) => (
            <div key={label as string}>
              <div className="text-kicker font-bold tracking-caps uppercase text-accent-muted">{label}</div>
              <div className="mt-[3px] text-figure-sm font-extrabold tracking-figure">{count(value as number)}</div>
            </div>
          ))}
        </div>

        {totals.unknownPlanSubscriptions > 0 ? (
          <p className="rounded-chip-lg bg-bad-on-accent/20 px-2 py-[6px] text-meta text-bad-on-accent">
            {count(totals.unknownPlanSubscriptions)} subscriptions are on a plan code this build does not know
            and are excluded from the total.
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

/**
 * Installed → Backfill complete → Cost data entered → Activated → Paid.
 *
 * `Activated` renders as "not measured" rather than zero. It depends on whether
 * the merchant has ever opened their dashboard, no integration records that,
 * and `Activation.activated` is `null` for every store because of it. A zero
 * there would draw a wall at the end of the funnel and send somebody hunting a
 * product problem that does not exist.
 */
export function ActivationFunnel({ stores }: { readonly stores: readonly PlatformStore[] }) {
  const steps = activationFunnel(stores);

  return (
    <Card>
      <CardHeader title="Activation" meta="all stores" />
      <CardBody className="flex flex-col gap-[10px]">
        {steps.map((step) => (
          <div key={step.step}>
            <div className="flex items-baseline justify-between gap-2 text-cell-lg">
              <span className="text-muted">{step.step}</span>
              <span className="flex items-baseline gap-2">
                <span className="font-bold">{step.count === null ? NO_VALUE : count(step.count)}</span>
                <span className={`text-meta ${step.drop !== null && step.drop <= -20 ? 'text-bad' : 'text-muted'}`}>
                  {step.drop === null ? (step.count === null ? 'not measured' : NO_VALUE) : `${String(step.drop)}%`}
                </span>
              </span>
            </div>
            <Bar
              className="mt-[5px]"
              width={step.share === null ? '0%' : `${String(step.share)}%`}
              tone={step.drop !== null && step.drop <= -20 ? 'bad' : 'neutral'}
            />
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
