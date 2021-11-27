import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get<ConfigService>(ConfigService);

  app.enableCors({
    origin: config.get('CORS_ORIGIN'),
    credentials: true,
    exposedHeaders: ['Authorization'],
    // exposedHeaders: '*',
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  });
  // app.useGlobalPipes(new ValidationPipe());
  await app.listen(config.get<number>('PORT') || 3000);
}
bootstrap();
