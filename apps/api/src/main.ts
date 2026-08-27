import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { deploymentBasePath } from './deployment-base-path';
import { ApiResponseInterceptor } from './shared/api-response.interceptor';
import { PlatformMetricsInterceptor, PlatformMetricsService } from './security-monitoring/platform-metrics.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const publicBasePath = deploymentBasePath();
  if (publicBasePath) {
    app.use((req: { url?: string }, _res: unknown, next: () => void) => {
      if (req.url === `${publicBasePath}/security-center` || req.url?.startsWith(`${publicBasePath}/security-center/`)) {
        req.url = req.url.slice(publicBasePath.length) || '/';
      }
      next();
    });
  }
  app.enableCors();
  // Kubernetes sends SIGTERM during rollouts. Opt in so async provider teardown can drain the
  // bounded ClickHouse event buffer before the pod's termination grace period expires.
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  app.use([
    '/security-center/ingest/batch',
    '/security-center/runtime/snapshot',
  ], json({
    type: ['application/json', 'application/*+json'],
    // Observer batches and runtime snapshots are bounded by their controllers, but regularly
    // exceed Express' 100 KiB default. Keep a route-scoped ceiling instead of widening every API.
    limit: process.env.ANYSENTRY_OBSERVER_BODY_LIMIT || '4mb',
  }));
  app.use('/security-center/supply-chain/tasks', json({
    type: ['application/json', 'application/*+json'],
    limit: process.env.ANYSENTRY_WORKSPACE_SCAN_BODY_LIMIT || '32mb',
  }));
  app.use(json({ type: ['application/json', 'application/*+json'] }));
  app.useGlobalInterceptors(
    new PlatformMetricsInterceptor(app.get(PlatformMetricsService)),
    new ApiResponseInterceptor(app.get(Reflector)),
  );
  const port = Number(process.env.PORT ?? 29653);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`AnySentry api listening on http://0.0.0.0:${port}`);
}

void bootstrap();
