import 'reflect-metadata';
import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiResponseInterceptor } from './shared/api-response.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.useGlobalInterceptors(new ApiResponseInterceptor(app.get(Reflector)));
  const port = Number(process.env.PORT ?? 29653);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`AnySentry api listening on http://0.0.0.0:${port}`);
}

void bootstrap();
