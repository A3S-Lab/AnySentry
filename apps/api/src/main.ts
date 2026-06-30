import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module';
import { deploymentBasePath } from './deployment-base-path';
import { ApiResponseInterceptor } from './shared/api-response.interceptor';

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
  app.use(json({ type: ['application/json', 'application/*+json'] }));
  app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
  const port = Number(process.env.PORT ?? 29653);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`AnySentry api listening on http://0.0.0.0:${port}`);
}

void bootstrap();
