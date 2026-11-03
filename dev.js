import { createServer as createViteServer } from 'vite';
import { createApiServer } from './backend/server.js';

const api = createApiServer();
await new Promise((resolve, reject) => {
  api.once('error', reject);
  api.listen(3001, '127.0.0.1', resolve);
});

const vite = await createViteServer({ server: { host: '127.0.0.1' } });
await vite.listen();
vite.printUrls();
console.log('LifeOS local data API: http://127.0.0.1:3001');

const shutdown = async () => {
  await vite.close();
  await new Promise((resolve) => api.close(resolve));
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
