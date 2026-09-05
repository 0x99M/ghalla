import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadEnv } from './config/env.js';

async function bootstrap(): Promise<void> {
  // Before Nest, so a missing DATABASE_URL kills the process here rather than
  // on the first request that needs it.
  const env = loadEnv();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Railway stops a container with SIGTERM; without this the pool is never
  // closed and the connections linger until Postgres times them out.
  app.enableShutdownHooks();

  await app.listen(env.port, '0.0.0.0');
  logger.log(
    `ghalla-salla listening on ${String(env.port)} ` +
      `(env=${env.railwayEnvironment ?? env.nodeEnv}, commit=${env.gitSha?.slice(0, 7) ?? 'local'})`,
  );
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error('Failed to start', error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
