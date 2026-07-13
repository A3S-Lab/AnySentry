import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const requests = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ url: req.url, authorization: req.headers.authorization, body });
  const content = JSON.stringify({ verdict: 'block', severity: 'critical', reason: 'mock L3 confirmed credential attack chain' });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'chatcmpl-uos20-l3',
    object: 'chat.completion',
    model: body.model,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
  }));
});
await new Promise((resolve, reject) => {
  mock.once('error', reject);
  mock.listen(0, '127.0.0.1', resolve);
});

const address = mock.address();
const child = spawn(
  process.execPath,
  ['scripts/l3-agent.mjs', '--skills', 'skills/l3', '--json', '-p', 'Investigate a Python process reading /home/agent/.ssh/id_rsa and return a security verdict.'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_PATH: path.resolve('apps/api/node_modules'),
      ANYSENTRY_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      ANYSENTRY_LLM_MODEL: 'uos20-l3-model',
      ANYSENTRY_LLM_API_KEY: 'uos20-l3-key',
      ANYSENTRY_L3_WORKSPACE: path.resolve('.build/uos20-arm64/l3-x64-state'),
    },
  },
);
let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.once('exit', resolve));
await new Promise((resolve) => mock.close(resolve));
if (exitCode !== 0) throw new Error(`L3 agent exited ${exitCode}: ${stderr}`);
const verdict = JSON.parse(stdout.trim());
if (verdict.verdict !== 'block' || verdict.severity !== 'critical') {
  throw new Error(`unexpected L3 verdict: ${stdout}`);
}
if (requests.length !== 1) throw new Error(`expected one L3 request, received ${requests.length}`);
if (requests[0].url !== '/v1/chat/completions') throw new Error(`unexpected L3 path: ${requests[0].url}`);
if (requests[0].authorization !== 'Bearer uos20-l3-key') throw new Error('L3 Bearer key was not sent');
if (requests[0].body?.model !== 'uos20-l3-model') throw new Error(`unexpected L3 model: ${requests[0].body?.model}`);
console.log('UOS ARM64 Mock OpenAI L3 runtime verification passed');
