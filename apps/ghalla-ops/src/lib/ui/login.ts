/**
 * What the login screen says when the key was not accepted, and how loudly.
 *
 * Two codes reach the page, both from the login route's redirect. They live
 * here as a lookup rather than as free text in the page because the copy is a
 * decision: it must never distinguish a wrong key from an expired session,
 * since there is one key and nothing to distinguish — and a decision belongs
 * where a test can hold it still.
 *
 * `throttled` reads as WARN rather than BAD on purpose. The operator has not
 * got anything wrong yet; the limiter is refusing to look. Painting "wait a
 * minute" in the danger colour teaches them that red means nothing.
 *
 * An unknown code renders no notice at all, so an arbitrary `?error=` in the
 * URL cannot put words on the screen. A `Map` rather than an object, so that
 * `?error=constructor` finds nothing rather than `Object`.
 */
export interface LoginNotice {
  readonly tone: 'bad' | 'warn';
  readonly message: string;
}

const NOTICES: ReadonlyMap<string, LoginNotice> = new Map([
  ['invalid', { tone: 'bad', message: 'That key was not accepted.' }],
  ['throttled', { tone: 'warn', message: 'Too many failed attempts. Wait a minute and try again.' }],
]);

export function loginNotice(code: string | readonly string[] | undefined): LoginNotice | null {
  if (typeof code !== 'string') return null;
  return NOTICES.get(code) ?? null;
}
