import type { Parsed } from './params';

/**
 * The response shapes, so every route answers the same way.
 *
 * Two properties are deliberate. Errors are always `{ error, issues }` and
 * never a bare string, because a client that has to sniff the body to tell an
 * error from data will eventually get it wrong on the one response that
 * matters. And nothing here caches: `Cache-Control: no-store` on every route,
 * because an operator refreshing a page during an incident must not be served
 * whatever a proxy decided to keep.
 */

const HEADERS = { 'cache-control': 'no-store' } as const;

export function ok<T>(payload: T): Response {
  return Response.json(payload, { status: 200, headers: HEADERS });
}

export function badRequest(issues: readonly string[]): Response {
  return Response.json({ error: 'bad_request', issues }, { status: 400, headers: HEADERS });
}

export function notFound(what: string): Response {
  return Response.json({ error: 'not_found', issues: [what] }, { status: 404, headers: HEADERS });
}

/**
 * The whole shape of a read route: parse, then delegate.
 *
 * Written as a helper rather than repeated in eight files so that "a route
 * holds no logic" stays true by construction — there is nowhere in a route to
 * put an `if`.
 */
export async function withParsed<T>(
  parsed: Parsed<T>,
  handle: (value: T) => Promise<Response>,
): Promise<Response> {
  return parsed.ok ? handle(parsed.value) : badRequest(parsed.issues);
}
