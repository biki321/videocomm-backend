import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as mediasoup from 'mediasoup';
import { MediasoupService } from './mediasoup.service';
import mediaCodecs from './mediaCodecs';
import { consumer, peers, producer, rooms, transport } from './types';
import { Producer } from 'mediasoup/node/lib/Producer';

/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer **/

@WebSocketGateway({
  cors: {
    origin: ['http://localhost:3001'],
    // credentials: true,
    // exposedHeaders: ['Authorization'],
    // exposedHeaders: '*',
    // methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  },
})
export class SocketEventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  // We create a Worker as soon as our application starts
  worker: mediasoup.types.Worker;
  constructor(private readonly mediasoupService: MediasoupService) {
    this.createWorker();
  }

  @WebSocketServer()
  server: Server;

  rooms: rooms = {}; // { roomName1: { Router, rooms: [ socketId1, ... ] }, ...}
  peers: peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
  transports: transport[] = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
  producers: producer[] = []; // [ { socketId1, roomName1, producer, }, ... ]
  consumers: consumer[] = []; // [ { socketId1, roomName1, consumer, }, ... ]

  handleConnection(socket: Socket) {
    console.log('client trying to connect');
    socket.emit('connection-success', {
      socketId: socket.id,
    });
  }

  handleDisconnect(socket: Socket) {
    console.log('socket disconnected');
    // do some cleanup
    console.log('peer disconnected');
    this.consumers = this.removeItems(
      this.consumers,
      socket,
      socket.id,
      'consumer',
    );
    this.producers = this.removeItems(
      this.producers,
      socket,
      socket.id,
      'producer',
    );
    this.transports = this.removeItems(
      this.transports,
      socket,
      socket.id,
      'transport',
    );

    try {
      console.log('at disconect', this.peers[socket.id]);
      const { roomName } = this.peers[socket.id];
      delete this.peers[socket.id];

      // remove socket from room
      this.rooms[roomName] = {
        router: this.rooms[roomName].router,
        peers: this.rooms[roomName].peers.filter(
          (socketId: string) => socketId !== socket.id,
        ),
      };
    } catch (error) {
      console.log('error at this.handleDisconnect', error);
    }
  }

  @SubscribeMessage('joinRoom')
  async joinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody('roomName') roomName: string,
  ) {
    // create Router if it does not exist
    // const router = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    const router = await this.createRoom(roomName, socket.id);

    this.peers[socket.id] = {
      socket,
      roomName, // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: '',
        isAdmin: false, // Is this Peer the Admin?
      },
    };

    console.log('joinRoom after inserting', this.peers);

    // get Router RTP Capabilities
    const rtpCapabilities = router.rtpCapabilities;

    // call callback from the client and send back the rtpCapabilities
    return { rtpCapabilities };
  }

  @SubscribeMessage('createWebRtcTransport')
  async createWebRtcTransportHandle(
    @ConnectedSocket() socket: Socket,
    @MessageBody('consumer') consumer: boolean,
  ) {
    console.log('createWebRtcTransport: consumer : ', consumer);
    // get Room Name from Peer's properties
    const roomName = this.peers[socket.id].roomName;

    // get Router (Room) object this peer is in based on RoomName
    const router = this.rooms[roomName].router;

    try {
      const transport: mediasoup.types.WebRtcTransport =
        await this.createWebRtcTransport(router);
      this.addTransport(socket, transport, roomName, consumer);
      console.log('sending paramsfrom createWebRtcTransport');
      return {
        params: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        },
      };
    } catch (error) {
      console.log(error);
      return {
        params: {
          error: 'error',
        },
      };
    }
  }

  @SubscribeMessage('getProducers')
  getProducers(@ConnectedSocket() socket: Socket) {
    //return all producer transports
    const { roomName } = this.peers[socket.id];

    let producerList = [];
    this.producers.forEach((producerData) => {
      console.log('get prodcers', producerData);
      if (
        producerData.socketId !== socket.id &&
        producerData.roomName === roomName
      ) {
        producerList = [...producerList, producerData.producer.id];
      }
    });

    // return the producer list back to the client
    return producerList;
  }

  // see client's socket.emit('transport-connect', ...)
  @SubscribeMessage('transport-connect')
  transportConnect(
    @ConnectedSocket() socket: Socket,
    @MessageBody('dtlsParameters') dtlsParameters: any,
  ) {
    console.log('DTLS PARAMS... ', { dtlsParameters });

    this.getTransport(socket.id, false).connect({ dtlsParameters });
  }

  // see client's socket.emit('transport-produce', ...)
  @SubscribeMessage('transport-produce')
  async transportProduce(
    @ConnectedSocket() socket: Socket,
    @MessageBody('kind') kind: any,
    @MessageBody('rtpParameters') rtpParameters: any,
    @MessageBody('appData') appData: any,
  ) {
    // call produce based on the prameters from the client
    const transport = this.getTransport(socket.id, false);
    const producer = await transport.produce({
      kind,
      rtpParameters,
    });

    // add producer to the producers array
    const { roomName } = this.peers[socket.id];

    this.addProducer(socket, producer, roomName, transport.id);

    this.informConsumers(roomName, socket.id, producer.id);

    console.log('Producer ID: ', producer.id, producer.kind);

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ');
      producer.close();
    });

    // Send back to the client the Producer's id
    return {
      id: producer.id,
      producersExist: this.producers.length > 1 ? true : false,
    };
  }

  // see client's socket.emit('transport-recv-connect', ...)
  @SubscribeMessage('transport-recv-connect')
  async transportRecvConnect(
    @ConnectedSocket() socket: Socket,
    @MessageBody('dtlsParameters') dtlsParameters: any,
    @MessageBody('serverConsumerTransportId')
    serverConsumerTransportId: string,
  ) {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    console.log('transport-recv-connect', this.transports);
    const consumerTransport = this.transports.find(
      (transportData) =>
        transportData.consumer &&
        transportData.transport.id == serverConsumerTransportId,
    ).transport;
    await consumerTransport.connect({ dtlsParameters });
  }

  @SubscribeMessage('consume')
  async consume(
    @ConnectedSocket() socket: Socket,
    @MessageBody('serverConsumerTransportId') serverConsumerTransportId: string,
    @MessageBody('remoteProducerId') remoteProducerId: string,
    @MessageBody('rtpCapabilities') rtpCapabilities: any,
  ) {
    try {
      const { roomName } = this.peers[socket.id];
      const router = this.rooms[roomName].router;
      const consumerTransport = this.transports.find(
        (transportData) =>
          transportData.consumer &&
          transportData.transport.id == serverConsumerTransportId,
      ).transport;

      //get send transport id of this remote Producer
      const sendTransPortIdOfRemoteProd = this.producers.find(
        (producerData) => producerData.producer.id === remoteProducerId,
      )?.sendTransPortId;

      // check if the router can consume the specified producer
      if (
        router.canConsume({
          producerId: remoteProducerId,
          rtpCapabilities,
        })
      ) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,
        });

        consumer.on('transportclose', () => {
          console.log('transport close from consumer');
        });

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed');
          socket.emit('producer-closed', {
            remoteProducerId,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
          });

          // consumerTransport.close();
          // this.transports = this.transports.filter(
          //   (transportData) =>
          //     transportData.transport.id !== consumerTransport.id,
          // );
          consumer.close();
          this.consumers = this.consumers.filter(
            (consumerData) => consumerData.consumer.id !== consumer.id,
          );
        });

        consumer.on('producerpause', async () => {
          await consumer.pause();
          socket.emit('consumer-pause', {
            id: consumer.id,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
          });
        });

        consumer.on('producerresume', async () => {
          await consumer.resume();
          socket.emit('consumer-resume', {
            id: consumer.id,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
          });
        });

        this.addConsumer(socket, consumer, roomName, consumerTransport.id);

        const remoteProducer = this.producers.find(
          (element) => element.producer.id === remoteProducerId,
        );

        const producerSendTransPortId = this.transports.find(
          (element) => element.socketId == remoteProducer.socketId,
        ).transport.id;

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          producerSendTransPortId: producerSendTransPortId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
        };

        // send the parameters to the client
        return { params };
      }
    } catch (error) {
      console.log(error.message);
      return {
        params: {
          error: error,
        },
      };
    }
  }

  @SubscribeMessage('consumer-resume')
  async consumerResume(
    @ConnectedSocket() socket: Socket,
    @MessageBody('serverConsumerId') serverConsumerId: string,
  ) {
    console.log('consumer resume');
    const { consumer } = this.consumers.find(
      (consumerData) => consumerData.consumer.id === serverConsumerId,
    );
    await consumer.resume();
  }

  // peer's media paused
  @SubscribeMessage('producer-media-paused')
  async mediaPaused(
    @ConnectedSocket() socket: Socket,
    @MessageBody('producerId') producerId: string,
  ) {
    const producer = this.producers.find(
      (ele) => ele.socketId === socket.id && ele.producer.id === producerId,
    );
    //this pause will also trigger producerpause event in associated consumer
    if (producer) await producer.producer.pause();
  }

  @SubscribeMessage('producer-media-resume')
  async mediaResume(
    @ConnectedSocket() socket: Socket,
    @MessageBody('producerId') producerId: string,
  ) {
    const producer = this.producers.find(
      (ele) => ele.socketId === socket.id && ele.producer.id === producerId,
    );
    if (producer) await producer.producer.resume();
  }

  informConsumers(roomName: string, socketId: string, id: string) {
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`);
    // A new producer just joined
    // let all consumers to consume this producer
    this.transports.forEach((transportData) => {
      if (
        transportData.socketId !== socketId &&
        transportData.roomName === roomName &&
        transportData.consumer
      ) {
        const otherPeerSocket = this.peers[transportData.socketId].socket;
        // use socket to send producer id to producer
        otherPeerSocket.emit('new-producer', { producerId: id });
      }
    });
  }

  getTransport(socketId: string, consumer: boolean) {
    const transport = this.transports.find(
      (transport) =>
        transport.socketId === socketId && transport.consumer === consumer,
    );
    return transport.transport;
  }

  async createRoom(roomName, socketId) {
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router: mediasoup.types.Router;
    let peers = [];
    if (this.rooms[roomName]) {
      router = this.rooms[roomName].router;
      peers = this.rooms[roomName].peers || [];
    } else {
      router = await this.worker.createRouter({
        mediaCodecs: [
          {
            kind: 'audio',
            mimeType: 'audio/opus',
            clockRate: 48000,
            channels: 2,
          },
          {
            kind: 'video',
            mimeType: 'video/VP8',
            clockRate: 90000,
            parameters: {
              'x-google-start-bitrate': 1000,
            },
          },
        ],
      });
    }

    console.log(`Router ID: ${router.id}`, peers.length);

    this.rooms[roomName] = {
      router: router,
      peers: [...peers, socketId],
    };

    return router;
  }
  async createWorker() {
    this.worker = await mediasoup.createWorker({
      rtcMinPort: 2000,
      rtcMaxPort: 2020,
    });
    console.log(`worker pid ${this.worker.pid}`);

    this.worker.on('died', (error) => {
      // This implies something serious happened, so kill the application
      console.error('mediasoup worker has died');
      setTimeout(() => process.exit(1), 2000); // exit in 2 seconds
    });
  }

  async createWebRtcTransport(
    router: mediasoup.types.Router,
  ): Promise<mediasoup.types.WebRtcTransport> {
    return new Promise(async (resolve, reject) => {
      try {
        // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
        const webRtcTransport_options = {
          listenIps: [
            {
              ip: '0.0.0.0', // replace with relevant IP address
              announcedIp: '127.0.0.1',
            },
          ],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
        };

        // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
        const transport = await router.createWebRtcTransport(
          webRtcTransport_options,
        );
        console.log(`transport id: ${transport.id}`);

        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'closed') {
            transport.close();
          }
        });

        transport.on('close', () => {
          console.log('transport closed');
        });

        resolve(transport);
      } catch (error) {
        reject(error);
      }
    });
  }

  addTransport(socket: Socket, transport, roomName, consumer) {
    this.transports = [
      ...this.transports,
      { socketId: socket.id, transport, roomName, consumer },
    ];

    this.peers[socket.id] = {
      ...this.peers[socket.id],
      transports: [...this.peers[socket.id].transports, transport.id],
    };
  }

  addProducer(socket, producer, roomName, sendTransPortId: string) {
    this.producers = [
      ...this.producers,
      { socketId: socket.id, producer, roomName, sendTransPortId },
    ];

    this.peers[socket.id] = {
      ...this.peers[socket.id],
      producers: [...this.peers[socket.id].producers, producer.id],
    };
  }

  addConsumer = (
    socket: Socket,
    consumer,
    roomName: string,
    recvTransPortId: string,
  ) => {
    // add the consumer to the consumers list
    this.consumers = [
      ...this.consumers,
      { socketId: socket.id, consumer, roomName, recvTransPortId },
    ];

    // add the consumer id to the peers list
    this.peers[socket.id] = {
      ...this.peers[socket.id],
      consumers: [...this.peers[socket.id].consumers, consumer.id],
    };
  };

  removeItems(items: any[], socket: Socket, socketId: string, type: string) {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  }
}
