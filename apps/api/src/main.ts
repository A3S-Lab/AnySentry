import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { deploymentBasePath } from './deployment-base-path';
import { ApiResponseInterceptor } from './shared/api-response.interceptor';
import { HttpShutdown, shutdownCoordinator } from './shared/http-shutdown';
import { PlatformMetricsInterceptor, PlatformMetricsService } from './security-monitoring/platform-metrics.service';
import { buildInfo } from './shared/build-info';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const shutdown = new HttpShutdown();
  // Before parsers and controllers: rejected requests have performed no application writes.
  app.use(shutdown.middleware);
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
  // app.close() still invokes Nest lifecycle hooks. Do not register Nest signal listeners too:
  // those would start tearing down storage concurrently with the HTTP drain.
  const stop = shutdownCoordinator({
    gate: shutdown,
    close: () => app.close(),
    exit: code => process.exit(code),
  });
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });
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
  app.use([
    '/security-center/interactions/ingest',
    '/security-center/interactions/ingest-content',
  ], json({
    type: ['application/json', 'application/*+json'],
    // Runtime plaintext is encrypted by the Observer before this hop, but the envelope can still
    // exceed Express' 100 KiB default (base64 alone adds roughly one third). Keep this scoped to
    // the protected Interaction endpoints and preserve the small global limit for public APIs.
    limit:
      process.env.ANYSENTRY_INTERACTION_BODY_LIMIT
      || process.env.ANYSENTRY_OBSERVER_BODY_LIMIT
      || '4mb',
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
    shutdown,
    new PlatformMetricsInterceptor(app.get(PlatformMetricsService)),
    new ApiResponseInterceptor(app.get(Reflector)),
  );
  const port = Number(process.env.PORT ?? 29653);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  const identity = buildInfo();
  console.log(`AnySentry api listening on http://0.0.0.0:${port} (version=${identity.version} commit=${identity.commit})`);
}

void bootstrap();
