// Combines the Metro web bundler (8081) and the backend (8080) behind one
// port, so a single ngrok tunnel (free-tier: one domain) can serve both the
// web app and its WebSocket/API backend over HTTPS/WSS.
const http = require('http');
const httpProxy = require('http-proxy');

const WEB_TARGET = 'http://localhost:8081';
const BACKEND_TARGET = 'http://localhost:8080';
const PORT = 9000;

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('[dev-proxy] proxy error:', err.message);
  if (res && res.writeHead) {
    res.writeHead(502);
    res.end('Bad gateway');
  }
});

function isBackendHttpPath(url) {
  return url.startsWith('/clerk/') || url.startsWith('/conversations');
}

const server = http.createServer((req, res) => {
  const target = isBackendHttpPath(req.url) ? BACKEND_TARGET : WEB_TARGET;
  proxy.web(req, res, { target });
});

server.on('upgrade', (req, socket, head) => {
  // Our app connects its signaling WebSocket to the bare root path ('/').
  // Metro's OWN WebSocket (Hot Module Reload / Fast Refresh, e.g. '/hot',
  // '/_expo/...') is a completely separate connection that must reach the
  // web bundler, not the backend — sending it to the backend was making
  // Metro's HMR client receive our app's protocol messages instead of its
  // own, crashing with "Expected data to be an object" repeatedly and
  // destabilizing the whole page.
  const target = req.url === '/' ? BACKEND_TARGET : WEB_TARGET;
  console.log(`[dev-proxy] WS upgrade ${req.url} -> ${target}`);
  proxy.ws(req, socket, head, { target });
});

server.listen(PORT, () => {
  console.log(`[dev-proxy] Listening on ${PORT} -> web:${WEB_TARGET}, backend:${BACKEND_TARGET}`);
});
