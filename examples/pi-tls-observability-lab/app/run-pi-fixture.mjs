import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const appDirectory = path.dirname(fileURLToPath(import.meta.url));
const labDirectory = path.resolve(appDirectory, '..');
const piDelayedEntry = path.join(appDirectory, 'pi-delayed-entry.mjs');
const baseUrl = process.env.PI_LAB_BASE_URL || 'https://127.0.0.1:18443/v1';
const apiKey = process.env.PI_LAB_API_KEY || 'fixture-key-not-secret';
const model = process.env.PI_LAB_MODEL || 'fixture-tool-model';
const workspace = path.resolve(process.env.PI_LAB_WORKSPACE || path.join(labDirectory, '.runtime', 'workspace'));
const resultsDirectory = path.resolve(process.env.PI_LAB_RESULTS_DIR || path.join(labDirectory, '.runtime', 'results'));
const agentDirectory = path.resolve(process.env.PI_LAB_AGENT_DIR || path.join(resultsDirectory, 'pi-state'));
const transcriptPath = path.join(resultsDirectory, 'pi-events.ndjson');
const timeoutSeconds = Math.max(10, Math.min(600, Number(process.env.PI_LAB_TURN_TIMEOUT_SECONDS || 45)));
const FINAL_PROMPT_SENTINEL = 'PI_FINAL_PROMPT_SENTINEL_20260827';
const CANARY_SENTINEL = 'PI_CANARY_RESULT_SENTINEL_20260827';
const INTERNAL_RAG_SENTINEL = 'PI_INTERNAL_RAG_MUST_NOT_LEAK_20260827';

function safeUrl(raw) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PI_LAB_BASE_URL must use http or https');
  if (url.username || url.password) throw new Error('PI_LAB_BASE_URL must not embed credentials');
  return url.toString().replace(/\/$/u, '');
}

function now() {
  return {
    observedAt: new Date().toISOString(),
    observedAtUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
    observedAtMonotonicNs: process.hrtime.bigint().toString(),
  };
}

let writeChain = Promise.resolve();
function record(event) {
  const line = `${JSON.stringify({ schemaVersion: 'anysentry.pi_fixture_observation.v1', ...now(), ...event })}\n`;
  writeChain = writeChain.then(() => appendFile(transcriptPath, line, { encoding: 'utf8', mode: 0o600 }));
  return writeChain;
}

