import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Options } from 'pino-http';
import type { Env } from '../config/env.js';
import { REDACT_CENSOR, REDACT_PATHS, levelForStatus, shouldLogRequest } from './redaction.js';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The level, resolved once.
 *
 * An unrecognized value falls back rather than throwing: a typo'd LOG_LEVEL
 * should not be the reason a service will not boot, and pino would otherwise
 * reject it at construction — after the process has already reported healthy
 * enough to receive traffic.
 */
export function resolveLevel(raw: string | undefined, nodeEnv: Env['nodeEnv']): LogLevel {
  const candidate = raw?.toLowerCase().trim();
  if (candidate !== undefined && (LOG_LEVELS as readonly string[]).includes(candidate)) {
    return candidate as LogLevel;
  }
  // Quiet in tests, verbose while developing, and `info` everywhere a merchant's
  // data actually is — `debug` in production is how a payload ends up in a log.
  if (nodeEnv === 'test') return 'silent';
  if (nodeEnv === 'development') return 'debug';
  return 'info';
}

/**
 * The request id, honoured from upstream when there is one.
 *
 * Railway's edge sets `x-request-id`, and reusing it is what lets a line in our
 * logs be joined to the platform's own record of the same request. Minting a
 * fresh one when there is not is what makes the correlation work at all.
 */
export function resolveRequestId(headers: IncomingMessage['headers']): string {
  const candidates = [headers['x-request-id'], headers['x-correlation-id']];
  for (const value of candidates) {
    const single = Array.isArray(value) ? value[0] : value;
    if (typeof single === 'string' && single !== '') return single;
  }
  return randomUUID();
}

/**
 * Structured JSON, always — including in development.
 *
 * `pino-pretty` is deliberately absent. Pretty logs locally and JSON in
 * production means the format that gets exercised daily is not the format that
 * has to work during an incident, and the serializers where PII redaction
 * actually happens are the part that differs. One format, everywhere.
 *
 * The return type is pino-http's own `Options` rather than a shape described
 * here. Describing it separately meant this file could drift from what the
 * library actually accepts and still compile — the interface would be checked
 * against itself.
 */
export function buildLoggerOptions(env: Env): Options {
  return {
    level: resolveLevel(env.logLevel, env.nodeEnv),
    // On every line, so a log search can be scoped without joining anything.
    // Two Railway environments run the same image; the commit is what tells
    // apart a bug that is fixed from one that is merely deployed elsewhere.
    base: {
      service: 'ghalla-salla',
      env: env.railwayEnvironment ?? env.nodeEnv,
      commit: env.gitSha?.slice(0, 7),
    },
    // Copied because pino's type wants a mutable array. The exported constant
    // stays readonly so the list itself cannot be edited at a distance.
    redact: { paths: [...REDACT_PATHS], censor: REDACT_CENSOR },
    // `message` rather than pino's default `msg`: Railway's log viewer surfaces
    // it, and so does every other tool we might move to.
    messageKey: 'message',
    // A string, not pino's numeric level. `level: 30` is unreadable in a
    // dashboard and unfilterable by anyone who has not memorised the table.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    genReqId: (req) => resolveRequestId(req.headers),
    autoLogging: { ignore: (req) => !shouldLogRequest(req.url) },
    customLogLevel: (_req, res, error) => (error ? 'error' : levelForStatus(res.statusCode)),
    serializers: {
      // Deliberately narrow. pino-http's default request serializer includes
      // every header, which is where an Authorization token reaches a log
      // despite the redact list — redaction covers the paths it is told about,
      // and a header we never named is a header we never redacted.
      req: (req: { id?: string; method?: string; url?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url?.split('?')[0],
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
  };
}
