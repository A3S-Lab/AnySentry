import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const piBin = path.resolve(appDir, '../node_modules/.bin/pi');
const workspace = process.env.AGENT_WORKSPACE || '/workspace';
const intervalMs = Math.max(1, Number(process.env.AGENT_INTERVAL_SECONDS || 60)) * 1000;
const retryMs = Math.max(1, Number(process.env.PI_RETRY_SECONDS || 10)) * 1000;
const agentId = process.env.AGENT_ID || 'pi-coding-agent';
const requestedMode = (process.env.PI_EXECUTION_MODE || 'auto').toLowerCase();

const credentialNames = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'XAI_API_KEY',
  'ZAI_API_KEY',
  'MINIMAX_API_KEY',
];
const availableCredential = credentialNames.find((name) => Boolean(process.env[name]));
const executionMode = requestedMode === 'auto'
  ? (availableCredential ? 'loop' : 'rpc')
  : requestedMode;

let stopping = false;
let child;

function log(event, fields = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    runtime: 'pi',
    agentId,
    event,
    ...fields,
  }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emitLocalIdentityProbe() {
  const socket = connect({ host: '127.0.0.1', port: 9 });
  socket.setTimeout(1_000);
  socket.once('connect', () => socket.destroy());
  socket.once('error', () => socket.destroy());
  socket.once('timeout', () => socket.destroy());
}

function childArgs(round) {
  const common = [
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--approve',
  ];

  if (executionMode === 'rpc') return ['--mode', 'rpc', ...common];

  const args = [
    '--mode',
    'json',
    ...common,
    '--tools',
    'read,bash,write,ls',
  ];
  if (process.env.PI_PROVIDER) args.push('--provider', process.env.PI_PROVIDER);
  if (process.env.PI_MODEL) args.push('--model', process.env.PI_MODEL);
  if (process.env.PI_THINKING) args.push('--thinking', process.env.PI_THINKING);

  const marker = `${agentId}-round-${round}`;
  const prompt = process.env.PI_AGENT_PROMPT ||
    `This is a harmless AnySentry instrumentation test. ` +
    `Use the read tool to read ${workspace}/canary.txt. ` +
    `Then use the bash tool to append exactly ${marker} to ${workspace}/tool-events.log. ` +
    `Finally reply with a one-line summary containing ${marker}.`;
  args.push(prompt);
  return args;
}

async function runPi(round) {
  const args = childArgs(round);
  log('pi_process_starting', {
    round,
    mode: executionMode,
    provider: process.env.PI_PROVIDER || 'auto',
    model: process.env.PI_MODEL || 'auto',
    credentialSource: availableCredential || 'none',
    argv: args.map((arg, index) => index === args.length - 1 && executionMode !== 'rpc' ? '<prompt>' : arg),
  });

  return await new Promise((resolve) => {
    child = spawn(piBin, args, {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT: 'true',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data) => process.stdout.write(data));
    child.stderr.on('data', (data) => process.stderr.write(data));
    child.once('error', (error) => {
      log('pi_process_error', { round, error: error.message });
    });
    child.once('exit', (code, signal) => {
      log('pi_process_exited', { round, code, signal });
      child = undefined;
      resolve(code ?? 1);
    });

    writeFile('/tmp/agent-ready', `${Date.now()}\n`, 'utf8').catch((error) => {
      log('readiness_write_failed', { error: error.message });
    });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    log('shutdown_requested', { signal });
    child?.kill('SIGTERM');
  });
}

async function main() {
  if (!['loop', 'rpc'].includes(executionMode)) {
    throw new Error(`PI_EXECUTION_MODE must be auto, loop, or rpc; received ${requestedMode}`);
  }

  await mkdir(workspace, { recursive: true });
  await writeFile(`${workspace}/canary.txt`, 'AnySentry Pi coding-agent canary\n', 'utf8');
  log('started', {
    pid: process.pid,
    workspace,
    mode: executionMode,
    intervalSeconds: intervalMs / 1000,
  });
  emitLocalIdentityProbe();
  const identityProbeTimer = setInterval(emitLocalIdentityProbe, Math.min(intervalMs, 15_000));
  identityProbeTimer.unref();

  let round = 0;
  while (!stopping) {
    round += 1;
    const code = await runPi(round);
    if (stopping) break;

    if (executionMode === 'rpc') {
      log('rpc_restart_scheduled', { code, retrySeconds: retryMs / 1000 });
      await delay(retryMs);
    } else {
      log('next_agent_turn_scheduled', { code, intervalSeconds: intervalMs / 1000 });
      await delay(intervalMs);
    }
  }
}

main().catch((error) => {
  log('fatal', { error: error instanceof Error ? error.stack || error.message : String(error) });
  process.exitCode = 1;
});
