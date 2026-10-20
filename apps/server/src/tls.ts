import http from 'node:http';
import https from 'node:https';

/** 同一请求处理器可运行在 HTTP 或 HTTPS，WebSocket 挂载到返回的服务器。 */
export function createTransportServer(handler: http.RequestListener, tls?: https.ServerOptions): http.Server | https.Server {
  return tls ? https.createServer(tls, handler) : http.createServer(handler);
}
