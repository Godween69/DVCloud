// Админка DV Cloud: пока только заглушка. Слушает только localhost.
import { createServer } from 'node:http';

const port = Number(process.env.DVCLOUD_ADMIN_PORT ?? 3005);
const host = process.env.DVCLOUD_ADMIN_HOST ?? '127.0.0.1';

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'dvcloud-admin' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('DV Cloud: админка (заглушка)\n');
}).listen(port, host, () => console.log(`DVCloud admin слушает ${host}:${port}`));
