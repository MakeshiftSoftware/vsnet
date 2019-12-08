import bluebird from 'bluebird';
import http from 'http';
import jwt from 'jsonwebtoken';
import msgpack from 'msgpack-lite';
import redis from 'redis';
import WebSocket from 'ws';
import createDebugger from './debug';
import * as Protocol from './protocol';

const debug = createDebugger('server');

bluebird.promisifyAll(redis);

function noop() {}

export default class SocketServer {
  options = {
    pingInterval: 30000,
    maxClients: null,
    port: 3000
  };

  clients = {};

  constructor(options) {
    Object.assign(this.options, options);

    this.messageQueueRedis = redis.createClient(
      this.options.messageQueueRedis,
      {}
    );

    this.messageQueueRedis.on('connect', () => {
      debug('connected to message queue redis');
    });

    this.messageQueueRedis.on('ready', () => {
      debug('message queue redis is ready');
    });

    this.messageQueueRedis.on('error', e => {
      debug(`message queue redis error: ${e.message}`);
    });

    this.messageRouterRedis = redis.createClient(
      this.options.messageRouterRedis,
      {}
    );

    const server = http.createServer();

    this.wss = new WebSocket.Server({
      noServer: true
    });

    this.wss.on('connection', this.connection);
    server.on('upgrade', this.upgrade);

    setInterval(this.ping, this.options.pingInterval);

    server.listen(this.options.port);
  }

  /**
   * Send a message to a user or users.
   * @param {Object} options Options for sending the message
   * @param {String} options.message The message content
   * @param {String} options.target Target user or users for this message
   */
  send(options) {
    if (Array.isArray(options.target)) {
      this.route(options.message, options.target);
    } else {
      this.routeMulti(options.message, options.target);
    }
  }

  upgrade(request, socket, head) {
    if (!request.token) {
      socket.destroy();
      return;
    }

    jwt.verify(request.token, this.options.secret, (err, decoded) => {
      if (err) {
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(request, socket, head, ws => {
        wss.emit('connection', ws, request, decoded);
      });
    });
  }

  connection(ws) {
    ws.isAlive = true;
    ws.on('pong', () => this.keepalive(ws));
    ws.on('message', this.incoming);
  }

  incoming(message) {
    debug(`received message from client: ${message}`);
  }

  keepalive(ws) {
    ws.isAlive = true;
  }

  ping() {
    this.wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }

      ws.isAlive = false;
      ws.ping(noop);
    });
  }

  async route(message, target) {
    try {
      const serverId = await this.locate(target);

      const encoded = msgpack.encode({
        [Protocol.MESSAGE]: message,
        [Protocol.TARGET]: target
      });

      await this.messageQueueRedis.rpushAsync(serverId, encoded);
    } catch (e) {
      // Log send error
    }
  }

  async routeMulti(message, target) {
    try {
      const serverIds = await this.locateMulti(target);

      const serverToUsers = serverIds.reduce((acc, serverId, index) => {
        const userId = userIds[index];

        if (acc[serverId]) {
          acc[serverId].push(userId);
        } else {
          acc[serverId] = [userId];
        }
      }, {});

      await this.messageQueueRedis.multiAsync();

      const sendAllMessages = Object.keys(serverToUsers).map(serverId => {
        const encoded = msgpack.encode({
          [Protocol.MESSAGE]: message,
          [Protocol.TARGET]: serverToUsers[serverId]
        });

        return this.messageQueueRedis.sendAsync('RPUSH', serverId, encoded);
      });

      await Promise.all(sendAllMessages);

      await this.messageQueueRedis.execAsync();
    } catch (e) {
      // Handle send error
    }
  }

  async locate(target) {
    try {
      const serverId = await this.messageRouterRedis.getAsync(target);

      return serverId;
    } catch (e) {
      // Log and rethrow
    }
  }

  // Get server IDs for recipient IDs
  // Returns array of server ids
  async locateMulti(target) {
    try {
      await this.messageRouterRedis.multiAsync();

      const locateUsers = target.map(userId =>
        this.messageRouterRedis.sendAsync('GET', userId)
      );

      await Promise.all(locateUsers);

      const servers = await this.messageRouterRedis.execAsync();

      return servers;
    } catch (e) {
      // Log and rethrow
    }
  }
}
