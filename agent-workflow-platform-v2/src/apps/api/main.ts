import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { getEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const env = getEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, bodyLimit: 2 * 1024 * 1024 }),
    { bufferLogs: true },
  );
  app.enableShutdownHooks();
  app.setGlobalPrefix('');
  await app.listen(env.PORT, '0.0.0.0');
  logger.info({ port: env.PORT }, 'Agent Workflow V2 API listening');
}

bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'API bootstrap failed');
  process.exitCode = 1;
});
