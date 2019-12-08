import SocketServer from './index';

new SocketServer({
  port: 3000,
  messageQueueRedis: 'redis://localhost:6379',
  messageRouterRedis: 'redis://localhost:6380',
  secret: 'secret'
});
