import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SocketEventsModule } from './socketEvents/socketEvents.module';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), SocketEventsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
