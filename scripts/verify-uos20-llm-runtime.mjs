import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, authorization: req.headers.authorization, body });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ verdict: 'block', severity: 'high', reason: 'mock detected credential theft' }) } }],
  }));
});

await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', resolve);
});
const address = mock.address();

const child = spawn(
  process.execPath,
  ['scripts/verify-deep-links-local.mjs', 'scripts/verify-uos20-llm-probe.mjs'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      ANYSENTRY_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ANYSENTRY_LLM_MODEL: 'uos20-mock-model',
      ANYSENTRY_LLM_API_KEY: 'uos20-secret-key',
      ANYSENTRY_LLM_TIMEOUT: '5',
      ANYSENTRY_L3_ENABLED: 'false',
      ANYSENTRY_ADMIN_TOKEN: '',
      ANYSENTRY_MANAGEMENT_TOKEN: '',
    },
  },
);
const exitCode = await new Promise((resolve) => child.once('exit', resolve));
await new Promise((resolve) => mock.close(resolve));
if (exitCode !== 0) process.exit(exitCode ?? 1);
if (requests.length !== 1) throw new Error(`expected one L2 request, received ${requests.length}`);
const request = requests[0];
if (request.url !== '/v1/chat/completions') throw new Error(`unexpected L2 path: ${request.url}`);
if (request.authorization !== 'Bearer uos20-secret-key') throw new Error('L2 Bearer API key was not injected');
if (request.body?.model !== 'uos20-mock-model') throw new Error(`unexpected L2 model: ${request.body?.model}`);
console.log('UOS ARM64 Mock OpenAI runtime verification passed');
