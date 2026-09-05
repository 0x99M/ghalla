# 0007 — Logging

**Status:** accepted

A log is the only account of what happened that survives the process. In a
system whose output is a merchant's profit figure, "why did this order compute
to that" has to be answerable months later from the record alone — and the same
record must not itself become the leak.

## The package

`pino`, with `nestjs-pino` for the Nest integration and `pino-http` underneath
it for request logging.

- **Not `winston`.** Slower, and its transport model encourages configuring
  formatting per environment — which is precisely the thing that must not vary
  (see below).
- **Not the built-in Nest logger.** It writes human-prose lines to stdout.
  Railway ingests those as opaque strings, so "every 5xx for store X last
  Tuesday" becomes a substring search rather than a query.
- **Not a hand-rolled adapter.** Considered, and rejected on the grounds that
  the tricky part — per-request child loggers propagated through
  `AsyncLocalStorage` so a log line five calls deep still carries its request
  id — is exactly the part worth not writing ourselves. What we DO own is every
  decision that could leak data: `logging/redaction.ts` and
  `logging/log-config.ts` are pure functions with tests on them, and the
  library is left to do the plumbing.

## One format, everywhere

`pino-pretty` is deliberately absent, including in development. Pretty locally
and JSON in production means the format exercised daily is not the format that
has to work during an incident — and the serializers, which is where redaction
actually happens, are the part that differs between them. Structured JSON in
every environment; `LOG_LEVEL` changes the volume, never the shape.

Two smaller choices in the same spirit:

- The level is written as a **word**. pino's default is numeric, and `level: 30`
  is unreadable in a dashboard and unfilterable by anyone who has not memorised
  the table.
- The message field is `message`, not pino's `msg`, because that is the key log
  viewers surface.

Every line carries `service`, `env` and `commit`. Two Railway environments run
the same image, and the commit is what distinguishes a bug that is fixed from
one that is merely deployed somewhere else.

## Redaction is an allowlist problem solved with a denylist

`REDACT_PATHS` covers two categories that fail differently:

- **Credentials** — an access token in a log is a compromised merchant account.
- **PII** — a customer's name, phone, address or email. The brief forbids
  customer PII in the database; a log is the same hazard with none of the
  protections, since it is replicated to a platform we do not control and
  retained on a schedule nobody set deliberately.

The single largest carrier is the raw webhook body: the platform's full order
payload, names and addresses included. It is kept in `webhook_events` for replay
under a retention schedule. It has no business in a log at all, so `rawPayload`,
`rawBody` and `req.body` are all redacted.

pino's `redact` walks **literal paths** — it does not deep-search — so a new
payload shape needs a new entry. That is a real maintenance cost, accepted
because the alternative is worse: an allowlist would drop the diagnostic fields
that make a log worth keeping in the first place.

**The request serializer is the second line of defence and matters more than the
list.** pino-http's default includes every header, which is how an
`Authorization` token reaches a log despite a redact list — redaction covers the
paths it is told about, and a header nobody named is a header nobody redacted.
Ours emits `id`, `method` and a query-stripped `url`, and nothing else.

## The healthcheck is not logged

Railway polls `/api/v1/health` continuously. Logged, it is well over 99% of the
volume in a quiet environment, which does not merely cost money — it buries the
twenty lines that matter under a hundred thousand that do not. The healthcheck
already reports its state through its status code, which is what the platform
reads. `/api/v1/ping` is suppressed for the same reason.

A 4xx logs at `warn` and a 5xx at `error`. Conflating them means either alerting
on someone else's malformed request or failing to alert on our own failure.

## Correlation

`x-request-id` is honoured when the edge already set one, so a line in our logs
can be joined to Railway's own record of the same request; otherwise one is
minted. `x-correlation-id` is accepted as a second choice.

## Verified, not assumed

Booted locally against the staging database, and confirmed from the actual
output that: five healthchecks produced zero log lines; a request carrying
`Authorization: Bearer …`, a phone number and an email logged none of the three;
the upstream request id appeared on the line; and a 404 came out at `warn`.

Running it also found a bug that every unit test had passed: `HealthService`
took its migrations folder as a defaulted constructor parameter, and a default
value does not make a parameter optional to Nest — it reads the emitted
`design:paramtypes`, sees `String`, and refuses to boot. The service worked in
tests and died in the container. It takes an injection token now.
