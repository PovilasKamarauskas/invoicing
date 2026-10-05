import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApplication, validateRuntime } from './runtime-config';

async function bootstrap() {
  validateRuntime();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApplication(app);
  app.enableShutdownHooks();
  await app.listen(3000);
}
void bootstrap();
