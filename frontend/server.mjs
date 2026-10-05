import express from 'express';
import { createProxyServer } from 'httpxy';
import { isIP } from 'node:net';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT ?? 80);
const BACKEND = process.env.BACKEND_URL ?? 'http://backend:3000';
const production = process.env.APP_ENV === 'production';
const trustCloudflare = process.env.TRUST_CLOUDFLARE_PROXY === 'true';
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  });
  if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const proxy = createProxyServer({target: BACKEND, changeOrigin: true, xfwd: false, proxyTimeout: 110000});
proxy.on('proxyReq', (outgoing, req) => {
  const cloudflareIp = req.headers['cf-connecting-ip'];
  const visitor = trustCloudflare && typeof cloudflareIp === 'string' && isIP(cloudflareIp)
    ? cloudflareIp : req.socket.remoteAddress;
  // Replace untrusted forwarding chains. Only the private frontend may supply this hop to the backend.
  outgoing.removeHeader('forwarded');
  outgoing.removeHeader('x-forwarded-host');
  outgoing.setHeader('x-forwarded-for', visitor || '127.0.0.1');
  outgoing.setHeader('x-forwarded-proto', production ? 'https' : 'http');
});
proxy.on('proxyRes', upstream => {
  upstream.headers['cache-control'] = 'private, no-store';
  upstream.headers['cloudflare-cdn-cache-control'] = 'no-store';
  delete upstream.headers['x-powered-by'];
});

// Proxy /invoice/* to backend — mounted at root so path is not stripped
app.use((req, res, next) => {
  if (!/^\/(api|invoice)(\/|\?|$)/.test(req.url)) return next();
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
  void proxy.web(req, res).catch(() => {
    if (res.headersSent) return res.destroy();
    res.status(502).json({message: 'Application is temporarily unavailable. Please try again.'});
  });
});

app.use(express.static(join(__dirname, 'dist')));

app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(join(__dirname, 'dist', 'index.html'));
});

const server = app.listen(PORT, () => {
  console.log(`Frontend server listening on port ${server.address().port}, proxying /invoice → ${BACKEND}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
