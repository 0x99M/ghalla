import { Module } from '@nestjs/common';
import { defaultMigrationsFolder } from '@ghalla/persistence';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { MIGRATIONS_FOLDER } from './migrations-folder.js';

@Module({
  controllers: [HealthController],
  providers: [
    HealthService,
    // A token rather than a defaulted constructor parameter. A default value on
    // an @Injectable's constructor does not make the parameter optional to
    // Nest — it reads the emitted `design:paramtypes`, sees `String`, and fails
    // to boot looking for a provider for it. The service came up in tests and
    // died in the container, which is the worst place to find out.
    { provide: MIGRATIONS_FOLDER, useFactory: (): string => defaultMigrationsFolder() },
  ],
})
export class HealthModule {}
