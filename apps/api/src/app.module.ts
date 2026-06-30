import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'node:path';
import { deploymentBasePath } from './deployment-base-path';
import { SecurityMonitoringModule } from './security-monitoring/security-monitoring.module';

// In the OCI image the api serves the built dashboard too (one service, same origin → no proxy).
// ANYSENTRY_WEB_DIR points at apps/web/dist; absent in dev (rsbuild serves the web) → no-op.
const webDir = process.env.ANYSENTRY_WEB_DIR || join(__dirname, '..', '..', 'web', 'dist');
const publicBasePath = deploymentBasePath();
const apiExclude = ['/security-center/(.*)', ...(publicBasePath ? [`${publicBasePath}/security-center/(.*)`] : [])];
const webRoots = [
  ...(publicBasePath
    ? [{
        rootPath: webDir,
        serveRoot: publicBasePath,
        renderPath: '*',
        exclude: apiExclude,
      }]
    : []),
  { rootPath: webDir, exclude: apiExclude },
];

@Module({
  imports: [
    ServeStaticModule.forRoot(...webRoots),
    SecurityMonitoringModule,
  ],
})
export class AppModule {}
