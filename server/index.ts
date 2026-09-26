import 'dotenv/config';
import Fastify from 'fastify';
import { readConfig, publicSettings } from './config.js';

const config = readConfig();
const app = Fastify({ logger: false });
app.get('/api/health', async () => ({ ok: true }));
app.get('/api/settings', async () => publicSettings(config));
await app.listen({ host: config.host, port: config.port });
console.log(`Harness backend: http://${config.host}:${config.port}`);
