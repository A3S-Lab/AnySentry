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
    // Observer batches and runtime snapshots are bounded by their controllers, but an admitted
    // inline multimodal model request can be several MiB. Keep the larger ceiling route-scoped
    // instead of widening every API endpoint.
    limit: process.env.ANYSENTRY_OBSERVER_BODY_LIMIT || '16mb',
  }));
  app.use('/security-center/supply-chain/tasks', json({
    type: ['application/json', 'application/*+json'],
    limit: process.env.ANYSENTRY_WORKSPACE_SCAN_BODY_LIMIT || '32mb',
  }));
  app.use(json({ type: ['application/json', 'application/*+json'] }));
  // Body-parser failures happen before a controller can see an Observer batch. Keep a bounded,
  // redacted diagnostic seam so a client timeout/request abort can be matched to Forwarder WAL
  // growth without ever logging the request body or authorization headers.
  app.use((error: {
    type?: string;
    code?: string;
    message?: string;
  }, req: {
    method?: string;
    originalUrl?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
  }, res: {
    headersSent?: boolean;
    status: (code: number) => { json: (body: unknown) => void };
  }, next: (error?: unknown) => void) => {
    const aborted = error?.type === 'request.aborted'
      || error?.code === 'ECONNABORTED'
      || error?.message === 'request aborted';
    if (!aborted) {
      next(error);
      return;
    }
    const headers = req.headers ?? {};
    const contentLength = headers['content-length'];
    const sourceId = headers['x-anysentry-source-id'];
    const batchId = headers['x-anysentry-batch-id'];
    // eslint-disable-next-line no-console
    console.warn('[AnySentry] observer ingest request aborted', {
      method: req.method,
      path: req.originalUrl ?? req.url,
      contentLength: Array.isArray(contentLength) ? contentLength[0] : contentLength,
      sourceId: Array.isArray(sourceId) ? sourceId[0] : sourceId,
      batchId: Array.isArray(batchId) ? batchId[0] : batchId,
      errorType: error.type,
      errorCode: error.code,
    });
    if (res.headersSent) return;
    res.status(400).json({
      code: 400,
      message: 'observer ingest request aborted before batch processing',
      error: 'request_aborted',
    });
  });
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
