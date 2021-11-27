import { Injectable } from '@nestjs/common';
import mediasoup from 'mediasoup';
import { Socket } from 'socket.io';
import { DefaultEventsMap } from 'socket.io/dist/typed-events';

@Injectable()
export class MediasoupService {}
