/**
 * The mechanism that makes declaring every canonical type twice safe.
 *
 * `@ghalla/contracts` must have zero runtime dependencies, so the hand-written
 * type and the zod schema live in different packages. The price is duplication;
 * these assertions make the duplication a build error instead of a runtime
 * surprise six months later.
 *
 * Mutual assignability rather than strict identity: `readonly` modifiers do not
 * affect assignability, so this checks that the shapes and the value types agree
 * without demanding that zod reproduce every modifier exactly.
 */
export type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Fails to compile unless `T` is exactly `true`. */
export type Expect<T extends true> = T;

/** Reads better at the use site than the raw conditional. */
export type Matches<Schema, Canonical> = MutuallyAssignable<Schema, Canonical>;
