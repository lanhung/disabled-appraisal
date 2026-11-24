import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createApp } from './lib/app.js';
import { loadProviderConfig, resolveServerHost } from './lib/config.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env'), quiet: true });
const integer = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
};

try {
  const config = loadProviderConfig(process.env);
  const localHost = config.localHttp;
  const host = resolveServerHost(process.env);
  const server = localHost
    ? http.createServer(createApp(config))
    : https.createServer({
      key: fs.readFileSync(process.env.SSL_KEY_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'gemini.lintsing.net.key')),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'gemini.lintsing.net.pem')),
    }, createApp(config));
  server.requestTimeout = config.timeoutMs + 15000;
  server.listen(integer('PORT', 3000, 1, 65535), host, () => {
    console.log(JSON.stringify({ event: 'started', provider: config.provider, port: server.address().port, textModel: config.textModel, visionModel: config.visionModel }));
  });
  server.on('error', error => { console.error('HTTPS listener failed:', error.code); process.exitCode = 1; });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 10000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
} catch (error) {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
}
