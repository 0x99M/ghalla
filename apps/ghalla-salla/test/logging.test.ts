import { describe, expect, it } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LOG_LEVELS,
  buildLoggerOptions,
  resolveLevel,
  resolveRequestId,
} from '../src/logging/log-config.js';
import { REDACT_CENSOR, REDACT_PATHS, levelForStatus, shouldLogRequest } from '../src/logging/redaction.js';
import type { Env } from '../src/config/env.js';

const env = (over: Partial<Env> = {}): Env => ({
  nodeEnv: 'staging',
  port: 3000,
  databaseUrl: 'postgres://user:pass@db:5432/ghalla',
  databaseSslMode: undefined,
  databasePoolMax: 10,
  logLevel: undefined,
  railwayEnvironment: 'staging',
  gitSha: 'abcdef1234567',
  ...over,
});

describe('choosing a log level', () => {
  it('takes an explicit level, whatever the environment', () => {
    expect(resolveLevel('warn', 'production')).toBe('warn');
    expect(resolveLevel('trace', 'production')).toBe('trace');
  });

  it('accepts a level however it was typed', () => {
    expect(resolveLevel('  WARN ', 'production')).toBe('warn');
  });

  it('falls back rather than refusing to boot on a typo', () => {
    // pino rejects an unknown level at construction. Throwing here would mean a
    // mistyped environment variable takes the service down, which is a much
    // worse outcome than logging at the default.
    expect(resolveLevel('verbose', 'staging')).toBe('info');
    expect(resolveLevel('', 'staging')).toBe('info');
    expect(resolveLevel(undefined, 'staging')).toBe('info');
  });

  it('is silent under test, chatty in development, and info where the data is', () => {
    // `debug` in production is how a customer payload reaches a log line.
    expect(resolveLevel(undefined, 'test')).toBe('silent');
    expect(resolveLevel(undefined, 'development')).toBe('debug');
    expect(resolveLevel(undefined, 'production')).toBe('info');
  });

  it('offers every level pino understands', () => {
    expect(LOG_LEVELS).toContain('fatal');
    expect(LOG_LEVELS).toContain('silent');
  });
});

