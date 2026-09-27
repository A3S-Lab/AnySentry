import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import process from 'node:process';

const endpoint = new URL(process.argv[2] || process.env.PI_LAB_HEALTH_URL || 'https://127.0.0.1:18443/healthz');
const caPath = process.argv[3] || process.env.NODE_EXTRA_CA_CERTS;
const transport = endpoint.protocol === 'https:' ? https : http;
const ca = endpoint.protocol === 'https:' && caPath ? await readFile(caPath) : undefined;

await new Promise((resolve, reject) => {
  const request = transport.get(endpoint, { ca, timeout: 2_000 }, (response) => {
    response.resume();
    response.once('end', () => {
      if (response.statusCode === 200) resolve();
      else reject(new Error(`health check returned ${response.statusCode}`));
    });
  });
  request.once('timeout', () => request.destroy(new Error('health check timeout')));
  request.once('error', reject);
});
