import { Module } from '@nestjs/common';
import { SocketEventsGateway } from './socketEvents.gateway';
import { MediasoupService } from './mediasoup.service';

@Module({
  imports: [],
  providers: [SocketEventsGateway, MediasoupService],
})
export class SocketEventsModule {}