describe('correlating a request', () => {
  it('honours an id the edge already assigned', () => {
    // Railway sets x-request-id. Reusing it is what lets our line be joined to
    // the platform's own record of the same request.
    expect(resolveRequestId({ 'x-request-id': 'edge-1' })).toBe('edge-1');
  });

  it('accepts the correlation header as a second choice', () => {
    expect(resolveRequestId({ 'x-correlation-id': 'corr-1' })).toBe('corr-1');
  });

  it('takes the first value when a header arrives repeated', () => {
    expect(resolveRequestId({ 'x-request-id': ['first', 'second'] })).toBe('first');
  });

  it('skips an empty header rather than correlating everything to ""', () => {
    expect(resolveRequestId({ 'x-request-id': '', 'x-correlation-id': 'corr-2' })).toBe('corr-2');
  });

  it('mints one when there is none, so correlation always works', () => {
    const id = resolveRequestId({});
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId({})).not.toBe(id);
  });

  it('ignores a repeated header with no values in it', () => {
    expect(resolveRequestId({ 'x-request-id': [] })).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('what never reaches a log', () => {
  it('redacts credentials, whose leak ends an integration', () => {
    for (const path of ['req.headers.authorization', 'accessToken', '*.refreshToken', 'password']) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('redacts customer PII, whose leak is a regulatory matter', () => {
    // The brief forbids customer PII in the database. A log is the same hazard
    // with none of the protections.
    for (const path of ['rawPayload', 'rawBody', 'req.body', '*.customer', 'phone', 'email']) {
      expect(REDACT_PATHS).toContain(path);
    }
  });

  it('replaces the value instead of dropping the key', () => {
    // So a reader can tell a redacted field from a field that was never there.
    expect(REDACT_CENSOR).toBe('[redacted]');
  });
});

describe('which requests are worth logging', () => {
  it('drops the healthcheck, which is almost all the volume', () => {
    // Railway polls continuously. Logged, it buries the twenty lines that
    // matter under a hundred thousand that do not.
    expect(shouldLogRequest('/api/v1/health')).toBe(false);
    expect(shouldLogRequest('/api/v1/ping')).toBe(false);
  });

  it('drops it even with a cache-buster on the end', () => {
    expect(shouldLogRequest('/api/v1/health?t=123')).toBe(false);
  });

  it('keeps everything else', () => {
    expect(shouldLogRequest('/api/v1/orders')).toBe(true);
    expect(shouldLogRequest('/api/v1/healthy-looking-but-not')).toBe(true);
  });

  it('keeps a request whose url is missing rather than silently dropping it', () => {
    expect(shouldLogRequest(undefined)).toBe(true);
    expect(shouldLogRequest('')).toBe(true);
  });
});

describe('how a status becomes a level', () => {
  it('separates our failures from the caller’s mistakes', () => {
    // Conflating them means alerting on someone else's malformed request, or
    // not alerting on our own 500.
    expect(levelForStatus(500)).toBe('error');
    expect(levelForStatus(503)).toBe('error');
    expect(levelForStatus(404)).toBe('warn');
    expect(levelForStatus(422)).toBe('warn');
    expect(levelForStatus(200)).toBe('info');
    expect(levelForStatus(304)).toBe('info');
  });

  it('assumes nothing when there is no status yet', () => {
    expect(levelForStatus(undefined)).toBe('info');
  });
});

describe('the assembled pino options', () => {
  const options = buildLoggerOptions(env());

  it('stamps the service, environment and commit on every line', () => {
    // So a log search can be scoped without joining anything, and so two
    // environments running the same image are tellable apart.
    expect(options.base).toStrictEqual({
      service: 'ghalla-salla',
      env: 'staging',
      commit: 'abcdef1',
    });
  });

  it('falls back to NODE_ENV when the platform names no environment', () => {
    const local = buildLoggerOptions(env({ railwayEnvironment: undefined, nodeEnv: 'development' }));
    expect((local.base as { env: string }).env).toBe('development');
  });

  it('leaves the commit undefined rather than inventing one', () => {
    const local = buildLoggerOptions(env({ gitSha: undefined }));
    expect((local.base as { commit: string | undefined }).commit).toBeUndefined();
  });

  it('writes the level as a word, not pino’s number', () => {
    // `level: 30` is unreadable in a dashboard and unfilterable by anyone who
    // has not memorised the table.
    const formatter = options.formatters?.level;
    expect(formatter?.('warn', 40)).toStrictEqual({ level: 'warn' });
  });

  it('writes an ISO timestamp', () => {
    const stamp = (options.timestamp as () => string)();
    expect(stamp).toMatch(/^,"time":"\d{4}-\d{2}-\d{2}T[\d:.]+Z"$/);
  });

  it('carries the redaction list into pino', () => {
    const redact = options.redact as { paths: string[]; censor: string };
    expect(redact.censor).toBe(REDACT_CENSOR);
    expect(redact.paths).toStrictEqual([...REDACT_PATHS]);
    // Copied, so the exported constant cannot be edited through this object.
    expect(redact.paths).not.toBe(REDACT_PATHS);
  });

  it('names the message field so a log viewer surfaces it', () => {
    expect(options.messageKey).toBe('message');
  });

  it('threads the request id through genReqId', () => {
    const id = options.genReqId?.(
      { headers: { 'x-request-id': 'abc' } } as unknown as IncomingMessage,
      {} as ServerResponse,
    );
    expect(id).toBe('abc');
  });

  it('ignores the healthcheck through autoLogging', () => {
    const ignore = (options.autoLogging as { ignore: (req: IncomingMessage) => boolean }).ignore;
    expect(ignore({ url: '/api/v1/health' } as IncomingMessage)).toBe(true);
    expect(ignore({ url: '/api/v1/orders' } as IncomingMessage)).toBe(false);
  });

  it('logs an errored request at error level whatever the status says', () => {
    const level = options.customLogLevel as (
      req: IncomingMessage,
      res: ServerResponse,
      err?: Error,
    ) => string;
    const req = {} as IncomingMessage;
    expect(level(req, { statusCode: 200 } as ServerResponse, new Error('boom'))).toBe('error');
    expect(level(req, { statusCode: 200 } as ServerResponse, undefined)).toBe('info');
    expect(level(req, { statusCode: 404 } as ServerResponse, undefined)).toBe('warn');
  });

  it('serializes a request without its headers at all', () => {
    // pino-http's default serializer includes every header, which is how an
    // Authorization token reaches a log despite the redact list: redaction
    // covers the paths it is told about, and a header we never named is a
    // header we never redacted.
    const serialize = options.serializers?.['req'] as (r: unknown) => Record<string, unknown>;
    const line = serialize({
      id: 'r1',
      method: 'POST',
      url: '/api/v1/orders?secret=1',
      headers: { authorization: 'Bearer nope' },
    });
    expect(line).toStrictEqual({ id: 'r1', method: 'POST', url: '/api/v1/orders' });
    expect(JSON.stringify(line)).not.toContain('nope');
  });

  it('tolerates a request with no url', () => {
    const serialize = options.serializers?.['req'] as (r: unknown) => Record<string, unknown>;
    expect(serialize({ id: 'r2', method: 'GET' })).toStrictEqual({
      id: 'r2',
      method: 'GET',
      url: undefined,
    });
  });

  it('serializes a response down to its status', () => {
    const serialize = options.serializers?.['res'] as (r: unknown) => Record<string, unknown>;
    expect(serialize({ statusCode: 204, getHeaders: () => ({}) })).toStrictEqual({
      statusCode: 204,
    });
  });
});
