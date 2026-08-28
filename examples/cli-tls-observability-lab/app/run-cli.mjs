#!/usr/bin/env node

import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const product = process.argv[2];
if (!['codex', 'claude'].includes(product)) throw new Error('usage: run-cli.mjs codex|claude');
const results = process.env.CLI_LAB_RESULTS_DIR || path.resolve('.runtime/results');
const tlsDirectory = process.env.CLI_LAB_TLS_DIR || path.resolve('.runtime/tls');
const port = Number(process.env.CLI_LAB_HTTPS_PORT || 19443);
const httpPort = Number(process.env.CLI_LAB_HTTP_PORT || 19080);
const graceMs = Number(process.env.CLI_LAB_ATTACH_GRACE_SECONDS || 6) * 1_000;
const apiKey = process.env.CLI_LAB_API_KEY || 'fixture-key-not-secret';
await mkdir(results, { recursive: true, mode: 0o700 });

async function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  let launcher;
  for (const directory of process.env.PATH?.split(path.delimiter) ?? []) {
    const candidate = path.join(directory, 'codex');
    try {
      await access(candidate);
      launcher = candidate;
      break;
    } catch {
      // Continue through PATH exactly as execvp would.
    }
  }
  if (!launcher) throw new Error('codex executable was not found on PATH');
  const packageRoot = path.resolve(path.dirname(await realpath(launcher)), '..');
  const platform = process.platform === 'linux' && process.arch === 'x64'
    ? ['@openai', 'codex-linux-x64', 'vendor', 'x86_64-unknown-linux-musl', 'bin', 'codex']
    : undefined;
  if (!platform) throw new Error(`CLI TLS fixture does not map Codex binary for ${process.platform}/${process.arch}`);
  const binary = path.join(packageRoot, 'node_modules', ...platform);
  await access(binary);
  return binary;
}

let command;
let args;
let prompt;
let pausedForAttach = false;
const env = {
  ...process.env,
  SSL_CERT_FILE: path.join(tlsDirectory, 'ca.crt'),
  REQUESTS_CA_BUNDLE: path.join(tlsDirectory, 'ca.crt'),
  NODE_EXTRA_CA_CERTS: path.join(tlsDirectory, 'ca.crt'),
};
for (const key of Object.keys(env)) {
  if (key.toLowerCase().includes('proxy')) delete env[key];
}
env.NO_PROXY = '127.0.0.1,localhost';
env.no_proxy = env.NO_PROXY;
if (product === 'codex') {
  command = await codexBinary();
  prompt = 'Run the model-requested fixture command, then finish. CODEX_FINAL_PROMPT_SENTINEL_20260827';
  const protocol = process.env.CLI_LAB_CODEX_PROTOCOL === 'https' ? 'https' : 'http';
  if (protocol === 'https') {
    delete env.SSL_CERT_FILE;
    delete env.CODEX_CA_CERTIFICATE;
    env.SSL_CERT_DIR = tlsDirectory;
  }
  const providerPort = protocol === 'https' ? port : httpPort;
  const provider = `{ name = "AnySentry fixture", base_url = "${protocol}://127.0.0.1:${providerPort}/v1", env_key = "CLI_LAB_API_KEY", wire_api = "responses", supports_websockets = false, request_max_retries = 0, stream_max_retries = 0 }`;
  args = [
    'exec', '--ignore-user-config', '--ignore-rules', '--disable', 'code_mode',
    '--disable', 'multi_agent', '--skip-git-repo-check', '--ephemeral', '--json',
    '--sandbox', 'read-only',
    '--config', 'approval_policy="never"',
    '--config', 'model_provider="anysentry_fixture"',
    '--config', 'model="fixture-codex-model"',
    '--config', 'model_supports_reasoning_summaries=false',
    '--config', `model_providers.anysentry_fixture=${provider}`,
    prompt,
  ];
  pausedForAttach = true;
  env.CLI_LAB_API_KEY = apiKey;
  env.CODEX_HOME = path.join(results, 'codex-home');
  await mkdir(env.CODEX_HOME, { recursive: true, mode: 0o700 });
} else {
  command = process.env.CLAUDE_BIN || 'claude';
  args = [
    '--print', '--bare', '--no-session-persistence', '--disable-slash-commands',
    '--allowedTools', 'Bash', '--permission-mode', 'dontAsk',
    '--model', 'fixture-claude-model', '--output-format', 'stream-json',
    '--include-partial-messages', '--verbose',
  ];
  prompt = 'Run the model-requested Bash fixture, then finish. CLAUDE_FINAL_PROMPT_SENTINEL_20260827';
  args.push(prompt);
  pausedForAttach = true;
  env.ANTHROPIC_API_KEY = apiKey;
  env.ANTHROPIC_BASE_URL = `https://127.0.0.1:${port}`;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CLAUDE_CONFIG_DIR = path.join(results, 'claude-config');
  await mkdir(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
}

const child = spawn(command, args, {
  cwd: results,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
if (pausedForAttach) {
  child.kill('SIGSTOP');
  child.stdin.end();
}
await writeFile(path.join(results, `${product}-attach-ready.json`), JSON.stringify({
  schemaVersion: 'anysentry.cli_tls_attach_ready.v1',
  product,
  pid: child.pid,
  readyAtUnixNs: (BigInt(Date.now()) * 1_000_000n).toString(),
  graceMs,
}), { encoding: 'utf8', mode: 0o600 });

const stdout = [];
const stderr = [];
child.stdout.on('data', (chunk) => stdout.push(chunk));
child.stderr.on('data', (chunk) => stderr.push(chunk));
const exitPromise = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
const timeout = setTimeout(
  () => child.kill('SIGKILL'),
  Number(process.env.CLI_LAB_AGENT_TIMEOUT_SECONDS || 180) * 1_000,
);
await new Promise((resolve) => setTimeout(resolve, graceMs));
if (child.exitCode === null && child.signalCode === null) {
  if (pausedForAttach) child.kill('SIGCONT');
  else child.stdin.end(`${prompt}\n`);
}
const result = await exitPromise;
clearTimeout(timeout);
const stdoutText = Buffer.concat(stdout).toString('utf8');
const stderrText = Buffer.concat(stderr).toString('utf8');
await Promise.all([
  writeFile(path.join(results, `${product}-stdout.ndjson`), stdoutText, { encoding: 'utf8', mode: 0o600 }),
  writeFile(path.join(results, `${product}-stderr.log`), stderrText, { encoding: 'utf8', mode: 0o600 }),
]);
if (result.code !== 0) {
  throw new Error(`${product} exited code=${result.code} signal=${result.signal}: ${stderrText.slice(-4_000)}`);
}
const expected = product === 'codex' ? 'CODEX_TOOL_RESULT_SENTINEL_20260827' : 'CLAUDE_TOOL_RESULT_SENTINEL_20260827';
if (!stdoutText.includes(expected)) throw new Error(`${product} output omitted fixture tool marker`);
console.log(JSON.stringify({ event: 'cli_tls_agent_passed', product, pid: child.pid, outputBytes: Buffer.byteLength(stdoutText) }));
