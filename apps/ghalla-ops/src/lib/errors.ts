/**
 * Turning a thrown thing into a sentence an operator can act on.
 *
 * This exists because of one concrete failure. Drizzle wraps a driver error as
 * `Failed query: select 1\nparams:` and keeps the real one on `cause` — so a
 * portal whose database is refusing connections reported "Failed query", which
 * says nothing at all, while the underlying `ECONNREFUSED` sat one property
 * away. The whole argument for this portal is knowing what broke at 03:00, and
 * a wrapper that hides the answer is the opposite of that.
 *
 * The wrapper is kept rather than replaced: it says which query, and the cause
 * says what happened to it. Both are worth reading.
 */

/** How many links of a `cause` chain to follow. Deep enough for a driver behind an ORM. */
const MAX_DEPTH = 4;

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_DEPTH && current instanceof Error; depth += 1) {
    // Trailing punctuation trimmed as well as whitespace: Drizzle's wrapper
    // ends in `params:`, which joined to its cause reads `params:: connect …`.
    const message = current.message.trim().replace(/[\s:]+$/u, '');
    // A wrapper with nothing to say is skipped rather than rendered as an empty
    // segment, and a cause that merely repeats its wrapper is not said twice.
    if (message !== '' && !parts.includes(message)) parts.push(message);
    current = current.cause;
  }

  return parts.length === 0 ? error.name : parts.join(': ');
}
