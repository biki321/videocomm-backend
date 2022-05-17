import { types } from 'mediasoup';
import { Socket } from 'socket.io';

export type rooms = {
  // key is roomName
  [key: string]: {
    router: types.Router;
    peers: string[];
    sharedScreen: {
      //if null then no screen shared yet
      socketId: string | null;
    };
    sharedCanvas: {
      //if null then no canvas shared yet
      socketId: string | null;
    };
  };
}; // { roomName1: { Router, rooms: [ socketId1, ... ] }, ...}

export type peers = {
  // key is socketId
  [key: string]: {
    roomName: string;
    socket: Socket;
    email: string;
    token: string;
    emailVerified: boolean;
    transports: string[];
    producers: string[];
    consumers: string[];
    peerDetails: {
      name: string;
      isAdmin: boolean; // Is this Peer the Admin?}
    };
  };
}; // peers: peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}

export interface transport {
  socketId: string;
  roomName: string;
  transport: types.Transport;
  consumer: boolean;
} // transports = []; // [ { socketId1, roomName1, transport, consumer }, ... ]

export interface producer {
  socketId: string;
  roomName: string;
  producer: types.Producer;
  sendTransPortId: string;
} // producers = []; // [ { socketId1, roomName1, producer, }, ... ]

export interface consumer {
  socketId: string;
  roomName: string;
  consumer: types.Producer;
  recvTransPortId: string;
} // consumers = []; // [ { socketId1, roomName1, consumer, }, ... ]
