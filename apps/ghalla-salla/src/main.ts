import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // Before Nest, so a missing DATABASE_URL kills the process here rather than
  // on the first request that needs it.
  const env = loadEnv();

  // `bufferLogs` holds everything Nest emits during construction until the real
  // logger is attached below. Without it the framework's own startup lines —
  // including whatever it says while FAILING to start — go out through the
  // default console logger, unstructured and without the commit on them, which
  // is precisely the window where you most want both.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Railway stops a container with SIGTERM; without this the pool is never
  // closed and the connections linger until Postgres times them out.
  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');
  // One object, with the text under `message`. Nest's LoggerService signature
  // is `log(message, ...context)`, so passing the text as a SECOND argument
  // files it as the context and leaves the line with no message at all — which
  // is what happened the first time.
  app.get(Logger).log({
    message: 'ghalla-salla listening',
    port: env.port,
    environment: env.railwayEnvironment ?? env.nodeEnv,
    commit: env.gitSha,
  });
}

bootstrap().catch((error: unknown) => {
  // Deliberately `console.error` and not a Nest logger: reaching here usually
  // means the container never came up, so the logger may not exist. A stack
  // trace on stderr is the only thing guaranteed to survive that.
  console.error('Failed to start', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
