import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readFileSync } from 'fs';

async function bootstrap() {
  const httpsOptions = {
    key: readFileSync('./.cert/key.pem'),
    cert: readFileSync('./.cert/cert.pem'),
  };
  const app = await NestFactory.create(AppModule, { httpsOptions });
  const config = app.get<ConfigService>(ConfigService);
  app.enableCors({
    origin: [
      config.get('CORS_ORIGIN'),
      config.get('CORS_ORIGIN2'),
      config.get('CORS_ORIGIN3'),
    ],
    credentials: true,
    exposedHeaders: ['Authorization'],
    // exposedHeaders: '*',
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  });
  // app.useGlobalPipes(new ValidationPipe());
  await app.listen(config.get<number>('PORT') || 3000);
}
bootstrap();
