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
import { consumer, peers, producer, rooms, transport } from './types';
import { randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';
import * as serviceAccount from '../firebase/firebase.config.json';
import { DecodedIdToken } from 'firebase-admin/lib/auth/token-verifier';
import { UserRecord } from 'firebase-admin/lib/auth/user-record';
/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer **/

enum ExactTrackKind {
  CAM = 'cam',
  SCREEEN = 'screen',
  MIC = 'mic',
  COMPUTERAUDIO = 'computeraudio',
}

const firebase_params = {
  type: serviceAccount.type,
  projectId: serviceAccount.project_id,
  privateKeyId: serviceAccount.private_key_id,
  privateKey: serviceAccount.private_key,
  clientEmail: serviceAccount.client_email,
  clientId: serviceAccount.client_id,
  authUri: serviceAccount.auth_uri,
  tokenUri: serviceAccount.token_uri,
  authProviderX509CertUrl: serviceAccount.auth_provider_x509_cert_url,
  clientX509CertUrl: serviceAccount.client_x509_cert_url,
};

@WebSocketGateway({
  cors: {
    origin: [
      'https://localhost:3001',
      // 'http://172.27.79.11:3001',
      'https://192.168.43.147:3001',
      'http://localhost:3002',
      'https://trusting-bardeen-5c7ecb.netlify.app',
    ],
    credentials: true,
    exposedHeaders: ['Authorization'],
    // exposedHeaders: '*',
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'],
  },
})
export class SocketEventsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private defaultApp: admin.app.App;
  // We create a Worker as soon as our application starts
  worker: mediasoup.types.Worker;
  constructor(
    private readonly mediasoupService: MediasoupService,
    private configService: ConfigService,
  ) {
    this.createWorker();
    console.log('ANNOUNCED_IP', this.configService.get<string>('ANNOUNCED_IP'));
    this.defaultApp = admin.initializeApp({
      credential: admin.credential.cert(firebase_params),
    });
  }

  @WebSocketServer()
  server: Server;

  rooms: rooms = {}; // { roomName1: { Router, rooms: [ socketId1, ... ] }, ...}
  peers: peers = {}; // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
  transports: transport[] = []; // [ { socketId1, roomName1, transport, consumer }, ... ]
  producers: producer[] = []; // [ { socketId1, roomName1, producer, }, ... ]
  consumers: consumer[] = []; // [ { socketId1, roomName1, consumer, }, ... ]

  async handleConnection(socket: Socket) {
    const accessToken = socket.handshake.headers.authorization.split(' ')[1];
    console.log('client trying to connect', accessToken);

    let authenticated = true;
    try {
      const resUser = await this.defaultApp.auth().verifyIdToken(accessToken);
      //resUser was showing email not verified so i a fetching user again
      const userInfo = await this.defaultApp.auth().getUser(resUser.uid);
      console.log('user', userInfo);

      console.log('at handle connection firest user', resUser);
      if (!userInfo.emailVerified) {
        authenticated = false;
        // check if email has a particular domain
      }
    } catch (error) {
      authenticated = false;
    }
    if (!authenticated) {
      socket.emit('connection-fail', {
        socketId: socket.id,
        msg: 'not authenticated',
      });
      // socket.disconnect();
    } else {
      socket.emit('connection-success', {
        socketId: socket.id,
      });
    }
  }

  handleDisconnect(socket: Socket) {
    //inform other peer to close canvas if disconnected peer shared canvas\
    try {
      const { roomName } = this.peers[socket.id];
      if (
        this.rooms[roomName].sharedCanvas.socketId &&
        this.rooms[roomName].sharedCanvas.socketId === socket.id
      )
        this.transports.forEach((transportData) => {
          if (
            transportData.socketId !== socket.id &&
            transportData.roomName === roomName &&
            transportData.consumer
          ) {
            const otherPeerSocket = this.peers[transportData.socketId].socket;
            // use socket to send producer id to producer
            otherPeerSocket.emit('closeSharedCanvas');
          }
        });

      console.log('at disconect', socket.id);
      // const { roomName } = this.peers[socket.id];
      delete this.peers[socket.id];

      let screenShareScktId = this.rooms[roomName].sharedScreen.socketId;
      screenShareScktId = screenShareScktId
        ? screenShareScktId === socket.id
          ? null
          : screenShareScktId
        : null;

      let canvasShareScktId = this.rooms[roomName].sharedCanvas.socketId;
      canvasShareScktId = canvasShareScktId
        ? canvasShareScktId === socket.id
          ? null
          : canvasShareScktId
        : null;

      // remove socket from room
      this.rooms[roomName] = {
        router: this.rooms[roomName].router,
        peers: this.rooms[roomName].peers.filter(
          (socketId: string) => socketId !== socket.id,
        ),
        sharedScreen: {
          socketId: screenShareScktId,
        },
        sharedCanvas: {
          socketId: canvasShareScktId,
        },
      };
    } catch (error) {
      console.log('error at this.handleDisconnect', error);
    }
    // do some cleanup
    this.transports = this.removeItems(this.transports, socket, 'transport');
  }

  @SubscribeMessage('trigger')
  triggerMe(@ConnectedSocket() socket: Socket) {
    socket.emit('trigger', {
      socketId: socket.id,
    });
  }

  @SubscribeMessage('joinRoom')
  async joinRoom(
    @ConnectedSocket() socket: Socket,
    @MessageBody('roomName') roomName: string,
  ) {
    // create Router if it does not exist
    // const router = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    const router = await this.createRoom(roomName, socket.id);

    const accessToken = socket.handshake.headers.authorization.split(' ')[1];
    console.log('at join room token', accessToken);
    let userInfo: UserRecord;
    let authenticated = true;
    try {
      const resUser = await this.defaultApp.auth().verifyIdToken(accessToken);
      //resUser was showing email not verified so i a fetching user again
      userInfo = await this.defaultApp.auth().getUser(resUser.uid);

      if (!userInfo.emailVerified) {
        authenticated = false;
        // check if email has a particular domain
      }
      // userInfo = await this.defaultApp.auth().verifyIdToken(accessToken);
      // if (!userInfo.email_verified) authenticated = false;
      //check if email has a particular domain
    } catch (error) {
      authenticated = false;
    }
    console.log('at join room', userInfo);

    if (!authenticated) return { error: 'auth failed' };
    this.peers[socket.id] = {
      socket,
      email: userInfo.email,
      token: accessToken,
      emailVerified: userInfo.emailVerified,
      roomName: roomName, // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: '',
        isAdmin: false, // Is this Peer the Admin?
      },
    };

    // console.log('joinRoom after inserting', this.peers);

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
    // console.log('createWebRtcTransport: consumer : ', consumer);
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
      // console.log('get prodcers', producerData);
      if (
        producerData.socketId !== socket.id &&
        producerData.roomName === roomName
      ) {
        producerList = [
          ...producerList,
          {
            producerId: producerData.producer.id,
            exactTrackKind: producerData.producer.appData.exactTrackKind,
          },
        ];
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
    // console.log('DTLS PARAMS... ', { dtlsParameters });

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
    const { roomName } = this.peers[socket.id];
    //if there is already screen shared in the room then nobody else should
    // be able to share their screen
    if (appData.exactTrackKind === ExactTrackKind.SCREEEN) {
      if (this.rooms[roomName].sharedScreen.socketId)
        //take some action
        return { error: 'screen already being shared by somebody' };
      else if (this.rooms[roomName].sharedCanvas.socketId)
        //take some action
        return { error: 'canvas already being shared by somebody' };
    }

    const transport = this.getTransport(socket.id, false);
    // call produce based on the prameters from the client
    const producer = await transport.produce({
      kind,
      rtpParameters,
      appData,
      paused: appData.paused,
    });
    console.log('transport produce producer.paused', producer.paused);

    if (appData.exactTrackKind === ExactTrackKind.SCREEEN)
      this.rooms[roomName].sharedScreen.socketId = socket.id;

    this.informConsumers(
      roomName,
      socket.id,
      producer.id,
      appData.exactTrackKind,
    );

    // add producer to the producers array
    this.addProducer(socket, producer, roomName, transport.id);

    console.log('Producer ID: ', producer.id, producer.kind);

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ');
      this.producers = this.producers.filter(
        (producerData) => producerData.producer.id !== producer.id,
      );
      producer.close();
    });

    // Send back to the client the Producer's id
    return {
      id: producer.id,
      // producersExist: this.producers.length > 1 ? true : false,
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
    // console.log(`DTLS PARAMS: ${dtlsParameters}`);
    // console.log('transport-recv-connect', this.transports);
    const consumerTransport = this.transports.find(
      (transportData) =>
        transportData.consumer &&
        transportData.transport.id == serverConsumerTransportId,
    ).transport;
    await consumerTransport.connect({ dtlsParameters });
  }

  @SubscribeMessage('calldrop')
  async callDrop(@ConnectedSocket() socket: Socket) {
    console.log('atcall drop');
    this.handleDisconnect(socket);
    return { ok: true };
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

      const remoteProducer = this.producers.find(
        (element) => element.producer.id === remoteProducerId,
      );

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
          appData: remoteProducer.producer.appData,
        });

        consumer.on('transportclose', () => {
          console.log('transport close from consumer');
          this.consumers = this.consumers.filter(
            (consumerData) => consumerData.consumer.id !== consumer.id,
          );
          consumer.close();
        });

        consumer.on('producerpause', async () => {
          await consumer.pause();
          consumer.appData.paused = true;
          socket.emit('consumer-pause', {
            id: consumer.id,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
          });
        });

        consumer.on('producerresume', async () => {
          console.log('at producer resume');
          await consumer.resume();
          consumer.appData.paused = false;
          socket.emit('consumer-resume', {
            id: consumer.id,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
          });
        });

        consumer.on('producerclose', async () => {
          console.log('producer close cosumer close too');
          socket.emit('consumer-close', {
            id: consumer.id,
            producerSendTransPortId: sendTransPortIdOfRemoteProd,
            exactTrackKind: consumer.appData.exactTrackKind,
          });
          this.consumers = this.consumers.filter(
            (consumerData) => consumerData.consumer.id !== consumer.id,
          );
          consumer.close();
        });

        this.addConsumer(socket, consumer, roomName, consumerTransport.id);

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          producerSendTransPortId: sendTransPortIdOfRemoteProd,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
          appData: consumer.appData,
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
    consumer.appData.paused = false;
    await consumer.resume();
  }

  // peer's media paused
  @SubscribeMessage('producer-media-pause')
  async mediaPaused(
    @ConnectedSocket() socket: Socket,
    @MessageBody('producerId') producerId: string,
  ) {
    const producer = this.producers.find(
      (ele) => ele.socketId === socket.id && ele.producer.id === producerId,
    );
    //this pause will also trigger producerpause event in associated consumer
    if (producer) {
      producer.producer.appData.paused = true;
      await producer.producer.pause();
    }
  }

  @SubscribeMessage('producer-media-resume')
  async mediaResume(
    @ConnectedSocket() socket: Socket,
    @MessageBody('producerId') producerId: string,
  ) {
    const producer = this.producers.find(
      (ele) => ele.socketId === socket.id && ele.producer.id === producerId,
    );
    if (producer) {
      console.log(`producer with id ${producer.producer.id} resumed`);
      producer.producer.appData.paused = false;
      await producer.producer.resume();
    }
  }

  //clean producer after closing
  @SubscribeMessage('producer-media-close')
  async mediaClosed(
    @ConnectedSocket() socket: Socket,
    @MessageBody('producerId') producerId: string,
  ) {
    const producer = this.producers.find(
      (ele) => ele.socketId === socket.id && ele.producer.id === producerId,
    );
    if (producer.producer.appData.exactTrackKind === ExactTrackKind.SCREEEN) {
      const { roomName } = this.peers[socket.id];
      this.rooms[roomName].sharedScreen.socketId = null;
    }
    if (producer) producer.producer.close();
  }

  @SubscribeMessage('sharedCanvas')
  sharedCanvas(@ConnectedSocket() socket: Socket) {
    const roomName = this.peers[socket.id].roomName;
    //if there is already canvas shared in the room then nobody else should
    // be able to share their canvas
    if (this.rooms[roomName].sharedCanvas.socketId)
      return { error: 'canvas already being shared by somebody', ok: false };
    else if (this.rooms[roomName].sharedScreen.socketId)
      return { error: 'screen already being shared by somebody', ok: false };

    this.rooms[roomName].sharedCanvas.socketId = socket.id;
    console.log('sharedCanvas', this.rooms[roomName].sharedCanvas.socketId);
    this.transports.forEach((transportData) => {
      if (
        transportData.socketId !== socket.id &&
        transportData.roomName === roomName &&
        transportData.consumer
      ) {
        const otherPeerSocket = this.peers[transportData.socketId].socket;
        // use socket to send producer id to producer
        console.log('sharedCanvas emit');
        otherPeerSocket.emit('sharedCanvas');
      }
    });
  }

  @SubscribeMessage('closeSharedCanvas')
  closeSharedCanvas(@ConnectedSocket() socket: Socket) {
    const roomName = this.peers[socket.id].roomName;
    if (!this.rooms[roomName].sharedCanvas.socketId)
      return { error: 'no canvas is being shared' };

    if (this.rooms[roomName].sharedCanvas.socketId == socket.id) {
      this.rooms[roomName].sharedCanvas.socketId = null;
      //inform other peers
      this.transports.forEach((transportData) => {
        if (
          transportData.socketId !== socket.id &&
          transportData.roomName === roomName &&
          transportData.consumer
        ) {
          const otherPeerSocket = this.peers[transportData.socketId].socket;
          // use socket to send producer id to producer
          otherPeerSocket.emit('closeSharedCanvas');
          return { ok: true };
        }
      });
      console.log('closed canvas');
      return { msg: 'done' };
    } else return { msg: 'not authorized to stop' };
  }

  @SubscribeMessage('drawing')
  drawing(@ConnectedSocket() socket: Socket, @MessageBody() data: any) {
    const roomName = this.peers[socket.id].roomName;

    this.transports.forEach((transportData) => {
      if (
        transportData.socketId !== socket.id &&
        transportData.roomName === roomName &&
        transportData.consumer
      ) {
        const otherPeerSocket = this.peers[transportData.socketId].socket;
        // use socket to send producer id to producer
        otherPeerSocket.emit('drawing', data);
      }
    });
  }

  @SubscribeMessage('isCanvasShared')
  isCanvasShared(@ConnectedSocket() socket: Socket) {
    const roomName = this.peers[socket.id].roomName;
    console.log(
      'CanvasShared skt id',
      this.rooms[roomName].sharedCanvas.socketId,
    );

    if (
      this.rooms[roomName].sharedCanvas.socketId &&
      this.rooms[roomName].sharedCanvas.socketId !== socket.id
    ) {
      console.log('isCanvasShared', true);
      return { isShared: true };
    } else {
      console.log('isCanvasShared', false);
      return { isShared: false };
    }
  }

  @SubscribeMessage('getIntialCanvasImage')
  async getIntialCanvasImage(@ConnectedSocket() socket: Socket) {
    const roomName = this.peers[socket.id].roomName;

    //get the initial imagedata
    const canvasHostSktId = this.rooms[roomName].sharedCanvas.socketId;

    const receiveImg = () => {
      return new Promise(async (resolve, reject) => {
        return this.peers[canvasHostSktId].socket.emit(
          'getIntialCanvasImage',
          ({ imageData, error }: { imageData: string; error?: string }) => {
            if (error) reject(error);
            return resolve(imageData);
          },
        );
      });
    };

    if (canvasHostSktId) {
      try {
        return await receiveImg();
      } catch (error) {
        return { error: 'error' };
      }
    }
  }

  @SubscribeMessage('roomExist')
  isRoomExist(
    @ConnectedSocket() socket: Socket,
    @MessageBody() roomName: string,
  ) {
    if (this.rooms[roomName]) return true;
    else return false;
  }

  @SubscribeMessage('createRoomName')
  generateRoomName() {
    let randomRoomName = this.randomString().replaceAll('/', '2');

    while (this.rooms[randomRoomName]) {
      randomRoomName = this.randomString();
      console.log('create room name in while');
    }
    console.log('final roomanme', randomRoomName);
    return randomRoomName;
  }

  @SubscribeMessage('message')
  message(
    @ConnectedSocket() socket: Socket,
    @MessageBody('text') text: string,
    @MessageBody('email') email: string,
  ) {
    console.log('at message', text);
    // console.log(this.peers[socket.id]);
    const roomName = this.peers[socket.id].roomName;
    console.log('roomName', roomName);
    // console.log('room', this.rooms[roomName]);
    if (roomName && this.rooms[roomName]) {
      this.rooms[roomName].peers.forEach((id) =>
        this.server.to(id).emit('get_message', { text, email }),
      );
    }
  }

  randomString(size = 9) {
    return randomBytes(size).toString('base64').slice(0, size);
  }

  informConsumers(
    roomName: string,
    socketId: string,
    id: string,
    exactTrackKind: ExactTrackKind,
  ) {
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
        otherPeerSocket.emit('new-producer', {
          producerId: id,
          exactTrackKind: exactTrackKind,
        });
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

  async createRoom(roomName: string, socketId: string) {
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router: mediasoup.types.Router;
    let peers = [];
    let sharedScreenOwnerSktId = null;
    let sharedCanvasOwnerId = null;
    if (this.rooms[roomName]) {
      router = this.rooms[roomName].router;
      peers = this.rooms[roomName].peers || [];
      sharedScreenOwnerSktId = this.rooms[roomName].sharedScreen.socketId;
      sharedCanvasOwnerId = this.rooms[roomName].sharedCanvas.socketId;
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
      sharedScreen: {
        socketId: sharedScreenOwnerSktId,
      },
      sharedCanvas: {
        socketId: sharedCanvasOwnerId,
      },
    };

    return router;
  }
  async createWorker() {
    this.worker = await mediasoup.createWorker({
      rtcMinPort: this.configService.get<number>('RTCMINPORT'),
      rtcMaxPort: this.configService.get<number>('RTCMAXPORT'),
    });
    console.log(`worker pid ${this.worker.pid}`);

    this.worker.on('died', () => {
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
              ip: this.configService.get<string>('IP'), // replace with relevant IP address
              // announcedIp: this.configService.get<string>('ANNOUNCED_IP'),
            },
          ],
          enableUdp: false,
          enableTcp: true,
          preferUdp: false,
          preferTcp: true,
        };

        // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
        const transport = await router.createWebRtcTransport(
          webRtcTransport_options,
        );
        console.log(`transport id: ${transport.id}`);

        transport.on('dtlsstatechange', (dtlsState) => {
          if (dtlsState === 'closed') {
            console.log('transport dtlsstatechange');
            transport.close();
          }
        });

        transport.on('close', () => {
          console.log('transport closed');
        });

        resolve(transport);
      } catch (error) {
        console.log('err at create worker', error);
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

  removeItems(items: any[], socket: Socket, type: string) {
    items.forEach((item) => {
      if (item.socketId === socket.id) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socket.id);

    return items;
  }
}