function inspectTlsRuntime() {
  const readelf = spawnSync('readelf', ['-Ws', process.execPath], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const notes = spawnSync('readelf', ['-n', process.execPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const symbols = ['SSL_write', 'SSL_read', 'SSL_write_ex', 'SSL_read_ex'];
  const exportedSymbols = symbols.filter((symbol) => new RegExp(`\\b${symbol}$`, 'mu').test(readelf.stdout || ''));
  const ldd = spawnSync('ldd', [process.execPath], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const dynamicTlsLibraries = (ldd.stdout || '')
    .split(/\r?\n/u)
    .filter((line) => /lib(?:ssl|crypto)/u.test(line))
    .map((line) => line.trim());
  const mappedTlsLibraries = readFileSync('/proc/self/maps', 'utf8')
    .split(/\r?\n/u)
    .filter((line) => /lib(?:ssl|crypto)/u.test(line))
    .map((line) => line.trim());
  const executableStat = statSync(process.execPath);
  const piPackage = JSON.parse(readFileSync(path.join(
    labDirectory,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'package.json',
  ), 'utf8'));
  return {
    piVersion: piPackage.version,
    nodeVersion: process.version,
    nodeExecPath: process.execPath,
    nodeBuildId: (notes.stdout || '').match(/Build ID:\s*([a-f0-9]+)/iu)?.[1],
    nodeDevice: executableStat.dev.toString(),
    nodeInode: executableStat.ino.toString(),
    platform: process.platform,
    architecture: process.arch,
    exportedSymbols,
    dynamicTlsLibraries,
    mappedTlsLibraries,
    symbolInspectionStatus: readelf.status === 0 ? 'ok' : `failed:${readelf.status ?? readelf.error?.code ?? 'unknown'}`,
    tlsAttachHint: exportedSymbols.length > 0
      ? 'node_main_executable_exports_openssl_symbols'
      : dynamicTlsLibraries.length > 0
        ? 'node_maps_dynamic_openssl'
        : 'tls_symbols_not_located',
  };
}

function consumeLines(stream, source, destination) {
  stream.setEncoding('utf8');
  let pending = '';
  stream.on('data', (chunk) => {
    destination.write(chunk);
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      void record({ event: `${source}_line`, line, parsed });
    }
  });
  stream.once('end', () => {
    if (pending) void record({ event: `${source}_line`, line: pending });
  });
}

const providerBaseUrl = safeUrl(baseUrl);
if (!apiKey) throw new Error('PI_LAB_API_KEY is required');
if (!/^[A-Za-z0-9._:/-]{1,200}$/u.test(model)) throw new Error('PI_LAB_MODEL contains unsupported characters');

await Promise.all([
  mkdir(workspace, { recursive: true, mode: 0o700 }),
  mkdir(resultsDirectory, { recursive: true, mode: 0o700 }),
  mkdir(agentDirectory, { recursive: true, mode: 0o700 }),
]);
await writeFile(path.join(workspace, 'canary.txt'), `${CANARY_SENTINEL}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(path.join(workspace, 'internal-rag-not-sent.txt'), `${INTERNAL_RAG_SENTINEL}\n`, { encoding: 'utf8', mode: 0o600 });
await writeFile(path.join(agentDirectory, 'models.json'), JSON.stringify({
  providers: {
    'anysentry-fixture': {
      name: 'AnySentry fixture OpenAI-compatible provider',
      baseUrl: providerBaseUrl,
      api: 'openai-completions',
      apiKey: '$PI_LAB_API_KEY',
      models: [{
        id: model,
        name: model,
        reasoning: false,
        input: ['text'],
        contextWindow: 32_768,
        maxTokens: 2_048,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsUsageInStreaming: true,
          maxTokensField: 'max_tokens',
        },
      }],
    },
  },
}, null, 2), { encoding: 'utf8', mode: 0o600 });

const runtimeInfo = inspectTlsRuntime();
await writeFile(path.join(resultsDirectory, 'tls-runtime.json'), `${JSON.stringify(runtimeInfo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });

const prompt = [
  'Run the deterministic AnySentry transport-boundary fixture.',
  `Final prompt marker: ${FINAL_PROMPT_SENTINEL}.`,
  'Use only tools requested by the model. The expected order is read followed by bash.',
  'The final answer must preserve the fixture markers returned by the model.',
].join(' ');

const args = [
  '--mode', 'json',
  '--print',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-context-files',
  '--approve',
  '--tools', 'read,bash',
  '--provider', 'anysentry-fixture',
  '--model', model,
  '--thinking', 'off',
  prompt,
];

await record({
  event: 'pi_process_starting',
  agentId: process.env.AGENT_ID || 'host-pi-tls-fixture',
  baseUrl: providerBaseUrl,
  model,
  workspace,
  runtimeInfo,
  argv: args.map((argument, index) => index === args.length - 1 ? '<fixture-prompt>' : argument),
});

const child = spawn(process.execPath, [piDelayedEntry, ...args], {
  cwd: workspace,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_CODING_AGENT_SESSION_DIR: path.join(agentDirectory, 'sessions'),
    PI_LAB_API_KEY: apiKey,
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    PI_OFFLINE: '1',
    PI_LAB_READY_FILE: process.env.PI_LAB_READY_FILE || path.join(resultsDirectory, 'pi-attach-ready.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
await record({ event: 'pi_process_started', pid: child.pid, executable: process.execPath });
consumeLines(child.stdout, 'pi_stdout', process.stdout);
consumeLines(child.stderr, 'pi_stderr', process.stderr);

let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
}, timeoutSeconds * 1000);
timeout.unref();

const exit = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
await record({ event: 'pi_process_exited', ...exit, timedOut });
await writeChain;

if (timedOut) process.exitCode = 124;
else if (exit.code !== 0) process.exitCode = exit.code ?? 1;
