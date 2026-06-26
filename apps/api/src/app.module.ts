import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { SecurityMonitoringModule } from './security-monitoring/security-monitoring.module';

// In the OCI image the api serves the built dashboard too (one service, same origin → no proxy).
// ANYSENTRY_WEB_DIR points at apps/web/dist; absent in dev (rsbuild serves the web) → no-op.
const webDir = process.env.ANYSENTRY_WEB_DIR || join(__dirname, '..', '..', 'web', 'dist');

@Module({
  imports: [
    ServeStaticModule.forRoot({ rootPath: webDir, exclude: ['/security-center/(.*)'] }),
    SecurityMonitoringModule,
  ],
})
export class AppModule {}
