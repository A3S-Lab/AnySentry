#!/usr/bin/env node

/**
 * Destructive-by-opt-in real Agent lifecycle E2E.
 *
 * Default invocation is a non-mutating application dry run. A preflight may create and remove a
 * private temporary directory to prove that the local Codex workspace sandbox is usable. The
 * --execute flag is required before this script creates any persistent process, container, Pod,
 * Secret, run workspace, or evidence directory. A Kubernetes preflight may use a temporary
 * port-forward and access reviews, which can appear in API-server audit logs but do not alter
 * application resources. All
 * orchestrated compute resources include a unique run ID and cleanup refuses to delete a resource
 * whose ownership label does not match that run ID. As with every real collector test, ingested
 * events, auto-discovered Source records, heartbeats, and bounded runtime records remain in the
 * target API as run-ID evidence; the API has no supported destructive cleanup endpoint.
 *
 * The three data planes are deliberately separate:
 *   host       -> host debug API (127.0.0.1:29655), or skipped
 *   Docker     -> Docker Compose API (127.0.0.1:29653)
 *   Kubernetes -> a dedicated local kubectl port-forward to service/anysentry
 *
 * No credential value is accepted on the command line. Pi receives a caller-owned 0600 key file
 * through a read-only bind mount or a run-scoped Kubernetes Secret. Reports contain only hashes,
 * sizes, boolean proof, and sanitized AnySentry records.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..');
const DEFAULT_KEY_FILE = '/tmp/observer-study-deepseek-key';
const DEFAULT_DOCKER_API = 'http://127.0.0.1:29653/security-center';
const DEFAULT_HOST_API = 'http://127.0.0.1:29655/security-center';
const DEFAULT_K8S_PORT = 39653;
const DEFAULT_NAMESPACE = 'anysentry-agent-test';
const DEFAULT_OBSERVER_IMAGE = '127.0.0.1:5000/anysentry-observer:agent-runtime-lab';
const DEFAULT_K8S_OBSERVER_IMAGE = 'localhost:5000/anysentry-observer:local';
const DEFAULT_AGENT_IMAGE = '127.0.0.1:5000/anysentry-agent-runtime-lab:0.1.0';
const ALLOWED_PHASES = new Set(['shadow', 'enforce']);
const ALLOWED_AGENTS = new Set(['host-codex', 'host-kimi', 'docker-pi', 'k8s-pi']);
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_TEXT_LIMIT = 16 * 1024;
const DIAGNOSTIC_JSON_LIMIT = 32 * 1024;
const DIAGNOSTIC_JSON_LINE_LIMIT = 4 * 1024;
const DIAGNOSTIC_JSON_MAX_LINES = 24;
const DIAGNOSTIC_FILE_HASH_LIMIT = 256 * 1024;
const LOCAL_PROOF_FILE_LIMIT = 1024 * 1024;
const HOST_AGENT_RUNNER_OPTION = '--internal-host-agent-runner';
const HOST_AGENT_CHILD_SELF_TEST_OPTION = '--internal-host-agent-child-self-test';
const HOST_AGENT_RUNNER_SCHEMA = 'anysentry.host_agent_runner.v1';
const HOST_AGENT_RUNNER_SELF_TEST_SCHEMA = 'anysentry.host_agent_runner.self_test.v1';
const HOST_AGENT_RUNNER_INPUT_LIMIT = 512 * 1024;
const HOST_AGENT_STOP_TIMEOUT_MS = 15_000;
const HOST_AGENT_START_TIMEOUT_MS = 15_000;
const HOST_AGENT_UNIT_SETTLE_MS = 1_000;
const POLL_MS = 500;
const FILTER_CANARY_WAIT_SECONDS = 120;
const FILTER_CANARY_MAX_RUNTIME_SECONDS = 180;
const AGENT_MAX_RUNTIME_SECONDS = 20 * 60;
const HOST_AGENT_RUNTIME_MAX_SECONDS = 4 * 60;
const COLLECTOR_MAX_RUNTIME_SECONDS = 30 * 60;
const CONTAINER_KILL_GRACE_SECONDS = 20;
const FORWARDER_SHUTDOWN_TIMEOUT_MS = 15_000;
const SUPERVISOR_SHUTDOWN_TIMEOUT_MS = 20_000;
const SUPERVISOR_COLLECTOR_TIMEOUT_MS = 4_000;
const SUPERVISOR_ESCAPE_TIMEOUT_MS = 1_000;
const COLLECTOR_TIMEOUT_KILL_SECONDS = 3;
const COLLECTOR_OUTER_GRACE_SECONDS = 30;
const HOST_AGENT_ENV_NAMES = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TZ',
  'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);
const FORWARDER_MODULES = [
  'observer-supervisor.js',
  'observer-forward.js',
  'observer-agent-attribution.js',
  'observer-attribution-merge.js',
  'observer-agent-runtime-signatures.js',
  'observer-agent-templates.js',
  'observer-docker-discovery.js',
  'observer-behavior-discovery.js',
  'observer-priority-queue.js',
  'observer-event-dedup.js',
  'observer-workload-filter.js',
  'observer-infrastructure-roots.js',
  'observer-e2e-witness.js',
];

function generatedRunId() {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return stamp + '-' + randomBytes(3).toString('hex');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-real-agent-lifecycle-e2e.mjs [options]',
    '',
    'Safety:',
    '  Default is application-non-mutating dry-run. Add --execute to create run-scoped resources.',
    '  Credential values are never accepted as arguments; use --key-file.',
    '',
    'Options:',
    '  --execute                         Run the real E2E (default: dry-run)',
    '  --self-test                       Run only local safety/contract checks',
    '  --run-id ID                       Lowercase run ID, max 28 characters',
    '  --key-file PATH                   0600 DeepSeek credential file',
    '  --artifact-dir PATH               Evidence output directory',
    '  --phases shadow,enforce            Phases to run (default: shadow)',
    '  --allow-enforce                   Permit enforce only after this run passes shadow',
    '  --allow-host-agents               Explicitly opt in to local Codex/Kimi tool execution',
    '  --allow-host-full-access          Explicitly run host Codex with danger-full-access',
    '  --agents LIST                     host-codex,host-kimi,docker-pi,k8s-pi',
    '  --require-host                    Fail instead of skipping an absent host API',
    '  --docker-api-base URL             Docker API security-center base',
    '  --host-api-base URL               Host debug API security-center base',
    '  --k8s-api-port PORT               Dedicated local port-forward port',
    '  --k8s-api-namespace NS            Namespace containing AnySentry API service',
    '  --k8s-api-service NAME            AnySentry API Service name',
    '  --k8s-workload-namespace NS       Namespace for run-scoped E2E Pods/Secret',
    '  --k8s-node NAME                   Pin collector and workload to one node',
    '  --observer-image IMAGE            Docker observer-forwarder image',
    '  --k8s-observer-image IMAGE        Kubernetes observer-forwarder image',
    '  --agent-image IMAGE               Pi runtime-lab image',
    '  --max-unexpected-agents N         Allowed new non-test roots (default: 0)',
    '  --help                            Show this text',
  ].join('\n');
}

function valueAfter(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(option + ' requires a value');
  return value;
}

function commaList(value) {
  return [...new Set(String(value).split(',').map((item) => item.trim()).filter(Boolean))];
}

function parseOptions(argv) {
  const options = {
    execute: false,
    runId: generatedRunId(),
    keyFile: DEFAULT_KEY_FILE,
    artifactDir: undefined,
    phases: ['shadow'],
    allowEnforce: false,
    allowHostAgents: false,
    allowHostFullAccess: false,
    agents: ['docker-pi', 'k8s-pi'],
    requireHost: false,
    dockerApiBase: DEFAULT_DOCKER_API,
    hostApiBase: DEFAULT_HOST_API,
    k8sApiPort: DEFAULT_K8S_PORT,
    k8sApiNamespace: 'anysentry',
    k8sApiService: 'anysentry',
    k8sWorkloadNamespace: DEFAULT_NAMESPACE,
    k8sNode: '',
    observerImage: DEFAULT_OBSERVER_IMAGE,
    k8sObserverImage: DEFAULT_K8S_OBSERVER_IMAGE,
    agentImage: DEFAULT_AGENT_IMAGE,
    maxUnexpectedAgents: 0,
    help: false,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--allow-enforce') options.allowEnforce = true;
    else if (arg === '--allow-host-agents') options.allowHostAgents = true;
    else if (arg === '--allow-host-full-access') options.allowHostFullAccess = true;
    else if (arg === '--require-host') options.requireHost = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--run-id') options.runId = valueAfter(argv, index++, arg);
    else if (arg === '--key-file') options.keyFile = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--artifact-dir') options.artifactDir = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--phases') options.phases = commaList(valueAfter(argv, index++, arg));
    else if (arg === '--agents') options.agents = commaList(valueAfter(argv, index++, arg));
    else if (arg === '--docker-api-base') options.dockerApiBase = valueAfter(argv, index++, arg);
    else if (arg === '--host-api-base') options.hostApiBase = valueAfter(argv, index++, arg);
    else if (arg === '--k8s-api-port') options.k8sApiPort = Number(valueAfter(argv, index++, arg));
    else if (arg === '--k8s-api-namespace') options.k8sApiNamespace = valueAfter(argv, index++, arg);
    else if (arg === '--k8s-api-service') options.k8sApiService = valueAfter(argv, index++, arg);
    else if (arg === '--k8s-workload-namespace') options.k8sWorkloadNamespace = valueAfter(argv, index++, arg);
    else if (arg === '--k8s-node') options.k8sNode = valueAfter(argv, index++, arg);
    else if (arg === '--observer-image') options.observerImage = valueAfter(argv, index++, arg);
    else if (arg === '--k8s-observer-image') options.k8sObserverImage = valueAfter(argv, index++, arg);
    else if (arg === '--agent-image') options.agentImage = valueAfter(argv, index++, arg);
    else if (arg === '--max-unexpected-agents') options.maxUnexpectedAgents = Number(valueAfter(argv, index++, arg));
    else throw new Error('unknown option: ' + arg);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?$/.test(options.runId)) {
    throw new Error('--run-id must be lowercase alphanumeric/hyphen and at most 28 characters');
  }
  if (!options.phases.length || options.phases.some((phase) => !ALLOWED_PHASES.has(phase))) {
    throw new Error('--phases must contain shadow and/or enforce');
  }
  if (options.phases.includes('enforce') && !options.allowEnforce) {
    throw new Error('--phases enforce requires the explicit --allow-enforce safety gate');
  }
  if (options.phases.includes('enforce') && !options.phases.includes('shadow')) {
    throw new Error('enforce cannot run alone; include shadow first in the same execution');
  }
  if (options.phases.includes('enforce') && options.phases[0] !== 'shadow') {
    throw new Error('shadow must be the first phase before enforce');
  }
  if (!options.agents.length || options.agents.some((agent) => !ALLOWED_AGENTS.has(agent))) {
    throw new Error('--agents contains an unsupported Agent kind');
  }
  if (options.allowHostFullAccess && !options.allowHostAgents) {
    throw new Error('--allow-host-full-access also requires the explicit --allow-host-agents safety gate');
  }
  if (options.allowHostFullAccess && !options.agents.includes('host-codex')) {
    throw new Error('--allow-host-full-access is valid only when --agents includes host-codex');
  }
  if (options.execute && options.agents.some((agent) => agent.startsWith('host-')) && !options.allowHostAgents) {
    throw new Error('host Agent execution requires the explicit --allow-host-agents safety gate');
  }
  if (!Number.isInteger(options.k8sApiPort) || options.k8sApiPort < 1024 || options.k8sApiPort > 65535) {
    throw new Error('--k8s-api-port must be an integer from 1024 through 65535');
  }
  if (!Number.isInteger(options.maxUnexpectedAgents) || options.maxUnexpectedAgents < 0) {
    throw new Error('--max-unexpected-agents must be a non-negative integer');
  }
  for (const [name, value] of [
    ['--k8s-api-namespace', options.k8sApiNamespace],
    ['--k8s-api-service', options.k8sApiService],
    ['--k8s-workload-namespace', options.k8sWorkloadNamespace],
  ]) {
    if (!/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value)) throw new Error(name + ' is not a safe Kubernetes name');
  }
  options.dockerApiBase = normalizeApiBase(options.dockerApiBase);
  options.hostApiBase = normalizeApiBase(options.hostApiBase);
  options.k8sApiBase = normalizeApiBase('http://127.0.0.1:' + options.k8sApiPort + '/security-center');
  options.artifactDir = options.artifactDir ||
    path.join(repoRoot, 'artifacts', 'real-agent-lifecycle-e2e', options.runId);
  return options;
}

function hostCodexSandboxMode(options) {
  return options.allowHostFullAccess ? 'danger-full-access' : 'workspace-write';
}

function normalizeApiBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API URL must use http or https');
  if (url.username || url.password) throw new Error('API URL must not contain user-info credentials');
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/security-center')) {
    throw new Error('API base must end in /security-center: ' + url.toString());
  }
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function k8sName(options, ...parts) {
  const value = ['asel', options.runId, ...parts]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (value.length <= 63) return value;
  const suffix = createHash('sha256').update(value).digest('hex').slice(0, 8);
  return value.slice(0, 54).replace(/-+$/g, '') + '-' + suffix;
}

function collectorId(options, environment, phase) {
  return k8sName(options, 'collector', environment, phase);
}

function marker(options, environment, phase, agent) {
  return ['asel-marker', options.runId, environment, phase, agent]
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-');
}

function redact(value) {
  return String(value ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|credentials?)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/("(?:api[_-]?key|token|secret|password|credentials?|authorization|proxy-authorization|cookie|set-cookie)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
}

function sanitized(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      /(?:key|token|secret|password|credential|authorization|cookie)/i.test(key)
        ? '<redacted>'
        : sanitized(nested),
    ]));
  }
  return value;
}

function diagnosticSanitized(value, depth = 0) {
  if (depth >= 32) return '<redacted-max-depth>';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, 256).map((nested) => diagnosticSanitized(nested, depth + 1));
    if (value.length > items.length) items.push('<truncated-items>');
    return items;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).slice(0, 256).map(([key, nested]) => [
      key,
      /(?:key|token|secret|password|credential|authorization|cookie)/i.test(key)
        ? '<redacted>'
        : diagnosticSanitized(nested, depth + 1),
    ]);
    if (Object.keys(value).length > entries.length) entries.push(['<truncated>', true]);
    return Object.fromEntries(entries);
  }
  return value;
}

function redactStructuredText(value) {
  return String(value ?? '').split(/(\r?\n)/u).map((part) => {
    if (/^\r?\n$/u.test(part) || !part.trim()) return part;
    try {
      return JSON.stringify(diagnosticSanitized(JSON.parse(part)));
    } catch {
      return redact(part);
    }
  }).join('');
}

function boundedRedactedText(value, limit = DIAGNOSTIC_TEXT_LIMIT) {
  assert.ok(Number.isInteger(limit) && limit > 0, 'diagnostic text limit must be positive');
  const source = String(value ?? '');
  const safe = redactStructuredText(source);
  const bytes = Buffer.from(safe, 'utf8');
  let start = Math.max(0, bytes.length - limit);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  const tail = bytes.subarray(start).toString('utf8');
  return {
    capturedBytes: Buffer.byteLength(source),
    sha256: hashText(safe),
    truncated: start > 0,
    tail,
  };
}

function boundedCodexJsonLines(value) {
  const source = String(value ?? '');
  const lines = source.split(/\r?\n/u).filter((line) => line.trim());
  const kept = [];
  let remaining = DIAGNOSTIC_JSON_LIMIT;
  let parseableTailLines = 0;
  for (let index = lines.length - 1; index >= 0 && kept.length < DIAGNOSTIC_JSON_MAX_LINES && remaining > 0; index -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    parseableTailLines += 1;
    const serialized = JSON.stringify(diagnosticSanitized(parsed));
    const bounded = boundedRedactedText(serialized, Math.min(DIAGNOSTIC_JSON_LINE_LIMIT, remaining));
    const bytes = Buffer.byteLength(bounded.tail);
    if (bytes === 0) continue;
    kept.push({ truncated: bounded.truncated, json: bounded.tail });
    remaining -= bytes;
  }
  kept.reverse();
  return {
    format: 'codex-jsonl',
    observedLines: lines.length,
    returnedLines: kept.length,
    parseableTailLines,
    truncated: kept.length < lines.length || kept.some((line) => line.truncated),
    lines: kept,
  };
}

function appendBounded(current, chunk) {
  const next = current + chunk;
  return next.length <= CAPTURE_LIMIT ? next : next.slice(next.length - CAPTURE_LIMIT);
}

function run(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.inheritEnv === false
        ? { ...(options.env || {}) }
        : options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { code, signal, stdout, stderr, durationMs: Date.now() - startedAt };
      if (code === 0 || options.allowFailure) resolve(result);
      else reject(new Error(
        command + ' failed (' + (signal || code) + '): ' + redact(stderr.slice(-2_000)),
      ));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function spawnCaptured(command, args, options = {}) {
  const startedAt = Date.now();
  const hasInput = options.input !== undefined;
  const input = hasInput
    ? Buffer.isBuffer(options.input) ? options.input : Buffer.from(String(options.input), 'utf8')
    : undefined;
  let inputErased = false;
  const eraseInput = () => {
    if (!inputErased && options.eraseInput === true && input) input.fill(0);
    inputErased = true;
  };
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.inheritEnv === false
      ? { ...(options.env || {}) }
      : options.env ? { ...process.env, ...options.env } : process.env,
    detached: options.detached === true,
    stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const record = {
    child,
    command,
    stdout: '',
    stderr: '',
    startedAt,
    detached: options.detached === true,
    finished: false,
  };
  ledger.children.add(record);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record.stdout = appendBounded(record.stdout, chunk); });
  child.stderr.on('data', (chunk) => { record.stderr = appendBounded(record.stderr, chunk); });
  if (hasInput) {
    child.stdin.on('error', eraseInput);
    child.stdin.end(input, eraseInput);
  }
  record.done = new Promise((resolve, reject) => {
    child.once('error', (error) => {
      eraseInput();
      record.finished = true;
      ledger.children.delete(record);
      reject(error);
    });
    child.once('close', (code, signal) => {
      eraseInput();
      record.finished = true;
      ledger.children.delete(record);
      resolve({
        code,
        signal,
        stdout: record.stdout,
        stderr: record.stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
  return record;
}

async function reapCapturedProcess(record, signal = 'SIGTERM') {
  if (record.finished || !record.child.pid) return;
  try {
    if (record.detached) process.kill(-record.child.pid, signal);
    record.child.kill(signal);
  } catch {
    try { record.child.kill(signal); } catch {}
  }
  let stopTimer;
  const stopped = await Promise.race([
    record.done.then(() => true, () => true),
    new Promise((resolve) => { stopTimer = setTimeout(() => resolve(false), 3_000); }),
  ]);
  clearTimeout(stopTimer);
  if (stopped) return;
  try {
    if (record.detached) process.kill(-record.child.pid, 'SIGKILL');
    record.child.kill('SIGKILL');
  } catch {
    try { record.child.kill('SIGKILL'); } catch {}
  }
  let killTimer;
  const killed = await Promise.race([
    record.done.then(() => true, () => true),
    new Promise((resolve) => { killTimer = setTimeout(() => resolve(false), 2_000); }),
  ]);
  clearTimeout(killTimer);
  if (!killed) throw new Error('child process did not terminate: ' + record.command);
}

async function terminateProcess(record, signal = 'SIGTERM') {
  if (!record) return;
  if (record.systemdUnitName && ledger.systemdUnits.has(record.systemdUnitName)) {
    await stopTrackedSystemdUnit(record.systemdUnitName, true);
  }
  await reapCapturedProcess(record, signal);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function hostAgentEnvironmentNameAllowed(name) {
  return HOST_AGENT_ENV_NAMES.has(name) || /^LC_[A-Za-z0-9_]+$/u.test(name);
}

function sameStringRecord(actual, expected) {
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  return actualNames.length === expectedNames.length &&
    actualNames.every((name, index) => name === expectedNames[index] && actual[name] === expected[name]);
}

function validateHostAgentRunnerPayload(value, expected = {}) {
  if (!plainObject(value)) throw new Error('host Agent runner payload must be an object');
  const allowed = new Set(['schema', 'agent', 'command', 'args', 'cwd', 'env']);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error('host Agent runner payload contains unsupported fields');
  if (typeof value.command !== 'string' || !path.isAbsolute(value.command) ||
      path.normalize(value.command) !== value.command || value.command.length > 4_096 || value.command.includes('\0')) {
    throw new Error('host Agent runner command is invalid');
  }
  if (!Array.isArray(value.args) || value.args.length > 256 || value.args.some((item) =>
    typeof item !== 'string' || item.length > 128 * 1024 || item.includes('\0'))) {
    throw new Error('host Agent runner arguments are invalid');
  }
  if (typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd) || value.cwd.length > 4_096 || value.cwd.includes('\0')) {
    throw new Error('host Agent runner working directory is invalid');
  }
  if (!plainObject(value.env) || Object.keys(value.env).length > 256) {
    throw new Error('host Agent runner environment is invalid');
  }
  for (const [name, nested] of Object.entries(value.env)) {
    const productionEnvironment = value.schema === HOST_AGENT_RUNNER_SCHEMA;
    const selfTestEnvironment = value.schema === HOST_AGENT_RUNNER_SELF_TEST_SCHEMA &&
      (name === 'PATH' || name === 'ANYSENTRY_HOST_RUNNER_SELF_TEST');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
        /^(?:LD_|NODE_OPTIONS$|BASH_ENV$)/u.test(name) ||
        /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK)/iu.test(name) ||
        !(productionEnvironment ? hostAgentEnvironmentNameAllowed(name) : selfTestEnvironment) ||
        typeof nested !== 'string' || nested.length > 128 * 1024 || nested.includes('\0')) {
      throw new Error('host Agent runner environment contains an invalid entry');
    }
  }
  const productionCommands = new Map([
    ['host-codex', 'codex'],
    ['host-kimi', 'kimi'],
  ]);
  if (value.schema === HOST_AGENT_RUNNER_SCHEMA) {
    if (!productionCommands.has(value.agent) || productionCommands.get(value.agent) !== path.basename(value.command)) {
      throw new Error('host Agent runner production command is not allowlisted');
    }
  } else if (value.schema === HOST_AGENT_RUNNER_SELF_TEST_SCHEMA) {
    const validSelfTest = value.agent === 'self-test' &&
      value.command === process.execPath &&
      value.args.length === 3 &&
      value.args[0] === scriptPath &&
      value.args[1] === HOST_AGENT_CHILD_SELF_TEST_OPTION &&
      /^[a-f0-9]{32}$/u.test(value.args[2]);
    if (!validSelfTest) throw new Error('host Agent runner self-test command is invalid');
  } else {
    throw new Error('host Agent runner schema is unsupported');
  }
  if (expected.agent && value.agent !== expected.agent) {
    throw new Error('host Agent runner agent differs from the launch contract');
  }
  if (expected.command && value.command !== expected.command) {
    throw new Error('host Agent runner command differs from the preflight-pinned executable');
  }
  if (expected.env && !sameStringRecord(value.env, expected.env)) {
    throw new Error('host Agent runner environment differs from the filtered launch environment');
  }
  return {
    schema: value.schema,
    agent: value.agent,
    command: value.command,
    args: [...value.args],
    cwd: value.cwd,
    env: { ...value.env },
  };
}

function encodeHostAgentRunnerPayload(value, expected = {}) {
  const payload = validateHostAgentRunnerPayload(value, expected);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  if (encoded.length > HOST_AGENT_RUNNER_INPUT_LIMIT) {
    encoded.fill(0);
    throw new Error('host Agent runner payload exceeds the input limit');
  }
  return encoded;
}

async function readHostAgentRunnerPayload() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > HOST_AGENT_RUNNER_INPUT_LIMIT) {
      for (const item of chunks) item.fill(0);
      buffer.fill(0);
      throw new Error('host Agent runner input exceeds the limit');
    }
    chunks.push(buffer);
  }
  const encoded = Buffer.concat(chunks, size);
  for (const item of chunks) item.fill(0);
  try {
    return validateHostAgentRunnerPayload(JSON.parse(encoded.toString('utf8')));
  } finally {
    encoded.fill(0);
  }
}

async function runHostAgentRunner() {
  const payload = await readHostAgentRunnerPayload();
  const child = spawn(payload.command, payload.args, {
    cwd: payload.cwd,
    env: payload.env,
    stdio: 'inherit',
    shell: false,
  });
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      try { child.kill(signal); } catch {}
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = Number.isInteger(result.code)
      ? result.code
      : result.signal ? 128 + (os.constants.signals[result.signal] || 1) : 1;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }
}

async function runHostAgentChildSelfTest() {
  assert.match(process.argv[3] || '', /^[a-f0-9]{32}$/u, 'host Agent child self-test nonce is invalid');
  console.log(JSON.stringify({ hostAgentChildSelfTest: true, pid: process.pid }));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 60_000);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function eventually(label, check, timeoutMs = 90_000, intervalMs = POLL_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    if (ledger.aborting) throw new Error('execution interrupted while waiting for ' + label);
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await delay(intervalMs);
  }
  throw new Error(label + ' did not converge: ' +
    (last instanceof Error ? redact(last.message) : redact(JSON.stringify(last))));
}

async function requestJson(baseUrl, route, body, options = {}) {
  const url = baseUrl + '/' + route.replace(/^\/+/, '');
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(route + ' returned HTTP ' + response.status + ': ' + redact(text.slice(0, 500)));
    error.status = response.status;
    throw error;
  }
  const parsed = text ? JSON.parse(text) : undefined;
  return parsed?.data ?? parsed;
}

function responseAllowsPost(response) {
  if (!response?.ok) return false;
  const allowed = ['allow', 'access-control-allow-methods']
    .flatMap((name) => String(response.headers?.get(name) || '').split(','))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
  return allowed.includes('POST');
}

async function supportsPostRoute(baseUrl, route) {
  const url = baseUrl + '/' + route.replace(/^\/+/, '');
  try {
    const response = await fetch(url, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(5_000),
    });
    return responseAllowsPost(response);
  } catch {
    return false;
  }
}

async function apiCapability(baseUrl, queryShape = false) {
  const result = {
    baseUrl,
    health: false,
    runtime: false,
    lease: false,
    identity: undefined,
    errors: [],
  };
  try {
    await requestJson(baseUrl, 'healthz', undefined, { timeoutMs: 5_000 });
    result.health = true;
  } catch (error) {
    result.errors.push('healthz: ' + redact(error.message));
  }
  if (result.health) {
    if (queryShape) {
      try {
        const runtime = await requestJson(baseUrl, 'runtime/instances', { limit: 1, includeShadow: true });
        result.runtime = Array.isArray(runtime?.items);
        if (!result.runtime) result.errors.push('runtime/instances returned an unexpected shape');
      } catch {
        result.errors.push('runtime/instances: ' + redact(error.message));
      }
    } else {
      result.runtime = await supportsPostRoute(baseUrl, 'runtime/instances');
      if (!result.runtime) result.errors.push('runtime/instances POST route is unavailable');
    }
    result.lease = await supportsPostRoute(baseUrl, 'runtime/lease');
    if (!result.lease) result.errors.push('runtime/lease POST route is unavailable');
    result.snapshot = await supportsPostRoute(baseUrl, 'runtime/snapshot');
    if (!result.snapshot) result.errors.push('runtime/snapshot POST route is unavailable');
    try {
      const identity = await requestJson(baseUrl, 'identity/snapshot');
      result.identity = {
        ready: identity?.ready === true,
        errors: Number(identity?.errors) || 0,
        entries: Array.isArray(identity?.entries) ? identity.entries.length : 0,
        version: Number(identity?.version) || 0,
      };
    } catch (error) {
      result.errors.push('identity/snapshot: ' + redact(error.message));
    }
  }
  return result;
}

function hashText(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function hashLocalFile(file) {
  const content = await fs.readFile(file);
  return { bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}

function matchesFileFingerprint(stat, expected) {
  return Boolean(expected) &&
    String(stat.dev) === expected.dev && String(stat.ino) === expected.ino &&
    stat.uid === expected.uid && stat.mode === expected.mode && stat.size === expected.size;
}

async function stageCredentialFile(options, expected) {
  const handle = await fs.open(options.keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let credential;
  try {
    const before = await handle.stat();
    if (!matchesFileFingerprint(before, expected)) {
      throw new Error('DeepSeek key file identity changed after preflight');
    }
    credential = await handle.readFile();
    const after = await handle.stat();
    if (!matchesFileFingerprint(after, expected) || credential.length !== expected.size) {
      throw new Error('DeepSeek key file changed while creating the run-owned copy');
    }
  } finally {
    await handle.close();
  }
  const destination = path.join(ledger.tempRoot, 'deepseek-api-key');
  try {
    await fs.writeFile(destination, credential, { mode: 0o600, flag: 'wx' });
  } finally {
    credential?.fill(0);
  }
  ledger.tempCredential = {
    path: destination,
    identity: localPathIdentity(await fs.lstat(destination)),
  };
  return destination;
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port }, () => {
      server.close(() => resolve(true));
    });
  });
}

const ledger = {
  runId: '',
  dockerContainers: new Map(),
  k8sPods: new Map(),
  k8sSecrets: new Map(),
  systemdUnits: new Map(),
  children: new Set(),
  mutations: new Set(),
  tempRoot: '',
  portForward: undefined,
  hostApi: undefined,
  cleaning: false,
  aborting: false,
  cleanupPromise: undefined,
  tempRootIdentity: undefined,
  tempCredential: undefined,
  transientDirectories: new Map(),
  artifactRoot: '',
  artifactRootIdentity: undefined,
};

function trackMutation(operation) {
  if (ledger.cleaning) throw new Error('refused to mutate while cleanup is running');
  const tracked = Promise.resolve().then(operation);
  ledger.mutations.add(tracked);
  tracked.then(
    () => ledger.mutations.delete(tracked),
    () => ledger.mutations.delete(tracked),
  );
  return tracked;
}

function ownershipNonce() {
  return randomBytes(16).toString('hex');
}

function hostAgentUnitName(options, phase, agent) {
  return k8sName(options, 'host-agent', phase, agent) + '.service';
}

function hostAgentUnitDescription(runId, nonce) {
  return 'AnySentry-E2E:' + runId + ':' + nonce;
}

function rememberK8s(map, namespace, name, ownership) {
  if (!map.has(namespace)) map.set(namespace, new Map());
  map.get(namespace).set(name, ownership);
}

function forgetK8s(map, namespace, name) {
  map.get(namespace)?.delete(name);
}

function localPathIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: stat.mode,
    directory: stat.isDirectory(),
    file: stat.isFile(),
  };
}

function sameLocalPathIdentity(actual, expected) {
  return Boolean(expected) && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.mode === expected.mode && actual.directory === expected.directory && actual.file === expected.file;
}

async function localPathState(target) {
  try {
    return { exists: true, identity: localPathIdentity(await fs.lstat(target)) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw error;
  }
}

async function diagnosticFileState(workspace, name, includeHash = false) {
  assert.equal(path.basename(name), name, 'diagnostic file name must be a basename');
  const target = path.join(workspace, name);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: false, error: redact(error?.code || error?.message || error) };
  }
  const state = {
    exists: true,
    bytes: stat.size,
    mode: (stat.mode & 0o777).toString(8),
    regularFile: stat.isFile() && !stat.isSymbolicLink(),
    symbolicLink: stat.isSymbolicLink(),
  };
  if (!includeHash || !state.regularFile) return state;
  if (stat.size > DIAGNOSTIC_FILE_HASH_LIMIT) {
    return { ...state, hashSkipped: 'file_exceeds_' + DIAGNOSTIC_FILE_HASH_LIMIT + '_bytes' };
  }
  let handle;
  try {
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size ||
        opened.mtimeMs !== stat.mtimeMs || opened.ctimeMs !== stat.ctimeMs || !opened.isFile()) {
      return { ...state, hashSkipped: 'file_identity_changed' };
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || content.length !== opened.size) {
      return { ...state, hashSkipped: 'file_changed_while_reading' };
    }
    return { ...state, sha256: createHash('sha256').update(content).digest('hex') };
  } catch (error) {
    return { ...state, hashSkipped: redact(error?.code || error?.message || error) };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function createTrackedTransientDirectory(prefix) {
  return await trackMutation(async () => {
    const workspace = await fs.mkdtemp(prefix);
    const resolved = path.resolve(workspace);
    const state = await localPathState(resolved);
    if (!state.exists || !state.identity.directory) {
      throw new Error('transient directory was not created as a real directory');
    }
    ledger.transientDirectories.set(resolved, state.identity);
    return resolved;
  });
}

async function removeTrackedTransientDirectory(target, allowAlreadyAbsent = false) {
  const resolved = path.resolve(target);
  const requiredPrefix = path.join(os.tmpdir(), 'anysentry-codex-sandbox-probe-');
  if (!resolved.startsWith(requiredPrefix)) {
    throw new Error('refused to remove unexpected sandbox probe path: ' + resolved);
  }
  const expected = ledger.transientDirectories.get(resolved);
  if (!expected) {
    if (allowAlreadyAbsent) return;
    throw new Error('sandbox probe directory is not tracked: ' + resolved);
  }
  const state = await localPathState(resolved);
  if (!state.exists) {
    if (!allowAlreadyAbsent) throw new Error('sandbox probe directory disappeared before cleanup');
    ledger.transientDirectories.delete(resolved);
    return;
  }
  if (!state.identity.directory || !sameLocalPathIdentity(state.identity, expected)) {
    throw new Error('refused to remove sandbox probe directory after its identity changed');
  }
  await fs.rm(resolved, { recursive: true });
  if ((await localPathState(resolved)).exists) {
    throw new Error('sandbox probe directory remained after cleanup');
  }
  ledger.transientDirectories.delete(resolved);
}

async function probeHostCodexWorkspaceSandbox() {
  const prefix = path.join(os.tmpdir(), 'anysentry-codex-sandbox-probe-');
  let workspace;
  let outcome;
  try {
    workspace = await createTrackedTransientDirectory(prefix);
    if (ledger.cleaning || ledger.aborting) throw new Error('sandbox probe interrupted before launch');
    const record = spawnCaptured(
      'codex',
      ['sandbox', '--permission-profile', ':workspace', '-C', workspace, '--', '/bin/true'],
      { env: hostAgentEnvironment(), inheritEnv: false },
    );
    let timedOut = false;
    let probeTimer;
    let result;
    try {
      result = await Promise.race([
        record.done,
        new Promise((resolve) => { probeTimer = setTimeout(() => resolve(undefined), 15_000); }),
      ]);
    } finally {
      clearTimeout(probeTimer);
    }
    if (!result) {
      timedOut = true;
      await terminateProcess(record);
      result = await record.done;
    }
    outcome = {
      code: timedOut ? null : result.code,
      signal: result.signal,
      durationMs: result.durationMs,
      stdout: boundedRedactedText(result.stdout, 1_024),
      stderr: boundedRedactedText(result.stderr, 1_024),
      ...(timedOut ? { error: boundedRedactedText('sandbox probe timed out after 15000ms', 1_024) } : {}),
    };
  } catch (error) {
    outcome = {
      code: null,
      error: boundedRedactedText(error?.message || error, 1_024),
    };
  }
  if (workspace && !ledger.cleaning) {
    try {
      await trackMutation(() => removeTrackedTransientDirectory(workspace, true));
    } catch (error) {
      if (ledger.cleaning) return outcome;
      return {
        ...outcome,
        code: null,
        cleanupError: boundedRedactedText(error?.message || error, 1_024),
      };
    }
  }
  return outcome;
}

function dockerInspectSaysMissing(result) {
  return /no such (?:object|container)|not found/u.test(String(result.stderr || '').toLowerCase());
}

async function dockerResourceState(reference, runId, ownership) {
  if (!reference) return { exists: false };
  const inspected = await run(
    'docker',
    [
      'inspect', '--format',
      '{{.Id}}\n{{index .Config.Labels "anysentry.e2e.run-id"}}\n{{index .Config.Labels "anysentry.e2e.ownership"}}\n{{.State.Running}}',
      reference,
    ],
    { allowFailure: true },
  );
  if (inspected.code !== 0) {
    if (dockerInspectSaysMissing(inspected)) return { exists: false };
    throw new Error('Docker inspect failed for ' + reference + ': ' + redact(inspected.stderr));
  }
  const [id, observedRunId, nonce, running] = inspected.stdout.trim().split(/\r?\n/u);
  if (!/^[a-f0-9]{64}$/u.test(id || '')) {
    throw new Error('Docker inspect returned an invalid resource ID for ' + reference);
  }
  const sameId = !ownership?.id || id === ownership.id;
  return {
    exists: true,
    id,
    observedRunId,
    nonce,
    running: running === 'true',
    sameId,
    owned: Boolean(ownership?.nonce) && sameId && observedRunId === runId && nonce === ownership.nonce,
  };
}

async function dockerResourceOwned(name, runId, ownership) {
  if (!ownership?.nonce) return false;
  const state = await dockerResourceState(name, runId, ownership);
  return state.exists && state.owned;
}

async function waitForOwnedDockerContainerStopped(name, timeoutMs = 5_000) {
  const ownership = ledger.dockerContainers.get(name);
  if (!ownership?.nonce) throw new Error('missing tracked Docker ownership: ' + name);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await dockerResourceState(ownership.id || name, ledger.runId, ownership);
    if (!state.exists) return true;
    if (!state.owned) throw new Error('Docker container ownership changed while waiting for exit: ' + name);
    ownership.id ||= state.id;
    if (!state.running) return true;
    await delay(100);
  }
  return false;
}

function k8sGetSaysMissing(result) {
  return /error from server \(notfound\)|\bnot found\b/u.test(String(result.stderr || '').toLowerCase());
}

async function k8sResourceState(kind, namespace, name, runId, ownership) {
  const result = await run(
    'kubectl',
    [
      '-n', namespace, 'get', kind, name, '-o',
      'go-template={{.metadata.uid}}{{"\\n"}}{{index .metadata.labels "anysentry.io/e2e-run-id"}}{{"\\n"}}{{index .metadata.labels "anysentry.io/e2e-ownership"}}',
    ],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    if (k8sGetSaysMissing(result)) return { exists: false };
    throw new Error('kubectl get failed for ' + kind + ' ' + namespace + '/' + name + ': ' + redact(result.stderr));
  }
  const [uid, observedRunId, nonce] = result.stdout.trim().split(/\r?\n/u);
  if (!uid) throw new Error('kubectl returned an empty UID for ' + kind + ' ' + namespace + '/' + name);
  const sameUid = !ownership?.uid || uid === ownership.uid;
  return {
    exists: true,
    uid,
    observedRunId,
    nonce,
    sameUid,
    owned: Boolean(ownership?.nonce) && sameUid && observedRunId === runId && nonce === ownership.nonce,
  };
}

async function k8sResourceOwned(kind, namespace, name, runId, ownership) {
  if (!ownership?.nonce) return false;
  const state = await k8sResourceState(kind, namespace, name, runId, ownership);
  return state.exists && state.owned;
}

function parseSystemdShow(value) {
  return Object.fromEntries(String(value).split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function systemdUnitState(name, ownership) {
  if (!/^[a-z0-9][a-z0-9.-]{0,200}\.service$/u.test(name)) {
    throw new Error('refused to inspect an unsafe systemd unit name: ' + name);
  }
  const result = await run('systemctl', [
    '--user', 'show', name, '--no-pager',
    '--property=Id', '--property=LoadState', '--property=ActiveState', '--property=SubState',
    '--property=InvocationID', '--property=Description', '--property=ExecMainPID', '--property=Result',
    '--property=ControlGroup',
  ], { allowFailure: true, timeoutMs: 10_000 });
  if (result.code !== 0) {
    throw new Error('systemctl show failed for ' + name + ': ' + redact(result.stderr));
  }
  const fields = parseSystemdShow(result.stdout);
  const exists = fields.LoadState !== 'not-found';
  const invocationId = fields.InvocationID || undefined;
  const expectedDescription = ownership?.description;
  const sameDescription = Boolean(expectedDescription) && fields.Description === expectedDescription;
  const sameInvocation = !ownership?.invocationId || invocationId === ownership.invocationId;
  return {
    exists,
    id: fields.Id,
    loadState: fields.LoadState,
    activeState: fields.ActiveState,
    subState: fields.SubState,
    invocationId,
    description: fields.Description,
    execMainPid: positiveInteger(fields.ExecMainPID),
    controlGroup: normalizeSystemdControlGroup(fields.ControlGroup),
    result: fields.Result,
    owned: exists && fields.Id === name && sameDescription && sameInvocation,
  };
}

function normalizeSystemdControlGroup(value) {
  if (!value) return undefined;
  const normalized = path.posix.normalize(String(value));
  if (normalized !== value || !normalized.startsWith('/user.slice/') ||
      normalized.split('/').includes('..') || /[\0\r\n]/u.test(normalized) || normalized.length > 4_096) {
    throw new Error('systemd returned an unsafe user control group');
  }
  return normalized;
}

async function systemdControlGroupExists(controlGroup) {
  if (!controlGroup) return false;
  const normalized = normalizeSystemdControlGroup(controlGroup);
  try {
    await fs.lstat(path.join('/sys/fs/cgroup', normalized));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function processAncestry(startPid, maxDepth = 64) {
  const chain = [];
  const visited = new Set();
  let pid = positiveInteger(startPid);
  for (let depth = 0; pid && depth < maxDepth && !visited.has(pid); depth += 1) {
    visited.add(pid);
    let stat;
    try {
      stat = await fs.readFile('/proc/' + pid + '/stat', 'utf8');
    } catch {
      break;
    }
    const close = stat.lastIndexOf(')');
    if (close < 0) break;
    const open = stat.indexOf('(');
    const fields = stat.slice(close + 2).trim().split(/\s+/u);
    const ppid = positiveInteger(fields[1]);
    const startTime = fields[19] || '';
    chain.push({
      pid,
      ppid: ppid || 0,
      startTime,
      comm: open >= 0 ? stat.slice(open + 1, close) : '',
    });
    if (!ppid || pid === 1) break;
    pid = ppid;
  }
  return chain;
}

function processIdentityKey(record) {
  return String(record?.pid || '') + ':' + String(record?.startTime || '');
}

async function processUnifiedControlGroup(pid) {
  const value = await fs.readFile('/proc/' + pid + '/cgroup', 'utf8');
  for (const line of value.split(/\r?\n/u)) {
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;
    if (line.slice(0, first) === '0' && line.slice(first + 1, second) === '') {
      return normalizeSystemdControlGroup(line.slice(second + 1));
    }
  }
  return undefined;
}

async function processArguments(pid) {
  const value = await fs.readFile('/proc/' + pid + '/cmdline');
  return value.toString('utf8').split('\0').filter(Boolean);
}

function controlGroupContains(expected, observed) {
  return Boolean(expected && observed) && (observed === expected || observed.startsWith(expected + '/'));
}

async function assertHostServiceDetached(execMainPid, controlGroup) {
  const [controller, service] = await Promise.all([
    processAncestry(process.pid),
    processAncestry(execMainPid),
  ]);
  assert.ok(service.length > 1, 'host Agent service ancestry could not be read');
  const managerIndex = service.findIndex((record, index) => index > 0 && record.comm === 'systemd');
  assert.ok(managerIndex > 0, 'host Agent service has no user-manager boundary');
  const controllerKeys = new Set(controller
    .filter((record) => record.pid === process.pid || /^codex(?:$|-)/iu.test(record.comm))
    .map(processIdentityKey));
  const shared = service.slice(0, managerIndex)
    .filter((record) => controllerKeys.has(processIdentityKey(record)));
  assert.deepEqual(
    shared,
    [],
    'host Agent service below the user manager contains the controller or its Codex ancestor',
  );
  const [controllerControlGroup, serviceControlGroup] = await Promise.all([
    processUnifiedControlGroup(process.pid),
    processUnifiedControlGroup(execMainPid),
  ]);
  assert.equal(
    controlGroupContains(controlGroup, serviceControlGroup),
    true,
    'host Agent service main process is outside its transient unit control group',
  );
  assert.equal(
    controlGroupContains(controlGroup, controllerControlGroup),
    false,
    'E2E controller unexpectedly belongs to the host Agent transient unit control group',
  );
  return {
    execMainPid,
    parentPid: service[0]?.ppid,
    userManagerPid: service[managerIndex]?.pid,
    controllerAncestryDepth: controller.length,
    serviceAncestryDepth: service.length,
    forbiddenSharedAncestorCount: shared.length,
    controlGroup,
  };
}

function lockSystemdUnitOwnership(name, ownership, state, options = {}) {
  if (!state.exists || !state.owned) {
    throw new Error('refused to control systemd unit after ownership changed: ' + name);
  }
  if (options.requireInvocation !== false && !/^[a-f0-9]{32}$/u.test(state.invocationId || '')) {
    throw new Error('systemd unit has no valid InvocationID: ' + name);
  }
  if (ownership.invocationId && ownership.invocationId !== state.invocationId) {
    throw new Error('systemd unit InvocationID changed: ' + name);
  }
  if (/^[a-f0-9]{32}$/u.test(state.invocationId || '')) ownership.invocationId ||= state.invocationId;
  if (state.controlGroup) {
    if (ownership.controlGroup && ownership.controlGroup !== state.controlGroup) {
      throw new Error('systemd unit control group changed: ' + name);
    }
    ownership.controlGroup ||= state.controlGroup;
  }
  ownership.observed = true;
  return state;
}

async function waitForSystemdUnitGone(name, ownership, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await systemdUnitState(name, ownership);
    if (state.exists && !state.owned) {
      throw new Error('systemd unit ownership changed while waiting for cleanup: ' + name);
    }
    const cgroupExists = await systemdControlGroupExists(ownership.controlGroup);
    if (!state.exists && !cgroupExists) return true;
    await delay(100);
  }
  state ||= await systemdUnitState(name, ownership);
  return !state.exists && !(await systemdControlGroupExists(ownership.controlGroup));
}

async function stopTrackedSystemdUnit(name, allowAlreadyAbsent = false) {
  const ownership = ledger.systemdUnits.get(name);
  if (!ownership?.nonce || !ownership?.description) {
    throw new Error('missing tracked systemd unit ownership: ' + name);
  }
  if (ownership.stopPromise) return ownership.stopPromise;
  ownership.stopPromise = (async () => {
    let state = await systemdUnitState(name, ownership);
    const startDeadline = Date.now() + HOST_AGENT_START_TIMEOUT_MS;
    while (!state.exists && ownership.launcherRecord && !ownership.launcherRecord.finished &&
           !ownership.observed && Date.now() < startDeadline) {
      await delay(50);
      state = await systemdUnitState(name, ownership);
    }
    if (state.exists) {
      lockSystemdUnitOwnership(name, ownership, state, { requireInvocation: false });
      await run(
        'systemctl', ['--user', 'stop', name],
        { allowFailure: true, timeoutMs: HOST_AGENT_STOP_TIMEOUT_MS },
      );
      state = await systemdUnitState(name, ownership);
      if (state.exists && !state.owned) {
        throw new Error('refused to kill systemd unit after ownership changed: ' + name);
      }
      const cgroupStillExists = await systemdControlGroupExists(ownership.controlGroup);
      if (state.exists && (['active', 'activating', 'deactivating', 'reloading'].includes(state.activeState) ||
          cgroupStillExists)) {
        const killed = await run(
          'systemctl', ['--user', 'kill', '--kill-whom=all', '--signal=SIGKILL', name],
          { allowFailure: true, timeoutMs: 10_000 },
        );
        if (killed.code !== 0) {
          state = await systemdUnitState(name, ownership);
          if (state.exists && !state.owned) {
            throw new Error('refused to retry systemd kill after ownership changed: ' + name);
          }
          if (state.exists && state.activeState !== 'inactive') {
            throw new Error('systemctl kill failed for active owned unit ' + name + ': ' + redact(killed.stderr));
          }
        }
        await run('systemctl', ['--user', 'stop', name], { allowFailure: true, timeoutMs: 10_000 });
      }
      if (!(await waitForSystemdUnitGone(name, ownership, HOST_AGENT_STOP_TIMEOUT_MS))) {
        state = await systemdUnitState(name, ownership);
        if (state.exists && state.owned && state.activeState === 'inactive') {
          await run('systemctl', ['--user', 'reset-failed', name], { allowFailure: true, timeoutMs: 10_000 });
        }
      }
    } else {
      if (!allowAlreadyAbsent && ownership.observed) {
        throw new Error('run-owned systemd unit disappeared before cleanup: ' + name);
      }
      // Fence the exact name before reaping a still-starting systemd-run client. A late unit is
      // accepted only if its nonce-bearing Description proves that it belongs to this ledger.
      await run('systemctl', ['--user', 'stop', name], { allowFailure: true, timeoutMs: 10_000 });
    }
    if (!(await waitForSystemdUnitGone(name, ownership, HOST_AGENT_STOP_TIMEOUT_MS))) {
      throw new Error('run-owned systemd unit or control group remained after cleanup: ' + name);
    }
    if (ownership.launcherRecord && !ownership.launcherRecord.finished) {
      await reapCapturedProcess(ownership.launcherRecord);
      const settleDeadline = Date.now() + HOST_AGENT_UNIT_SETTLE_MS;
      while (Date.now() < settleDeadline) {
        state = await systemdUnitState(name, ownership);
        if (state.exists) break;
        await delay(50);
      }
      if (state?.exists) {
        lockSystemdUnitOwnership(name, ownership, state, { requireInvocation: false });
        await run('systemctl', ['--user', 'stop', name], { allowFailure: true, timeoutMs: HOST_AGENT_STOP_TIMEOUT_MS });
        if (!(await waitForSystemdUnitGone(name, ownership, HOST_AGENT_STOP_TIMEOUT_MS))) {
          throw new Error('late run-owned systemd unit remained after launcher cleanup: ' + name);
        }
      }
    }
    ledger.systemdUnits.delete(name);
  })();
  try {
    await ownership.stopPromise;
  } catch (error) {
    ownership.stopPromise = undefined;
    throw error;
  }
}

async function removeTrackedDockerContainer(name, allowAlreadyAbsent = false) {
  const ownership = ledger.dockerContainers.get(name);
  if (!ownership?.nonce) throw new Error('missing tracked Docker ownership: ' + name);
  let state = await dockerResourceState(ownership.id || name, ledger.runId, ownership);
  if (!state.exists) {
    if (!allowAlreadyAbsent) throw new Error('run-owned Docker container disappeared before removal: ' + name);
    ledger.dockerContainers.delete(name);
    return;
  }
  if (!state.owned) throw new Error('refused to remove Docker container after ownership changed: ' + name);
  ownership.id ||= state.id;
  const removed = await run('docker', ['rm', '-f', ownership.id], { allowFailure: true, timeoutMs: 30_000 });
  if (removed.code !== 0) {
    state = await dockerResourceState(ownership.id, ledger.runId, ownership);
    if (!state.exists) {
      ledger.dockerContainers.delete(name);
      return;
    }
    throw new Error('Docker removal failed for ' + name + ': ' + redact(removed.stderr || removed.stdout));
  }
  state = await dockerResourceState(ownership.id, ledger.runId, ownership);
  if (state.exists) {
    throw new Error('run-owned Docker container ID still exists after removal: ' + name + ' (' + ownership.id + ')');
  }
  ledger.dockerContainers.delete(name);
}

async function removeTrackedK8sResource(kind, namespace, name, map, allowAlreadyAbsent = false) {
  const ownership = map.get(namespace)?.get(name);
  if (!ownership?.nonce) throw new Error('missing tracked Kubernetes ownership: ' + kind + ' ' + namespace + '/' + name);
  let state = await k8sResourceState(kind, namespace, name, ledger.runId, ownership);
  if (!state.exists || (ownership.uid && !state.sameUid)) {
    if (!allowAlreadyAbsent) {
      throw new Error('run-owned Kubernetes ' + kind + ' disappeared before removal: ' + namespace + '/' + name);
    }
    forgetK8s(map, namespace, name);
    return;
  }
  if (!state.owned) {
    throw new Error('refused to delete ' + kind + ' after ownership changed: ' + namespace + '/' + name);
  }
  ownership.uid ||= state.uid;
  const removed = await run(
    'kubectl',
    [
      '-n', namespace, 'delete', kind,
      '--selector', 'anysentry.io/e2e-ownership=' + ownership.nonce,
      '--field-selector', 'metadata.name=' + name,
      '--wait=true', '--timeout=45s',
    ],
    { allowFailure: true, timeoutMs: 55_000 },
  );
  if (removed.code !== 0) {
    throw new Error('kubectl delete failed for ' + kind + ' ' + namespace + '/' + name + ': ' + redact(removed.stderr));
  }
  state = await k8sResourceState(kind, namespace, name, ledger.runId, ownership);
  if (state.exists && state.uid === ownership.uid) {
    throw new Error('run-owned Kubernetes ' + kind + ' UID still exists after deletion: ' + namespace + '/' + name + ' (' + ownership.uid + ')');
  }
  forgetK8s(map, namespace, name);
}

async function removeRunCredential(allowAlreadyAbsent = false) {
  const record = ledger.tempCredential;
  if (!record) return;
  if (!ledger.tempRoot) throw new Error('refused to remove credential without a tracked run workspace');
  const resolved = path.resolve(record.path);
  const root = path.resolve(ledger.tempRoot);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error('refused to remove credential outside the run workspace: ' + resolved);
  }
  const state = await localPathState(resolved);
  if (!state.exists) {
    if (!allowAlreadyAbsent) throw new Error('run-owned credential disappeared before removal');
    ledger.tempCredential = undefined;
    return;
  }
  if (!sameLocalPathIdentity(state.identity, record.identity) || !state.identity.file) {
    throw new Error('refused to remove credential after local file identity changed');
  }
  await fs.rm(resolved);
  if ((await localPathState(resolved)).exists) throw new Error('run-owned credential still exists after removal');
  ledger.tempCredential = undefined;
}

async function removeTempRoot() {
  if (!ledger.tempRoot) return;
  const resolved = path.resolve(ledger.tempRoot);
  const requiredPrefix = path.join(os.tmpdir(), 'anysentry-lifecycle-' + ledger.runId + '-');
  if (!resolved.startsWith(requiredPrefix)) {
    throw new Error('refused to remove unexpected temporary path: ' + resolved);
  }
  const state = await localPathState(resolved);
  if (!state.exists) {
    ledger.tempRoot = '';
    ledger.tempRootIdentity = undefined;
    return;
  }
  if (!sameLocalPathIdentity(state.identity, ledger.tempRootIdentity) || !state.identity.directory) {
    throw new Error('refused to remove temporary workspace after directory identity changed: ' + resolved);
  }
  await fs.rm(resolved, { recursive: true });
  if ((await localPathState(resolved)).exists) throw new Error('temporary workspace still exists after removal: ' + resolved);
  ledger.tempRoot = '';
  ledger.tempRootIdentity = undefined;
}

async function cleanup() {
  if (ledger.cleanupPromise) return ledger.cleanupPromise;
  ledger.cleaning = true;
  ledger.cleanupPromise = (async () => {
    const errors = [];
    let tempRootConsumersStopped = true;
    await Promise.allSettled([...ledger.mutations]);
    for (const name of [...ledger.systemdUnits.keys()]) {
      try {
        await stopTrackedSystemdUnit(name, true);
      } catch (error) {
        tempRootConsumersStopped = false;
        errors.push('systemd unit ' + name + ': ' + redact(error.message));
      }
    }
    for (const record of [...ledger.children]) {
      try { await terminateProcess(record); } catch (error) { errors.push(redact(error.message)); }
    }
    for (const directory of [...ledger.transientDirectories.keys()]) {
      try {
        await removeTrackedTransientDirectory(directory, true);
      } catch (error) {
        errors.push('sandbox probe directory ' + directory + ': ' + redact(error.message));
      }
    }
    for (const [namespace, resources] of [...ledger.k8sPods]) {
      for (const name of [...resources.keys()]) {
        try {
          await removeTrackedK8sResource('pod', namespace, name, ledger.k8sPods, true);
        } catch (error) {
          errors.push('Pod ' + namespace + '/' + name + ': ' + redact(error.message));
        }
      }
    }
    for (const [namespace, resources] of [...ledger.k8sSecrets]) {
      for (const name of [...resources.keys()]) {
        try {
          await removeTrackedK8sResource('secret', namespace, name, ledger.k8sSecrets, true);
        } catch (error) {
          errors.push('Secret ' + namespace + '/' + name + ': ' + redact(error.message));
        }
      }
    }
    for (const name of [...ledger.dockerContainers.keys()]) {
      try {
        await removeTrackedDockerContainer(name, true);
      } catch (error) {
        tempRootConsumersStopped = false;
        errors.push('container ' + name + ': ' + redact(error.message));
      }
    }
    let credentialSafeToRemoveWithRoot = true;
    if (tempRootConsumersStopped) {
      try {
        await removeRunCredential(true);
      } catch (error) {
        credentialSafeToRemoveWithRoot = false;
        errors.push('temporary credential: ' + redact(error.message));
      }
    } else {
      credentialSafeToRemoveWithRoot = false;
      errors.push('temporary workspace retained because a systemd unit or Docker container may still be using it');
    }
    if (credentialSafeToRemoveWithRoot) {
      try { await removeTempRoot(); } catch (error) {
        errors.push('temporary workspace: ' + redact(error.message));
      }
    } else if (ledger.tempRoot && tempRootConsumersStopped) {
      errors.push('temporary workspace retained because credential ownership verification failed');
    }
    if (errors.length) {
      const message = '[cleanup] ' + errors.join('; ');
      console.error(message);
      throw new AggregateError(errors.map((error) => new Error(error)), message);
    }
  })();
  return ledger.cleanupPromise;
}

async function startPortForward(options) {
  if (!(await isPortFree(options.k8sApiPort))) {
    throw new Error('dedicated Kubernetes API port is already occupied: ' + options.k8sApiPort);
  }
  const record = spawnCaptured(
    'kubectl',
    [
      '-n', options.k8sApiNamespace,
      'port-forward',
      'service/' + options.k8sApiService,
      String(options.k8sApiPort) + ':29653',
      '--address', '127.0.0.1',
    ],
  );
  ledger.portForward = record;
  await eventually('Kubernetes API port-forward', async () => {
    if (record.finished) {
      throw new Error('kubectl port-forward exited: ' + redact(record.stderr.slice(-1_000)));
    }
    if (/Forwarding from 127\.0\.0\.1:/u.test(record.stdout + record.stderr)) return true;
    return false;
  }, 20_000, 100);
  return record;
}

function check(checks, name, status, detail, extra = {}) {
  checks.push({ name, status, detail: redact(detail), ...extra });
}

async function commandAvailable(command) {
  const result = await run('which', [command], { allowFailure: true });
  return result.code === 0;
}

async function resourceAbsenceChecks(options, checks) {
  const dockerNames = [];
  for (const phase of options.phases) {
    if (options.agents.some((agent) => agent.startsWith('host-'))) {
      dockerNames.push(k8sName(options, 'collector', 'host', phase));
      dockerNames.push(k8sName(options, 'filter-canary', 'host', phase));
    }
    if (options.agents.includes('docker-pi')) {
      dockerNames.push(k8sName(options, 'collector', 'docker', phase));
      dockerNames.push(k8sName(options, 'workload', 'docker', phase));
      dockerNames.push(k8sName(options, 'filter-canary', 'docker', phase));
    }
  }
  for (const name of dockerNames) {
    const result = await run('docker', ['inspect', name], { allowFailure: true });
    check(
      checks,
      'resource absent: Docker/' + name,
      result.code === 0 ? 'block' : 'pass',
      result.code === 0 ? 'a pre-existing exact-name container would never be adopted' : 'exact name is unused',
    );
  }

  if (options.agents.includes('k8s-pi')) {
    const resources = [{ kind: 'secret', name: k8sName(options, 'deepseek') }];
    for (const phase of options.phases) {
      resources.push({ kind: 'pod', name: k8sName(options, 'collector', 'k8s', phase) });
      resources.push({ kind: 'pod', name: k8sName(options, 'workload', 'k8s', phase) });
      resources.push({ kind: 'pod', name: k8sName(options, 'filter-canary', 'k8s', phase) });
      resources.push({ kind: 'secret', name: k8sName(options, 'filter-canary', 'value', phase) });
      resources.push({ kind: 'secret', name: k8sName(options, 'pi-marker', phase) });
    }
    for (const { kind, name } of resources) {
      const result = await run(
        'kubectl',
        ['-n', options.k8sWorkloadNamespace, 'get', kind, name],
        { allowFailure: true },
      );
      check(
        checks,
        'resource absent: ' + kind + '/' + name,
        result.code === 0 ? 'block' : 'pass',
        result.code === 0 ? 'a pre-existing exact-name resource would never be adopted' : 'exact name is unused',
      );
    }
  }
}

async function systemdResourceAbsenceChecks(options, checks) {
  for (const phase of options.phases) {
    for (const agent of options.agents.filter((name) => name.startsWith('host-'))) {
      const name = hostAgentUnitName(options, phase, agent);
      let state;
      try {
        state = await systemdUnitState(name);
      } catch (error) {
        check(checks, 'resource absent: systemd/' + name, 'block', 'could not inspect exact unit name');
        continue;
      }
      check(
        checks,
        'resource absent: systemd/' + name,
        state.exists ? 'block' : 'pass',
        state.exists ? 'a pre-existing exact-name unit would never be adopted' : 'exact name is unused',
      );
    }
  }
}

async function preflight(options, apiState = {}) {
  const checks = [];
  const needsK8s = options.agents.includes('k8s-pi');
  const needsPiCredential = options.agents.includes('docker-pi') || options.agents.includes('k8s-pi');
  const hostSelected = options.agents.some((agent) => agent.startsWith('host-'));
  // Probe every independently-addressed online plane so later negative isolation assertions are
  // not limited to the selected plane. Dry-run uses GET/OPTIONS only; execute additionally checks
  // the runtime response shape (whose list operation may prune expired in-memory records).
  if (!apiState.host) apiState.host = await apiCapability(options.hostApiBase, options.execute);
  if (!apiState.docker) apiState.docker = await apiCapability(options.dockerApiBase, options.execute);
  if (needsK8s && !apiState.k8s) apiState.k8s = await apiCapability(options.k8sApiBase, options.execute);
  const hostApiReady = Boolean(
    apiState.host?.health && apiState.host?.runtime && apiState.host?.lease && apiState.host?.snapshot,
  );
  const hostWillRun = hostSelected && (hostApiReady || options.requireHost);
  const needsDocker = options.agents.includes('docker-pi') ||
    hostWillRun;

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  check(checks, 'Node.js', nodeMajor >= 22 ? 'pass' : 'block', process.version + ' (requires >=22)');
  try {
    await fs.stat(options.artifactDir);
    check(checks, 'artifact output path', 'block', 'already exists and will not be overwritten: ' + options.artifactDir);
  } catch (error) {
    check(
      checks,
      'artifact output path',
      error?.code === 'ENOENT' ? 'pass' : 'block',
      error?.code === 'ENOENT' ? 'unused: ' + options.artifactDir : 'cannot safely inspect: ' + options.artifactDir,
    );
  }

  const requiredCommands = new Set();
  requiredCommands.add('pnpm');
  if (needsDocker) requiredCommands.add('docker');
  if (needsK8s) requiredCommands.add('kubectl');
  if (hostWillRun) {
    requiredCommands.add('systemd-run');
    requiredCommands.add('systemctl');
  }
  const commandPresence = new Map();
  for (const command of requiredCommands) {
    const available = await commandAvailable(command);
    commandPresence.set(command, available);
    check(checks, 'binary: ' + command, available ? 'pass' : 'block', available ? 'present' : 'not found');
  }
  if (hostWillRun && commandPresence.get('systemd-run') && commandPresence.get('systemctl')) {
    const manager = await run('systemctl', ['--user', 'is-system-running'], {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    check(
      checks,
      'systemd user manager',
      manager.code === 0 && manager.stdout.trim() === 'running' ? 'pass' : 'block',
      manager.code === 0 ? 'running' : 'unavailable or not running',
    );
    const help = await run('systemd-run', ['--help'], { allowFailure: true, timeoutMs: 10_000 });
    const requiredFlags = [
      '--wait', '--pipe', '--collect', '--expand-environment', '--service-type', '--property', '--no-ask-password',
    ];
    const missingFlags = requiredFlags.filter((flag) => !help.stdout.includes(flag));
    check(
      checks,
      'systemd transient-service features',
      help.code === 0 && missingFlags.length === 0 ? 'pass' : 'block',
      missingFlags.length ? 'missing required options: ' + missingFlags.join(', ') : 'required options are present',
    );
  }
  apiState.hostAgentCommands ||= {};
  if (options.agents.includes('host-codex') && hostWillRun) {
    let executable;
    try {
      executable = await resolveHostAgentExecutable('host-codex', hostAgentEnvironment());
      apiState.hostAgentCommands['host-codex'] = executable;
    } catch {}
    check(checks, 'binary: codex', executable ? 'pass' : 'block', executable ? 'resolved through filtered PATH' : 'not found');
    if (executable) {
      const login = await run(executable.path, ['login', 'status'], { allowFailure: true, timeoutMs: 15_000 });
      check(
        checks,
        'Codex authentication',
        login.code === 0 && /logged in/i.test(login.stdout + login.stderr) ? 'pass' : 'block',
        login.code === 0 ? 'login status command completed' : 'login status command failed',
      );
      const sandboxMode = hostCodexSandboxMode(options);
      if (options.allowHostFullAccess) {
        apiState.hostCodexSandbox = {
          mode: sandboxMode,
          fullAccessAuthorized: true,
          workspaceProbe: 'skipped_by_explicit_full_access_authorization',
        };
        check(
          checks,
          'Host Codex sandbox',
          'warn',
          'danger-full-access was explicitly authorized; the workspace sandbox probe was skipped',
        );
      } else {
        const probe = await probeHostCodexWorkspaceSandbox();
        const passed = probe.code === 0;
        apiState.hostCodexSandbox = {
          mode: sandboxMode,
          fullAccessAuthorized: false,
          workspaceProbe: passed ? 'passed' : 'failed',
          exitCode: probe.code,
          signal: probe.signal,
        };
        const failureTail = probe.stderr?.tail || probe.stdout?.tail || probe.error?.tail || probe.cleanupError?.tail || '';
        check(
          checks,
          'Host Codex workspace sandbox',
          passed ? 'pass' : 'block',
          passed
            ? 'codex sandbox --permission-profile :workspace executed /bin/true successfully'
            : 'workspace sandbox failed; inspect AppArmor/bwrap unprivileged user-namespace policy before retrying' +
              (failureTail ? ': ' + failureTail : ''),
        );
      }
    }
  }
  if (options.agents.includes('host-kimi') && hostWillRun) {
    let executable;
    try {
      executable = await resolveHostAgentExecutable('host-kimi', hostAgentEnvironment());
      apiState.hostAgentCommands['host-kimi'] = executable;
    } catch {}
    check(checks, 'binary: kimi', executable ? 'pass' : 'block', executable ? 'resolved through filtered PATH' : 'not found');
    const configFile = path.join(os.homedir(), '.kimi', 'config.toml');
    try {
      const stat = await fs.stat(configFile);
      const exposed = stat.mode & 0o077;
      check(
        checks,
        'Kimi configuration',
        stat.size > 0 ? (exposed ? 'warn' : 'pass') : 'block',
        stat.size > 0
          ? 'configured; permission mode=' + (stat.mode & 0o777).toString(8) + (exposed ? ' (tighten if it contains credentials)' : '')
          : 'empty configuration',
      );
    } catch {
      check(checks, 'Kimi configuration', 'block', 'missing ~/.kimi/config.toml');
    }
  }

  if (needsPiCredential) {
    try {
      const stat = await fs.lstat(options.keyFile);
      const handle = await fs.open(options.keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = await handle.stat();
      await handle.close();
      const safeMode = (stat.mode & 0o077) === 0;
      const safeSize = stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512;
      const ownedByCaller = typeof process.getuid !== 'function' || stat.uid === process.getuid();
      const stableOpen = stat.dev === opened.dev && stat.ino === opened.ino;
      apiState.keyFile = {
        dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid,
        mode: stat.mode, size: stat.size,
      };
      check(
        checks,
        'DeepSeek key file',
        safeMode && safeSize && ownedByCaller && stableOpen ? 'pass' : 'block',
        'exists; bytes=' + stat.size + '; mode=' + (stat.mode & 0o777).toString(8) +
          '; regular_nonsymlink=' + safeSize + '; stable_open=' + stableOpen +
          '; owned_by_caller=' + ownedByCaller + '; value was not read',
      );
    } catch {
      check(checks, 'DeepSeek key file', 'block', 'missing or unreadable: ' + options.keyFile);
    }
  }

  if (needsDocker && commandPresence.get('docker')) {
    const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
      allowFailure: true,
      timeoutMs: 15_000,
    });
    check(checks, 'Docker daemon', info.code === 0 ? 'pass' : 'block', info.code === 0 ? 'reachable' : 'unreachable');
    apiState.dockerImages = {};
    for (const image of [options.observerImage, options.agentImage]) {
      const inspected = await run('docker', ['image', 'inspect', image], { allowFailure: true });
      let immutableId;
      if (inspected.code === 0) {
        try {
          immutableId = JSON.parse(inspected.stdout)?.[0]?.Id;
        } catch {}
      }
      const immutable = /^sha256:[a-f0-9]{64}$/u.test(immutableId || '');
      if (immutable) apiState.dockerImages[image] = immutableId;
      check(
        checks,
        'Docker image: ' + image,
        immutable ? 'pass' : 'block',
        immutable ? 'resolved immutable image ID=' + immutableId : 'missing or image ID could not be pinned',
      );
    }
  }

  if (needsK8s && commandPresence.get('kubectl')) {
    const namespace = await run(
      'kubectl',
      ['get', 'namespace', options.k8sWorkloadNamespace],
      { allowFailure: true, timeoutMs: 15_000 },
    );
    check(
      checks,
      'Kubernetes workload namespace',
      namespace.code === 0 ? 'pass' : 'block',
      namespace.code === 0 ? options.k8sWorkloadNamespace + ' exists' : 'namespace is unavailable',
    );
    for (const tuple of [
      ['create', 'pods'], ['get', 'pods'], ['delete', 'pods'], ['get', 'pods/log'], ['create', 'pods/exec'],
      ['create', 'secrets'], ['get', 'secrets'], ['delete', 'secrets'],
    ]) {
      const permission = await run(
        'kubectl',
        ['auth', 'can-i', tuple[0], tuple[1], '-n', options.k8sWorkloadNamespace],
        { allowFailure: true },
      );
      check(
        checks,
        'Kubernetes permission: ' + tuple.join(' '),
        permission.stdout.trim() === 'yes' ? 'pass' : 'block',
        permission.stdout.trim() || 'permission review failed',
      );
    }
    for (const [label, image] of [
      ['Kubernetes observer image', options.k8sObserverImage],
      ['Kubernetes Agent image', options.agentImage],
    ]) {
      check(
        checks,
        label,
        /@sha256:[a-f0-9]{64}$/u.test(image) ? 'pass' : 'block',
        /@sha256:[a-f0-9]{64}$/u.test(image)
          ? 'digest-pinned: ' + image
          : 'execute requires an immutable @sha256 digest reference, not a mutable tag',
      );
    }
  }

  for (const module of FORWARDER_MODULES) {
    try {
      const stat = await fs.stat(path.join(repoRoot, 'scripts', module));
      check(checks, 'current forwarder module: ' + module, stat.isFile() ? 'pass' : 'block', stat.isFile() ? 'present' : 'not a file');
    } catch {
      check(checks, 'current forwarder module: ' + module, 'block', 'missing');
    }
  }
  for (const testFile of [
    'scripts/verify-agent-runtime-state.mjs',
    'scripts/verify-forwarder-runtime-control.mjs',
  ]) {
    try {
      const stat = await fs.stat(path.join(repoRoot, testFile));
      check(checks, 'local protocol test: ' + testFile, stat.isFile() ? 'pass' : 'block', stat.isFile() ? 'present' : 'not a file');
    } catch {
      check(checks, 'local protocol test: ' + testFile, 'block', 'missing');
    }
  }

  if (options.agents.includes('docker-pi')) {
    const dockerApi = apiState.docker;
    apiState.docker = dockerApi;
    check(checks, 'Docker API health', dockerApi.health ? 'pass' : 'block', dockerApi.health ? 'online' : dockerApi.errors.join('; '));
    check(checks, 'Docker API lifecycle endpoints', dockerApi.runtime && dockerApi.snapshot ? 'pass' : 'block', dockerApi.runtime && dockerApi.snapshot ? 'available' : dockerApi.errors.join('; '));
    check(checks, 'Docker API runtime lease', dockerApi.lease ? 'pass' : 'block', dockerApi.lease ? 'available' : dockerApi.errors.join('; '));
  }

  if (needsK8s) {
    const k8sApi = apiState.k8s;
    apiState.k8s = k8sApi;
    check(checks, 'Kubernetes API health via dedicated port-forward', k8sApi.health ? 'pass' : 'block', k8sApi.health ? 'online' : k8sApi.errors.join('; '));
    check(checks, 'Kubernetes API lifecycle endpoints', k8sApi.runtime && k8sApi.snapshot ? 'pass' : 'block', k8sApi.runtime && k8sApi.snapshot ? 'available' : k8sApi.errors.join('; '));
    check(checks, 'Kubernetes API runtime lease', k8sApi.lease ? 'pass' : 'block', k8sApi.lease ? 'available' : k8sApi.errors.join('; '));
    check(
      checks,
      'Kubernetes identity snapshot',
      k8sApi.identity?.ready ? 'pass' : 'block',
      k8sApi.identity
        ? 'ready=' + k8sApi.identity.ready + '; errors=' + k8sApi.identity.errors + '; entries=' + k8sApi.identity.entries
        : 'identity endpoint unavailable',
    );
  }

  if (hostSelected) {
    const hostApi = apiState.host;
    apiState.host = hostApi;
    if (hostApi.health && hostApi.runtime && hostApi.lease && hostApi.snapshot) {
      check(checks, 'Host debug API', 'pass', options.hostApiBase + ' is online with lifecycle and lease endpoints');
    } else {
      check(
        checks,
        'Host debug API',
        options.requireHost || options.execute ? 'block' : 'skip',
        'offline or missing lifecycle/lease endpoints; host scenarios will be skipped',
      );
    }
  }

  const activeBases = [
    ...(hostApiReady ? [options.hostApiBase] : []),
    ...(options.agents.includes('docker-pi') ? [options.dockerApiBase] : []),
    ...(needsK8s ? [options.k8sApiBase] : []),
  ];
  check(
    checks,
    'API plane URL separation',
    new Set(activeBases).size === activeBases.length ? 'pass' : 'block',
    new Set(activeBases).size === activeBases.length
      ? 'host, Docker, and Kubernetes targets are distinct'
      : 'two selected environments resolve to the same API base',
  );

  if (needsDocker && commandPresence.get('docker')) {
    const dockerOnly = { ...options, agents: options.agents.filter((agent) => agent !== 'k8s-pi') };
    await resourceAbsenceChecks(dockerOnly, checks);
  }
  if (hostWillRun && commandPresence.get('systemctl')) {
    await systemdResourceAbsenceChecks(options, checks);
  }
  if (needsK8s && commandPresence.get('kubectl')) {
    const k8sOnly = { ...options, agents: ['k8s-pi'] };
    await resourceAbsenceChecks(k8sOnly, checks);
  }
  return {
    checks,
    blockers: checks.filter((item) => item.status === 'block'),
    warnings: checks.filter((item) => item.status === 'warn'),
    apiState,
  };
}

function plannedResources(options) {
  const resources = [];
  for (const phase of options.phases) {
    if (options.agents.some((agent) => agent.startsWith('host-'))) {
      resources.push({ plane: 'host', kind: 'Docker container', name: k8sName(options, 'collector', 'host', phase) });
      resources.push({ plane: 'host', kind: 'Docker container', name: k8sName(options, 'filter-canary', 'host', phase) });
      for (const agent of options.agents.filter((name) => name.startsWith('host-'))) {
        resources.push({ plane: 'host', kind: 'systemd user service', name: hostAgentUnitName(options, phase, agent) });
      }
    }
    if (options.agents.includes('docker-pi')) {
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'collector', 'docker', phase) });
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'workload', 'docker', phase) });
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'filter-canary', 'docker', phase) });
    }
    if (options.agents.includes('k8s-pi')) {
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'collector', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'workload', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'filter-canary', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Secret', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'filter-canary', 'value', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Secret', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'pi-marker', phase) });
    }
  }
  if (options.agents.includes('k8s-pi')) {
    resources.push({ plane: 'kubernetes', kind: 'Secret', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'deepseek') });
  }
  return resources;
}

function executionPlan(options) {
  return {
    schema: 'anysentry.real_agent_lifecycle_e2e.plan.v1',
    runId: options.runId,
    mode: options.execute ? 'execute' : 'dry-run',
    phases: options.phases,
    enforceGate: options.allowEnforce,
    agents: options.agents,
    hostAgentAuthorization: {
      enabled: options.allowHostAgents,
      codexFullAccess: options.allowHostFullAccess,
      codexSandboxMode: hostCodexSandboxMode(options),
    },
    apiPlanes: {
      host: {
        baseUrl: options.hostApiBase,
        behaviorWhenUnavailable: options.requireHost ? 'block' : 'skip',
      },
      docker: { baseUrl: options.dockerApiBase },
      kubernetes: {
        baseUrl: options.k8sApiBase,
        transport: 'dedicated kubectl port-forward',
        service: options.k8sApiNamespace + '/' + options.k8sApiService,
      },
    },
    resources: plannedResources(options),
    safety: {
      credentialInput: 'caller-owned file only',
      hostCodexFullAccessRequiresExplicitFlag: true,
      preExistingResourcesAdopted: false,
      cleanupOwnershipLabelRequired: true,
      deploymentManifestsOrExistingResourcesModified: false,
      protocolProbeWritesToApi: false,
      liveApiRunEvidencePersists: true,
      persistentApiEvidence: ['events', 'auto-discovered Source', 'heartbeats', 'bounded runtime state'],
    },
    assertions: [
      'run collector reports a positive lease epoch and successful runtime snapshots',
      'run collector reports zero rejected runtime snapshots and lease errors',
      'local protocol tests reject old lease epochs and detect duplicate snapshots',
      'new Agent instance is distinct from the collector baseline',
      'running then exited/lost lifecycle is observed with stable ProcessKey identity',
      'host runtime PID/start-time belongs to the exact nonce-fenced transient service cgroup',
      'real model run produces a tool-created marker',
      'marker event is attributed to the expected Agent instance',
      'a real unknown workload reaches L1 in shadow and is suppressed in enforce',
      'shadow and enforce counters obey their mode invariants',
      'collector ID and marker never appear in another API plane',
      'queue, output, identity, lease, and runtime-snapshot errors remain zero',
    ],
  };
}

async function writeJsonEvidence(directory, name, value) {
  assert.equal(path.basename(name), name, 'evidence file name must be a basename');
  const resolvedDirectory = path.resolve(directory);
  if (!ledger.artifactRoot || resolvedDirectory !== ledger.artifactRoot) {
    throw new Error('refused to write evidence outside the tracked artifact directory');
  }
  const directoryState = await localPathState(resolvedDirectory);
  if (!directoryState.exists || !directoryState.identity.directory ||
      !sameLocalPathIdentity(directoryState.identity, ledger.artifactRootIdentity)) {
    throw new Error('refused to write evidence after artifact directory identity changed');
  }
  const file = path.join(resolvedDirectory, name);
  const content = JSON.stringify(sanitized(value), null, 2) + '\n';
  const handle = await fs.open(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let opened;
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    opened = await handle.stat();
  } finally {
    await handle.close();
  }
  const written = await fs.lstat(file);
  if (!written.isFile() || written.isSymbolicLink() || written.size !== Buffer.byteLength(content) ||
      written.dev !== opened.dev || written.ino !== opened.ino || written.size !== opened.size ||
      (written.mode & 0o777) !== 0o600) {
    throw new Error('evidence file integrity check failed after write: ' + name);
  }
  return { file, bytes: Buffer.byteLength(content), sha256: hashText(content) };
}

async function runLocalProtocolTests() {
  const build = await run('pnpm', ['build:api'], { timeoutMs: 180_000, allowFailure: true });
  assert.equal(build.code, 0, 'API build required by runtime protocol test failed: ' + redact(build.stderr.slice(-1_000)));
  const tests = [];
  for (const file of [
    'scripts/verify-agent-runtime-state.mjs',
    'scripts/verify-forwarder-runtime-control.mjs',
  ]) {
    const result = await run('node', [file], { timeoutMs: 120_000, allowFailure: true });
    assert.equal(result.code, 0, file + ' failed: ' + redact(result.stderr.slice(-1_000)));
    tests.push({
      file,
      exitCode: result.code,
      stdout: { bytes: Buffer.byteLength(result.stdout), sha256: hashText(result.stdout) },
      stderr: { bytes: Buffer.byteLength(result.stderr), sha256: hashText(result.stderr) },
    });
  }
  return {
    mode: 'local protocol contract tests',
    writesToLiveApi: false,
    liveSyntheticCollectorCreated: false,
    covers: [
      'lease identity and fencing epoch',
      'old epoch replay rejection',
      'snapshot accepted/applied/duplicate ACK semantics',
      'forwarder stops reacquiring after it is fenced',
    ],
    build: {
      exitCode: build.code,
      stdout: { bytes: Buffer.byteLength(build.stdout), sha256: hashText(build.stdout) },
      stderr: { bytes: Buffer.byteLength(build.stderr), sha256: hashText(build.stderr) },
    },
    tests,
  };
}

function pickAck(ack) {
  return {
    accepted: ack?.accepted === true,
    applied: ack?.applied === true,
    duplicate: ack?.duplicate === true,
    leaseEpoch: ack?.leaseEpoch,
    snapshotVersion: ack?.snapshotVersion,
    instanceCount: ack?.instanceCount,
    reason: ack?.reason,
  };
}

async function queryRuntime(baseUrl, query = {}) {
  const result = await requestJson(baseUrl, 'runtime/instances', {
    includeShadow: true,
    limit: 500,
    ...query,
  });
  assert.ok(Array.isArray(result?.items), 'runtime/instances returned an unexpected shape');
  return result;
}

async function queryEvents(baseUrl, collector, search = '') {
  const result = await requestJson(baseUrl, 'events/list', {
    timeType: 'last_30d',
    collectorId: collector,
    includeBenign: true,
    scope: 'raw',
    ...(search ? { q: search } : {}),
    limit: 200,
  });
  assert.ok(Array.isArray(result?.items), 'events/list returned an unexpected shape');
  return result;
}

async function queryHeartbeat(baseUrl, collector) {
  const result = await requestJson(baseUrl, 'collectors/health', {
    timeType: 'last_30d',
    collectorId: collector,
    limit: 5,
  });
  assert.ok(Array.isArray(result?.items), 'collectors/health returned an unexpected shape');
  return result.items.find((item) => item.collectorId === collector);
}

function numericMetric(metrics, name) {
  const value = Number(metrics?.[name]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function startHeartbeatSampler(baseUrl, collector) {
  let stopping = false;
  const samples = [];
  const seen = new Set();
  const done = (async () => {
    while (!stopping) {
      try {
        const item = await queryHeartbeat(baseUrl, collector);
        const fingerprint = item?.lastHeartbeatAt
          ? heartbeatCursor(item).filterMetricsFingerprint
          : undefined;
        if (fingerprint && !seen.has(fingerprint)) {
          seen.add(fingerprint);
          samples.push(item);
        }
      } catch {}
      await delay(350);
    }
  })();
  return {
    async stop() {
      stopping = true;
      await done;
      return samples;
    },
  };
}

function aggregateHeartbeatSamples(samples, finalHeartbeat = samples.at(-1)) {
  const aggregatedSamples = [...samples];
  if (finalHeartbeat) {
    const finalFingerprint = heartbeatCursor(finalHeartbeat).filterMetricsFingerprint;
    if (!aggregatedSamples.some((item) =>
      heartbeatCursor(item).filterMetricsFingerprint === finalFingerprint)) {
      aggregatedSamples.push(finalHeartbeat);
    }
  }
  const sumFields = [
    'observed', 'forwarded', 'confirmedAgent', 'probableAgent', 'unknown', 'nonAgent',
    'filteredNonAgent', 'wouldFilterNonAgent', 'filteredNoise', 'wouldFilterNoise',
    'discoveryBudgetDropped', 'wouldDiscoveryBudgetDrop', 'queueDropped', 'batches',
    'batchEvents', 'processRootsDiscovered', 'processRootsExited', 'processRootsLost',
  ];
  const totals = Object.fromEntries(sumFields.map((field) => [field, 0]));
  const errors = {
    droppedEvents: 0,
    outputDropped: 0,
    errorCount: 0,
    queueDropped: 0,
    identityErrors: 0,
    dockerErrors: 0,
    runtimeSnapshotErrors: 0,
    runtimeSnapshotRejected: 0,
    runtimeLeaseErrors: 0,
    runtimeLeaseFenced: false,
  };
  for (const item of aggregatedSamples) {
    const metrics = item.filterMetrics || {};
    for (const field of sumFields) totals[field] += numericMetric(metrics, field);
    const maxima = item?.windowErrorMaxima;
    errors.droppedEvents = Math.max(
      errors.droppedEvents,
      numericMetric(item, 'droppedEvents'),
      numericMetric(maxima, 'droppedEvents'),
    );
    errors.outputDropped = Math.max(
      errors.outputDropped,
      numericMetric(item, 'outputDropped'),
      numericMetric(maxima, 'outputDropped'),
    );
    errors.errorCount = Math.max(
      errors.errorCount,
      numericMetric(item, 'errorCount'),
      numericMetric(maxima, 'errorCount'),
    );
    errors.queueDropped += numericMetric(metrics, 'queueDropped');
    errors.identityErrors = Math.max(errors.identityErrors, numericMetric(metrics, 'identityErrors'));
    errors.dockerErrors = Math.max(errors.dockerErrors, numericMetric(metrics, 'dockerErrors'));
    errors.runtimeSnapshotErrors = Math.max(errors.runtimeSnapshotErrors, numericMetric(metrics, 'runtimeSnapshotErrors'));
    errors.runtimeSnapshotRejected = Math.max(errors.runtimeSnapshotRejected, numericMetric(metrics, 'runtimeSnapshotRejected'));
    errors.runtimeLeaseErrors = Math.max(errors.runtimeLeaseErrors, numericMetric(metrics, 'runtimeLeaseErrors'));
    errors.runtimeLeaseFenced ||= metrics.runtimeLeaseFenced === true;
  }
  const finalMaxima = finalHeartbeat?.windowErrorMaxima;
  const windowErrorEvidence = Boolean(
    finalMaxima && ['droppedEvents', 'outputDropped', 'errorCount'].every((name) => {
      const value = finalMaxima[name];
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    }),
  );
  const finalMetrics = finalHeartbeat?.filterMetrics || {};
  if (windowErrorEvidence) {
    errors.droppedEvents = Math.max(errors.droppedEvents, finalMaxima.droppedEvents);
    errors.outputDropped = Math.max(errors.outputDropped, finalMaxima.outputDropped);
    errors.errorCount = Math.max(errors.errorCount, finalMaxima.errorCount);
  }
  errors.droppedEvents = Math.max(errors.droppedEvents, numericMetric(finalHeartbeat, 'droppedEvents'));
  errors.outputDropped = Math.max(errors.outputDropped, numericMetric(finalHeartbeat, 'outputDropped'));
  errors.errorCount = Math.max(errors.errorCount, numericMetric(finalHeartbeat, 'errorCount'));
  errors.queueDropped = Math.max(errors.queueDropped, numericMetric(finalMetrics, 'queueDropped'));
  errors.identityErrors = Math.max(errors.identityErrors, numericMetric(finalMetrics, 'identityErrors'));
  errors.dockerErrors = Math.max(errors.dockerErrors, numericMetric(finalMetrics, 'dockerErrors'));
  errors.runtimeSnapshotErrors = Math.max(errors.runtimeSnapshotErrors, numericMetric(finalMetrics, 'runtimeSnapshotErrors'));
  errors.runtimeSnapshotRejected = Math.max(errors.runtimeSnapshotRejected, numericMetric(finalMetrics, 'runtimeSnapshotRejected'));
  errors.runtimeLeaseErrors = Math.max(errors.runtimeLeaseErrors, numericMetric(finalMetrics, 'runtimeLeaseErrors'));
  errors.runtimeLeaseFenced ||= finalMetrics.runtimeLeaseFenced === true;
  return {
    count: aggregatedSamples.length,
    firstHeartbeatAt: aggregatedSamples[0]?.lastHeartbeatAt,
    lastHeartbeatAt: finalHeartbeat?.lastHeartbeatAt ?? aggregatedSamples.at(-1)?.lastHeartbeatAt,
    filterMode: finalMetrics.filterMode ?? aggregatedSamples.at(-1)?.filterMetrics?.filterMode,
    windowErrorEvidence,
    last: finalMetrics,
    totals,
    errors,
  };
}

function assertPhaseMetrics(phase, metrics, environment) {
  assert.ok(metrics.count >= 2, environment + '/' + phase + ' captured fewer than two heartbeat intervals');
  assert.equal(
    metrics.windowErrorEvidence,
    true,
    environment + '/' + phase + ' did not receive final window-stable drop/error evidence',
  );
  assert.equal(metrics.filterMode, phase, environment + ' collector reported the wrong filter mode');
  for (const [name, value] of Object.entries(metrics.errors)) {
    if (name === 'runtimeLeaseFenced') assert.equal(value, false, environment + ' forwarder was fenced');
    else assert.equal(value, 0, environment + ' reported non-zero ' + name);
  }
  if (phase === 'shadow') {
    assert.equal(metrics.totals.filteredNonAgent, 0, 'shadow mode performed non-Agent filtering');
    assert.equal(metrics.totals.filteredNoise, 0, 'shadow mode performed noise filtering');
    assert.equal(metrics.totals.discoveryBudgetDropped, 0, 'shadow mode dropped unknown events');
  } else {
    assert.equal(metrics.totals.wouldFilterNonAgent, 0, 'enforce mode emitted shadow non-Agent counters');
    assert.equal(metrics.totals.wouldFilterNoise, 0, 'enforce mode emitted shadow noise counters');
    assert.equal(metrics.totals.wouldDiscoveryBudgetDrop, 0, 'enforce mode emitted shadow unknown counters');
  }
}

function minimalRuntime(item) {
  return sanitized({
    collectorId: item?.collectorId,
    forwarderInstanceId: item?.forwarderInstanceId,
    leaseEpoch: item?.leaseEpoch,
    snapshotVersion: item?.snapshotVersion,
    agentScopeId: item?.agentScopeId,
    agentDisplayName: item?.agentDisplayName,
    agentInstanceId: item?.agentInstanceId,
    physicalWorkloadId: item?.physicalWorkloadId,
    classification: item?.classification,
    runtimeState: item?.runtimeState,
    activityState: item?.activityState,
    rootPid: item?.rootPid,
    rootStartTimeTicks: item?.rootStartTimeTicks,
    rootGeneration: item?.rootGeneration,
    hostId: item?.hostId,
    bootId: item?.bootId,
    comm: item?.comm,
    workspacePath: item?.workspacePath,
    source: item?.source,
    workloadRef: item?.workloadRef,
    discoveredAt: item?.discoveredAt,
    lastSeenAt: item?.lastSeenAt,
    endedAt: item?.endedAt,
    exitCode: item?.exitCode,
    signal: item?.signal,
  });
}

function minimalEvent(item) {
  return sanitized({
    eventId: item?.eventId,
    eventKind: item?.eventKind,
    eventTime: item?.eventTime,
    attributes: item?.attributes,
    collectorId: item?.collectorId,
    subject: item?.subject,
    process: item?.process,
    attribution: item?.attribution,
    verdict: item?.verdict,
    profile: item?.profile,
    tier: item?.tier,
  });
}

function containerApiBase(baseUrl) {
  const url = new URL(baseUrl);
  if (['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.toString().replace(/\/$/, '');
}

function endpointEnvironment(baseUrl) {
  return {
    ANYSENTRY_INGEST_URL: baseUrl + '/ingest',
    ANYSENTRY_BATCH_INGEST_URL: baseUrl + '/ingest/batch',
    ANYSENTRY_HEARTBEAT_URL: baseUrl + '/collectors/heartbeat',
    ANYSENTRY_IDENTITY_SNAPSHOT_URL: baseUrl + '/identity/snapshot',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_URL: baseUrl + '/runtime/snapshot',
    ANYSENTRY_AGENT_RUNTIME_LEASE_URL: baseUrl + '/runtime/lease',
  };
}

function collectorSupervisorEnvironment() {
  return {
    OBSERVER_SUPERVISOR_COLLECTOR_COMMAND: '/usr/bin/timeout',
    OBSERVER_SUPERVISOR_COLLECTOR_ARGS_JSON: JSON.stringify([
      '-s', 'TERM',
      '-k', String(COLLECTOR_TIMEOUT_KILL_SECONDS),
      String(COLLECTOR_MAX_RUNTIME_SECONDS),
      'a3s-observer-collector',
    ]),
    // Keep the witness in the supervised forwarder branch. Collector EOF first drains the
    // witness and then closes the real Forwarder's stdin, which is its graceful-shutdown signal.
    OBSERVER_SUPERVISOR_FORWARDER_COMMAND: '/bin/sh',
    OBSERVER_SUPERVISOR_FORWARDER_ARGS_JSON: JSON.stringify([
      '-c',
      '/usr/local/bin/node /opt/observer-e2e-witness.js | /usr/local/bin/node /opt/observer-forward.js',
    ]),
    OBSERVER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS: String(SUPERVISOR_SHUTDOWN_TIMEOUT_MS),
    OBSERVER_SUPERVISOR_COLLECTOR_TIMEOUT_MS: String(SUPERVISOR_COLLECTOR_TIMEOUT_MS),
    OBSERVER_SUPERVISOR_ESCAPE_TIMEOUT_MS: String(SUPERVISOR_ESCAPE_TIMEOUT_MS),
    FORWARD_SHUTDOWN_TIMEOUT_MS: String(FORWARDER_SHUTDOWN_TIMEOUT_MS),
  };
}

function dockerEnvArgs(environment) {
  return Object.entries(environment).flatMap(([key, value]) => ['-e', key + '=' + String(value)]);
}

function currentForwarderMountArgs(targetDirectory = '/opt') {
  return FORWARDER_MODULES.flatMap((module) => [
    '-v', path.join(repoRoot, 'scripts', module) + ':' + path.posix.join(targetDirectory, module) + ':ro',
  ]);
}

async function forwarderModuleHashes() {
  return Object.fromEntries(await Promise.all(FORWARDER_MODULES.map(async (module) => [
    module,
    (await hashLocalFile(path.join(repoRoot, 'scripts', module))).sha256,
  ])));
}

function resolvedDockerImage(options, configuredImage) {
  const image = options.resolvedDockerImages?.[configuredImage];
  assert.match(
    image || '',
    /^sha256:[a-f0-9]{64}$/u,
    'Docker image was not pinned during preflight: ' + configuredImage,
  );
  return image;
}

async function assertDockerContainerImage(name, expectedImage) {
  const inspected = await run('docker', ['inspect', '--format', '{{.Image}}', name]);
  assert.equal(
    inspected.stdout.trim(),
    expectedImage,
    'Docker container did not use the preflight-pinned image: ' + name,
  );
}

function parseSha256Sums(output, expectedDirectory) {
  return new Map(String(output).trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/u);
    assert.ok(match, 'unexpected sha256sum output');
    const relative = path.posix.relative(expectedDirectory, match[2]);
    assert.ok(relative && !relative.startsWith('../'), 'unexpected forwarder module path');
    return [relative, match[1]];
  }));
}

function assertModuleHashes(actual, expected, environment) {
  for (const [module, hash] of Object.entries(expected)) {
    assert.equal(actual.get(module), hash, environment + ' forwarder module differs from current source: ' + module);
  }
}

function forwarderHashCommand(directory) {
  return FORWARDER_MODULES.map((module) => 'sha256sum ' + path.posix.join(directory, module)).join(' && ');
}

async function assertDockerForwarderModules(name, expected) {
  const result = await run('docker', [
    'exec', name, '/bin/sh', '-c', forwarderHashCommand('/opt'),
  ], { timeoutMs: 30_000 });
  assertModuleHashes(parseSha256Sums(result.stdout, '/opt'), expected, 'Docker');
}

async function assertK8sForwarderModules(namespace, pod, expected) {
  const result = await run('kubectl', [
    '-n', namespace, 'exec', pod, '-c', 'collector', '--',
    '/bin/sh', '-c', forwarderHashCommand('/opt'),
  ], { timeoutMs: 30_000 });
  assertModuleHashes(parseSha256Sums(result.stdout, '/opt'), expected, 'Kubernetes');
}

async function stopOwnedDockerContainer(name, remove = true, graceSeconds = 15) {
  assert.ok(
    Number.isSafeInteger(graceSeconds) && graceSeconds >= 1 && graceSeconds <= 60,
    'Docker stop grace must be an integer between 1 and 60 seconds',
  );
  const ownership = ledger.dockerContainers.get(name);
  if (!(await dockerResourceOwned(name, ledger.runId, ownership))) {
    throw new Error('refused to stop Docker container without matching run ownership: ' + name);
  }
  const stopped = await run('docker', ['stop', '-t', String(graceSeconds), ownership.id], {
    allowFailure: true,
    timeoutMs: (graceSeconds + 10) * 1_000,
  });
  if (stopped.code !== 0) {
    const state = await dockerResourceState(ownership.id, ledger.runId, ownership);
    if (state.exists) {
      throw new Error('Docker stop failed for ' + name + ': ' + redact(stopped.stderr || stopped.stdout));
    }
    ledger.dockerContainers.delete(name);
    return;
  }
  if (remove) {
    await removeTrackedDockerContainer(name);
  }
}

async function startDockerCollector(options, environment, phase, apiBase) {
  const name = k8sName(options, 'collector', environment, phase);
  const id = collectorId(options, environment, phase);
  // The host collector shares the Linux host network so that a debug API published only on
  // 127.0.0.1 remains private. The Docker collector stays bridged and uses host-gateway.
  const target = environment === 'host' ? apiBase : containerApiBase(apiBase);
  const ownership = { nonce: ownershipNonce() };
  const env = {
    A3S_OBSERVER_JSON: '1',
    A3S_OBSERVER_COLLECTOR_ID: id,
    A3S_NODE_NAME: 'e2e-' + environment + '-' + options.runId,
    A3S_OBSERVER_FILES: '1',
    A3S_OBSERVER_SSL: '0',
    ANYSENTRY_SOURCE_TYPE: 'observer',
    ANYSENTRY_SOURCE_NAME: 'real-agent-lifecycle-' + environment + '-' + options.runId,
    ANYSENTRY_HEARTBEAT_SECS: '2',
    // Host/Docker attribution must not depend on the Kubernetes identity control plane. Docker
    // placement comes from its read-only socket; host attribution comes from ProcessKey/signature.
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '0',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '1',
    ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '1',
    ANYSENTRY_DOCKER_DISCOVERY: environment === 'docker' ? 'on' : 'off',
    ANYSENTRY_INFRA_FILTER: environment === 'docker' ? 'on' : 'off',
    FORWARD_FILTER_MODE: phase,
    FORWARD_RETAIN_UNKNOWN: 'false',
    FORWARD_RETAIN_NON_AGENT: 'false',
    FORWARD_NOISE_POLICY: 'balanced',
    ANYSENTRY_E2E_FILTER_MARKER_SHA256: expectedMarkerHash(filterCanaryMarker(options, environment, phase)),
    ANYSENTRY_E2E_WITNESS_DIR: '/run/anysentry-e2e-witness',
    ...collectorSupervisorEnvironment(),
    ...endpointEnvironment(target),
  };
  const args = [
    'run', '-d', '--name', name,
    '--label', 'anysentry.e2e.run-id=' + options.runId,
    '--label', 'anysentry.e2e.ownership=' + ownership.nonce,
    '--label', 'io.anysentry.observe=false',
    '--stop-timeout', String(COLLECTOR_OUTER_GRACE_SECONDS),
    '--privileged', '--pid', 'host',
    ...(environment === 'host'
      ? ['--network', 'host']
      : ['--add-host', 'host.docker.internal:host-gateway']),
    '-v', '/sys:/sys:ro',
    '--tmpfs', '/run/anysentry-e2e-witness:rw,nosuid,nodev,noexec,size=1m,mode=0700',
    ...(environment === 'docker' ? ['-v', '/var/run/docker.sock:/var/run/docker.sock:ro'] : []),
    ...currentForwarderMountArgs('/opt'),
    ...dockerEnvArgs(env),
    '--entrypoint', '/usr/local/bin/node',
    resolvedDockerImage(options, options.observerImage),
    '/opt/observer-supervisor.js',
  ];
  ledger.dockerContainers.set(name, ownership);
  const created = await trackMutation(() => run('docker', args, { timeoutMs: 90_000 }));
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('docker run returned an invalid collector ID');
  ownership.id = containerId;
  if (!(await dockerResourceOwned(name, ledger.runId, ownership))) {
    throw new Error('new Docker collector ownership could not be verified: ' + name);
  }
  await assertDockerContainerImage(name, resolvedDockerImage(options, options.observerImage));
  await assertDockerForwarderModules(name, options.forwarderModuleHashes);
  await eventually('Docker collector probes: ' + name, async () => {
    const logs = await run('docker', ['logs', name], { allowFailure: true });
    const combined = logs.stdout + logs.stderr;
    if (/probes attached/i.test(combined) && /runtime signatures/i.test(combined)) return true;
    if (logs.code !== 0) throw new Error(redact(combined.slice(-1_000)));
    return false;
  }, 45_000, 500);
  await eventually('Docker collector heartbeat and runtime lease: ' + id, async () => {
    const item = await queryHeartbeat(apiBase, id);
    const metrics = item?.filterMetrics;
    const placementReady = environment !== 'docker' || metrics?.dockerReady === true;
    return metrics?.filterMode === phase && placementReady &&
      Number(metrics?.runtimeLeaseEpoch) > 0 && Number(metrics?.runtimeSnapshotPosts) > 0
      ? item
      : undefined;
  }, 45_000, 500);
  return { name, collectorId: id, environment, phase, apiBase };
}

async function resolveK8sNode(options) {
  if (options.k8sNode) return options.k8sNode;
  const result = await run('kubectl', [
    'get', 'nodes',
    '-o', 'json',
  ]);
  const parsed = JSON.parse(result.stdout);
  const candidates = (parsed.items || []).filter((item) =>
    !item.spec?.unschedulable &&
    (item.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True'),
  );
  if (!candidates.length) throw new Error('no schedulable Ready Kubernetes node is available');
  return candidates[0].metadata.name;
}

async function createK8sObject(namespace, kind, name, manifest, map) {
  const ownership = { nonce: ownershipNonce() };
  manifest.metadata = manifest.metadata || {};
  manifest.metadata.labels = {
    ...(manifest.metadata.labels || {}),
    'anysentry.io/e2e-run-id': ledger.runId,
    'anysentry.io/e2e-ownership': ownership.nonce,
  };
  rememberK8s(map, namespace, name, ownership);
  const result = await trackMutation(() => run(
    'kubectl',
    ['-n', namespace, 'create', '-f', '-', '-o', 'jsonpath={.metadata.uid}'],
    { input: JSON.stringify(manifest), timeoutMs: 45_000, allowFailure: true },
  ));
  if (result.code !== 0) {
    throw new Error('failed to create run-owned ' + kind + ' ' + namespace + '/' + name + ': ' + redact(result.stderr));
  }
  ownership.uid = result.stdout.trim();
  if (!ownership.uid || !(await k8sResourceOwned(kind, namespace, name, ledger.runId, ownership))) {
    throw new Error('new Kubernetes ' + kind + ' ownership could not be verified: ' + namespace + '/' + name);
  }
}

async function deleteOwnedK8s(kind, namespace, name, map) {
  await removeTrackedK8sResource(kind, namespace, name, map);
}

async function createK8sCredentialSecret(options) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'deepseek');
  const credential = await fs.readFile(options.keyFile);
  if (credential.length < 1 || credential.length > 512) throw new Error('DeepSeek key file size changed after preflight');
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: { 'anysentry.io/e2e-run-id': options.runId },
    },
    immutable: true,
    type: 'Opaque',
    data: { deepseek_api_key: credential.toString('base64') },
  };
  try {
    await createK8sObject(namespace, 'secret', name, secret, ledger.k8sSecrets);
  } finally {
    credential.fill(0);
  }
  return name;
}

async function createK8sPiMarkerSecret(options, phase, markerValue) {
  assert.match(markerValue, /^[a-z0-9-]{1,160}$/u, 'Pi marker must use the safe alphabet');
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'pi-marker', phase);
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: { 'anysentry.io/e2e-run-id': options.runId },
    },
    immutable: true,
    type: 'Opaque',
    data: { value: Buffer.from(markerValue + '\n').toString('base64') },
  };
  await createK8sObject(namespace, 'secret', name, secret, ledger.k8sSecrets);
  return name;
}

function k8sApiServiceBase(options) {
  return 'http://' + options.k8sApiService + '.' + options.k8sApiNamespace + '.svc.cluster.local:29653/security-center';
}

async function startK8sCollector(options, phase, nodeName) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'collector', 'k8s', phase);
  const id = collectorId(options, 'k8s', phase);
  const serviceBase = k8sApiServiceBase(options);
  const envValues = {
    A3S_OBSERVER_JSON: '1',
    A3S_OBSERVER_COLLECTOR_ID: id,
    A3S_OBSERVER_FILES: '1',
    A3S_OBSERVER_SSL: '0',
    ANYSENTRY_SOURCE_TYPE: 'observer',
    ANYSENTRY_SOURCE_NAME: 'real-agent-lifecycle-k8s-' + options.runId,
    ANYSENTRY_HEARTBEAT_SECS: '2',
    ANYSENTRY_IDENTITY_SNAPSHOT_SECS: '1',
    ANYSENTRY_AGENT_RUNTIME_SNAPSHOT_SECS: '1',
    ANYSENTRY_AGENT_RUNTIME_LIVENESS_SECS: '1',
    ANYSENTRY_DOCKER_DISCOVERY: 'off',
    FORWARD_FILTER_MODE: phase,
    FORWARD_RETAIN_UNKNOWN: 'false',
    FORWARD_RETAIN_NON_AGENT: 'false',
    FORWARD_NOISE_POLICY: 'balanced',
    ANYSENTRY_E2E_FILTER_MARKER_SHA256: expectedMarkerHash(filterCanaryMarker(options, 'k8s', phase)),
    ANYSENTRY_E2E_WITNESS_DIR: '/run/anysentry-e2e-witness',
    ...collectorSupervisorEnvironment(),
    ...endpointEnvironment(serviceBase),
  };
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: {
        'anysentry.io/e2e-run-id': options.runId,
        'io.anysentry.observe': 'false',
      },
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: COLLECTOR_MAX_RUNTIME_SECONDS,
      hostPID: true,
      nodeName,
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: COLLECTOR_OUTER_GRACE_SECONDS,
      containers: [{
        name: 'collector',
        image: options.k8sObserverImage,
        imagePullPolicy: 'IfNotPresent',
        securityContext: { privileged: true },
        command: ['/usr/local/bin/node', '/opt/observer-supervisor.js'],
        env: [
          ...Object.entries(envValues).map(([key, value]) => ({ name: key, value: String(value) })),
          { name: 'A3S_NODE_NAME', valueFrom: { fieldRef: { fieldPath: 'spec.nodeName' } } },
        ],
        volumeMounts: [
          { name: 'sys', mountPath: '/sys', readOnly: true },
          { name: 'witness', mountPath: '/run/anysentry-e2e-witness' },
        ],
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { memory: '1Gi' },
        },
      }],
      volumes: [
        { name: 'sys', hostPath: { path: '/sys', type: 'Directory' } },
        { name: 'witness', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
      ],
      tolerations: [{ operator: 'Exists' }],
    },
  };
  await createK8sObject(namespace, 'pod', name, manifest, ledger.k8sPods);
  await eventually('Kubernetes collector current forwarder modules: ' + name, async () => {
    await assertK8sForwarderModules(namespace, name, options.forwarderModuleHashes);
    return true;
  }, 60_000, 750);
  await eventually('Kubernetes collector probes: ' + name, async () => {
    const logs = await run('kubectl', ['-n', namespace, 'logs', name, '-c', 'collector'], { allowFailure: true });
    const combined = logs.stdout + logs.stderr;
    return /probes attached/i.test(combined) && /runtime signatures/i.test(combined) ? true : false;
  }, 60_000, 750);
  await eventually('Kubernetes collector heartbeat and runtime lease: ' + id, async () => {
    const item = await queryHeartbeat(options.k8sApiBase, id);
    const metrics = item?.filterMetrics;
    return metrics?.filterMode === phase && metrics?.identitySnapshotReady === true &&
      Number(metrics?.runtimeLeaseEpoch) > 0 && Number(metrics?.runtimeSnapshotPosts) > 0
      ? item
      : undefined;
  }, 60_000, 500);
  return { name, namespace, collectorId: id, environment: 'k8s', phase, apiBase: options.k8sApiBase };
}

function markerAction(markerValue, outputFile = '/workspace/tool-events.log') {
  assert.match(markerValue, /^[a-z0-9-]{1,160}$/u, 'marker must be shell-safe');
  return "printf '%s\\n' '" + markerValue + "' >> '" + outputFile +
    "'; exec /usr/bin/true '" + markerValue + "'\n";
}

function piPrompt() {
  return [
    'This is a harmless isolated AnySentry instrumentation test.',
    'Use the read tool to read /workspace/canary.txt.',
    'Use the ls tool to list /workspace.',
    'Use the bash tool to run rg AnySentry /workspace/canary.txt.',
    'Use the write tool to create /workspace/model-result.txt with a one-line summary.',
    'Finally use the bash tool to run exactly this harmless command: /bin/sh /opt/agent-lab/app/pi-e2e-marker.sh',
    'Do not access anything outside /workspace and do not install software.',
  ].join(' ');
}

function piEnvironment(options, environment, phase) {
  return {
    AGENT_RUNTIME: 'pi',
    AGENT_ID: 'e2e-' + environment + '-' + phase + '-' + options.runId,
    AGENT_INTERVAL_SECONDS: '600',
    PI_EXECUTION_MODE: 'loop',
    PI_PROVIDER: 'deepseek',
    PI_MODEL: 'deepseek-v4-flash',
    PI_THINKING: 'off',
    PI_TURN_TIMEOUT_SECONDS: '90',
    PI_RETRY_SECONDS: '10',
    DEEPSEEK_API_KEY_FILE: '/run/secrets/deepseek_api_key',
    PI_E2E_MARKER_FILE: '/run/anysentry-e2e-marker/value',
    PI_AGENT_PROMPT: piPrompt(),
  };
}

async function writeDockerPiMarkerFile(options, phase, markerValue) {
  assert.match(markerValue, /^[a-z0-9-]{1,160}$/u, 'Pi marker must use the safe alphabet');
  const directory = path.join(ledger.tempRoot, 'pi-marker-docker-' + phase);
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  await fs.writeFile(path.join(directory, 'value'), markerValue + '\n', { mode: 0o640, flag: 'wx' });
  return directory;
}

function filterCanaryMarker(options, environment, phase) {
  return marker(options, environment, phase, 'unknown-filter-canary');
}

function filterCanaryCommand() {
  return [
    'set -eu',
    // Poll once per second and stop on its own if the controller never arms the canary. The sleep
    // command carries no marker; only the final /usr/bin/true exec can satisfy marker correlation.
    'remaining=' + FILTER_CANARY_WAIT_SECONDS,
    'while [ ! -f /run/canary/go ]; do [ "$remaining" -gt 0 ] || exit 124; remaining=$((remaining - 1)); /bin/sleep 1; done',
    'marker="$(cat /run/canary/value)"',
    'exec /usr/bin/true "$marker"',
  ].join('; ');
}

async function writeFilterCanaryFiles(options, environment, phase) {
  const directory = path.join(ledger.tempRoot, 'filter-canary-' + environment + '-' + phase);
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  await fs.writeFile(
    path.join(directory, 'value'),
    filterCanaryMarker(options, environment, phase) + '\n',
    { mode: 0o640, flag: 'wx' },
  );
  return directory;
}

async function startDockerFilterCanary(options, environment, phase) {
  const name = k8sName(options, 'filter-canary', environment, phase);
  const ownership = { nonce: ownershipNonce() };
  const files = await writeFilterCanaryFiles(options, environment, phase);
  const args = [
    'run', '-d', '--name', name,
    '--label', 'anysentry.e2e.run-id=' + options.runId,
    '--label', 'anysentry.e2e.ownership=' + ownership.nonce,
    '--label', 'io.anysentry.observe=true',
    '--stop-timeout', '5',
    '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '--user', (typeof process.getuid === 'function' ? process.getuid() : 1000) + ':' +
      (typeof process.getgid === 'function' ? process.getgid() : 1000),
    '--pids-limit', '16', '--memory', '32m', '--cpus', '0.1',
    '-v', files + ':/run/canary:ro',
    '--entrypoint', '/usr/bin/timeout',
    resolvedDockerImage(options, options.agentImage),
    '-s', 'TERM', '-k', '5', String(FILTER_CANARY_MAX_RUNTIME_SECONDS),
    '/bin/sh', '-c', filterCanaryCommand(),
  ];
  ledger.dockerContainers.set(name, ownership);
  const created = await trackMutation(() => run('docker', args, { timeoutMs: 60_000 }));
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('docker run returned an invalid filter-canary ID');
  ownership.id = containerId;
  if (!(await dockerResourceOwned(name, ledger.runId, ownership))) {
    throw new Error('new Docker filter canary ownership could not be verified: ' + name);
  }
  await assertDockerContainerImage(name, resolvedDockerImage(options, options.agentImage));
  return {
    name,
    environment,
    phase,
    marker: filterCanaryMarker(options, environment, phase),
    containerId,
    triggerFile: path.join(files, 'go'),
  };
}

async function createK8sFilterCanarySecret(options, phase) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'filter-canary', 'value', phase);
  const value = Buffer.from(filterCanaryMarker(options, 'k8s', phase) + '\n');
  const manifest = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace },
    immutable: true,
    type: 'Opaque',
    data: { value: value.toString('base64') },
  };
  try {
    await createK8sObject(namespace, 'secret', name, manifest, ledger.k8sSecrets);
  } finally {
    value.fill(0);
  }
  return name;
}

async function startK8sFilterCanary(options, phase, nodeName) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'filter-canary', 'k8s', phase);
  const secretName = await createK8sFilterCanarySecret(options, phase);
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: { 'io.anysentry.observe': 'true' },
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: FILTER_CANARY_MAX_RUNTIME_SECONDS,
      nodeName,
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 5,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [{
        name: 'canary',
        image: options.agentImage,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sh', '-c'],
        args: [filterCanaryCommand()],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
          { name: 'value', mountPath: '/run/canary-value', readOnly: true },
          { name: 'trigger', mountPath: '/run/canary' },
        ],
        resources: {
          requests: { cpu: '5m', memory: '16Mi' },
          limits: { cpu: '100m', memory: '64Mi' },
        },
      }],
      volumes: [
        { name: 'value', secret: { secretName, defaultMode: 288 } },
        { name: 'trigger', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
      ],
    },
  };
  manifest.spec.containers[0].args = [[
    'set -eu',
    'remaining=' + FILTER_CANARY_WAIT_SECONDS,
    'while [ ! -f /run/canary/go ]; do [ "$remaining" -gt 0 ] || exit 124; remaining=$((remaining - 1)); /bin/sleep 1; done',
    'marker="$(cat /run/canary-value/value)"',
    'exec /usr/bin/true "$marker"',
  ].join('; ')];
  await createK8sObject(namespace, 'pod', name, manifest, ledger.k8sPods);
  const containerId = await eventually('Kubernetes filter canary Running: ' + name, async () => {
    const result = await run('kubectl', [
      '-n', namespace, 'get', 'pod', name,
      '-o', 'jsonpath={.status.phase}{"\\n"}{.status.containerStatuses[0].containerID}',
    ], { allowFailure: true });
    const [status, containerId] = result.stdout.trim().split(/\r?\n/u);
    return status === 'Running' && containerId ? containerId : undefined;
  }, 60_000, 500);
  return {
    name,
    namespace,
    secretName,
    environment: 'k8s',
    phase,
    marker: filterCanaryMarker(options, 'k8s', phase),
    containerId: String(containerId).replace(/^[a-z0-9._-]+:\/\//iu, ''),
  };
}

async function triggerFilterCanary(runRecord) {
  if (runRecord.environment === 'k8s') {
    await run('kubectl', [
      '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'canary', '--',
      '/usr/bin/touch', '/run/canary/go',
    ], { timeoutMs: 15_000 });
    return;
  }
  await fs.writeFile(runRecord.triggerFile, 'go\n', { mode: 0o600, flag: 'wx' });
}

async function armFilterWitness(collector, markerValue) {
  // Pass the marker on stdin, never argv. Otherwise the act of arming the witness would itself be
  // observed as a marker-bearing exec and could make the E2E pass without the target workload.
  const command = ['-c', 'umask 077; IFS= read -r marker; printf \'%s\\n\' "$marker" > /run/anysentry-e2e-witness/marker; : > /run/anysentry-e2e-witness/matches.ndjson'];
  const input = markerValue + '\n';
  if (collector.environment === 'k8s') {
    await run('kubectl', [
      '-n', collector.namespace, 'exec', '-i', collector.name, '-c', 'collector', '--',
      '/bin/sh', ...command,
    ], { input, timeoutMs: 15_000 });
    return;
  }
  await run('docker', ['exec', '-i', collector.name, '/bin/sh', ...command], { input, timeoutMs: 15_000 });
}

function validateWitnessRecord(record, markerValue, environment, containerId) {
  assert.equal(record?.schema, 'anysentry.e2e_raw_witness.v1', 'raw witness schema mismatch');
  assert.ok(Number.isFinite(Date.parse(record?.observedAt || '')), 'raw witness has no valid observation time');
  assert.equal(record?.eventKind, 'ToolExec', 'raw witness did not observe ToolExec');
  assert.equal(record?.markerSha256, expectedMarkerHash(markerValue), 'raw witness marker digest mismatch');
  assert.equal(record?.argvMarkerMatched, true, 'raw witness did not match the exact argv marker');
  assert.equal(record?.execConfirmed, true, 'raw witness event was not kernel-confirmed');
  assert.ok(Number.isInteger(record?.process?.pid) && record.process.pid > 0, 'raw witness has no process PID');
  assert.match(record?.lineSha256 || '', /^[a-f0-9]{64}$/u, 'raw witness has no event digest');
  if (environment === 'docker' || environment === 'k8s') {
    const placement = JSON.stringify({
      cgroup: record?.process?.cgroup,
      session: record?.identity?.session,
      workload: record?.workload,
    });
    assert.ok(
      placement.includes(containerId) || placement.includes(containerId.slice(0, 12)),
      environment + ' raw witness does not belong to the filter canary workload',
    );
  }
  return record;
}

function expectedMarkerHash(markerValue) {
  return hashText(JSON.stringify(markerValue));
}

function matchingFilterReceipt(heartbeat, runRecord, rawWitness) {
  const expectedHash = expectedMarkerHash(runRecord.marker);
  return heartbeat?.filterMetrics?.e2eFilterReceipts?.find((receipt) => {
    if (receipt?.schema !== 'anysentry.e2e_filter_receipt.v1' || receipt.eventKind !== 'ToolExec') return false;
    if (
      receipt.markerSha256 !== expectedHash ||
      receipt.lineSha256 !== rawWitness?.lineSha256 ||
      receipt.classification !== 'unknown' ||
      receipt.filterReason !== 'unknown'
    ) return false;
    const observedAt = Date.parse(rawWitness?.observedAt || '');
    const filteredAt = Date.parse(receipt.filteredAt || '');
    if (!Number.isFinite(observedAt) || !Number.isFinite(filteredAt) || filteredAt < observedAt) return false;
    if (runRecord.environment === 'host') return true;
    const physical = String(receipt.physicalWorkloadId || '');
    return physical.includes(runRecord.containerId) || physical.includes(runRecord.containerId.slice(0, 12));
  });
}

async function waitForFilterWitness(collector, runRecord) {
  return await eventually('raw observer witness ' + runRecord.marker, async () => {
    let result;
    if (collector.environment === 'k8s') {
      result = await run('kubectl', [
        '-n', collector.namespace, 'exec', collector.name, '-c', 'collector', '--',
        '/bin/sh', '-c', 'test -s /run/anysentry-e2e-witness/matches.ndjson && tail -n 8 /run/anysentry-e2e-witness/matches.ndjson',
      ], { allowFailure: true, timeoutMs: 15_000 });
    } else {
      result = await run('docker', [
        'exec', collector.name, '/bin/sh', '-c',
        'test -s /run/anysentry-e2e-witness/matches.ndjson && tail -n 8 /run/anysentry-e2e-witness/matches.ndjson',
      ], { allowFailure: true, timeoutMs: 15_000 });
    }
    if (result.code !== 0) return undefined;
    for (const line of result.stdout.trim().split(/\r?\n/u).filter(Boolean).reverse()) {
      let parsed;
      try { parsed = JSON.parse(line); } catch { continue; }
      if (parsed.markerSha256 === expectedMarkerHash(runRecord.marker)) {
        return validateWitnessRecord(parsed, runRecord.marker, runRecord.environment, runRecord.containerId);
      }
    }
    return undefined;
  }, 30_000, 250);
}

async function waitForFilterCanaryProcess(runRecord) {
  if (runRecord.environment === 'k8s') {
    await eventually('Kubernetes filter canary completed', async () => {
      const result = await run('kubectl', [
        '-n', runRecord.namespace, 'get', 'pod', runRecord.name,
        '-o', 'jsonpath={.status.containerStatuses[0].state.terminated.exitCode}',
      ], { allowFailure: true });
      return result.stdout.trim() === '0' ? true : undefined;
    }, 30_000, 250);
    return;
  }
  await eventually('Docker filter canary completed', async () => {
    const result = await run('docker', ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', runRecord.name], {
      allowFailure: true,
    });
    return result.stdout.trim() === 'exited 0' ? true : undefined;
  }, 30_000, 250);
}

async function readLocalProofTextFile(workspace, name) {
  assert.equal(path.basename(name), name, 'proof file name must be a basename');
  const target = path.join(workspace, name);
  let expected;
  let handle;
  try {
    expected = await fs.lstat(target);
    if (!expected.isFile() || expected.isSymbolicLink()) {
      return { exists: true, status: 'unsafe_file_type', bytes: expected.size };
    }
    if (expected.size > LOCAL_PROOF_FILE_LIMIT) {
      return { exists: true, status: 'too_large', bytes: expected.size };
    }
    handle = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size ||
        opened.mtimeMs !== expected.mtimeMs || opened.ctimeMs !== expected.ctimeMs || !opened.isFile()) {
      return { exists: true, status: 'identity_changed', bytes: opened.size };
    }
    const content = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < content.length) {
      const result = await handle.read(content, offset, content.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (offset !== content.length || after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      return { exists: true, status: 'changed_while_reading', bytes: after.size };
    }
    return { exists: true, status: 'ok', bytes: content.length, text: content.toString('utf8') };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, status: 'missing', bytes: 0 };
    return {
      exists: Boolean(expected),
      status: 'unreadable',
      bytes: expected?.size ?? 0,
      error: redact(error?.code || error?.message || error),
    };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function localToolProofIssues(toolFile, modelFile, markerValue) {
  const issues = [];
  if (toolFile.status === 'missing') issues.push('tool-events.log:missing');
  else if (toolFile.status !== 'ok') issues.push('tool-events.log:' + toolFile.status);
  else if (!toolFile.text.trim()) issues.push('tool-events.log:empty');
  else if (!toolFile.text.includes(markerValue)) issues.push('tool-events.log:marker_missing');

  if (modelFile.status === 'missing') issues.push('model-result.txt:missing');
  else if (modelFile.status !== 'ok') issues.push('model-result.txt:' + modelFile.status);
  else if (!modelFile.text.trim()) issues.push('model-result.txt:empty');
  return issues;
}

function proofFileSummary(file) {
  return {
    exists: file.exists,
    status: file.status,
    bytes: file.bytes,
    ...(file.error ? { error: file.error } : {}),
  };
}

async function localToolProofState(workspace, markerValue, workspaceIdentity) {
  if (workspaceIdentity) {
    const workspaceState = await localPathState(workspace);
    const workspaceTrusted = workspaceState.exists && workspaceState.identity.directory &&
      sameLocalPathIdentity(workspaceState.identity, workspaceIdentity);
    if (!workspaceTrusted) {
      const status = workspaceState.exists ? 'workspace_identity_changed' : 'workspace_missing';
      return {
        ready: false,
        issues: ['workspace:' + status],
        files: {
          toolEvents: { exists: false, status: 'inspection_skipped', bytes: 0 },
          modelResult: { exists: false, status: 'inspection_skipped', bytes: 0 },
        },
      };
    }
  }
  const [toolFile, modelFile] = await Promise.all([
    readLocalProofTextFile(workspace, 'tool-events.log'),
    readLocalProofTextFile(workspace, 'model-result.txt'),
  ]);
  const issues = localToolProofIssues(toolFile, modelFile, markerValue);
  return {
    ready: issues.length === 0,
    issues,
    files: {
      toolEvents: proofFileSummary(toolFile),
      modelResult: proofFileSummary(modelFile),
    },
    proof: issues.length === 0 ? {
      markerPresent: true,
      toolEvents: { bytes: toolFile.bytes, sha256: hashText(toolFile.text) },
      modelResult: { bytes: modelFile.bytes, sha256: hashText(modelFile.text) },
    } : undefined,
  };
}

async function readLocalToolProof(workspace, markerValue, runRecord) {
  let lastState;
  try {
    return await eventually('host tool result marker ' + markerValue, async () => {
      lastState = await localToolProofState(workspace, markerValue, runRecord?.workspaceIdentity);
      if (runRecord) runRecord.lastProofState = lastState;
      return lastState.ready ? lastState.proof : undefined;
    }, 20_000, 250);
  } catch (error) {
    if (ledger.aborting) throw error;
    const issues = lastState?.issues?.length ? lastState.issues.join(', ') : 'state_unavailable';
    const proofError = new Error('host tool proof failed: ' + issues);
    proofError.proofState = lastState;
    throw proofError;
  }
}

function hostPrompt(workspace) {
  const canary = path.join(workspace, 'canary.txt');
  const modelResult = path.join(workspace, 'model-result.txt');
  const action = path.join(workspace, 'action.txt');
  return [
    'This is a harmless isolated AnySentry lifecycle test.',
    'Read ' + canary + '.',
    'List only ' + workspace + '.',
    'Use a shell tool to run rg AnySentry ' + canary + '.',
    'Write a one-line summary to ' + modelResult + '.',
    'Then read ' + action + ' and use a shell tool to execute exactly the harmless command stored there.',
    'Do not access any other path, do not install software, and stop after these steps.',
  ].join(' ');
}

async function prepareHostWorkspace(options, phase, agent, markerValue) {
  const workspace = path.join(ledger.tempRoot, phase + '-' + agent);
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'canary.txt'), 'AnySentry real Agent lifecycle canary\n', { mode: 0o600 });
  await fs.writeFile(
    path.join(workspace, 'action.txt'),
    markerAction(markerValue, path.join(workspace, 'tool-events.log')),
    { mode: 0o600 },
  );
  return workspace;
}

function hostAgentEnvironment() {
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined &&
    hostAgentEnvironmentNameAllowed(name) &&
    !/^(?:LD_|NODE_OPTIONS$|BASH_ENV$)/u.test(name) &&
    !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SSH_AUTH_SOCK)/iu.test(name),
  ));
  assert.equal(
    Object.keys(environment).every(hostAgentEnvironmentNameAllowed),
    true,
    'host Agent environment escaped its allowlist',
  );
  return environment;
}

function hostAgentExecutableName(agent) {
  if (agent === 'host-codex') return 'codex';
  if (agent === 'host-kimi') return 'kimi';
  throw new Error('unsupported host Agent: ' + agent);
}

async function resolveHostAgentExecutable(agent, environment) {
  const executable = hostAgentExecutableName(agent);
  const searchPath = String(environment.PATH || '');
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    const candidate = path.resolve(directory, executable);
    if (path.basename(candidate) !== executable) continue;
    try {
      const stat = await fs.stat(candidate);
      await fs.access(candidate, fsConstants.X_OK);
      if (!stat.isFile()) continue;
      return {
        path: candidate,
        identity: localPathIdentity(stat),
      };
    } catch {}
  }
  throw new Error('host Agent executable is not resolvable from the filtered absolute PATH: ' + executable);
}

function hostCodexArgs(options, workspace, prompt) {
  assert.ok(path.isAbsolute(workspace), 'host Codex workspace must be absolute');
  if (options.allowHostFullAccess) {
    assert.equal(options.allowHostAgents, true, 'danger-full-access requires host Agent authorization');
    assert.ok(options.agents.includes('host-codex'), 'danger-full-access requires host-codex selection');
  }
  return [
    'exec', '--ephemeral', '--skip-git-repo-check',
    '--sandbox', hostCodexSandboxMode(options),
    '--ignore-user-config', '--ignore-rules',
    '--color', 'never', '--json',
    '-C', workspace, '-o', path.join(workspace, 'final-output.txt'), prompt,
  ];
}

function assertHostCodexLaunchAuthorization(options, args) {
  const sandboxIndex = args.indexOf('--sandbox');
  assert.notEqual(sandboxIndex, -1, 'host Codex launch must specify a sandbox mode');
  const actualMode = args[sandboxIndex + 1];
  const expectedMode = options.allowHostFullAccess ? 'danger-full-access' : 'workspace-write';
  assert.equal(actualMode, expectedMode, 'host Codex launch sandbox mode does not match authorization');
  assert.equal(
    args.includes('--dangerously-bypass-approvals-and-sandbox'),
    false,
    'host Codex launch must never bypass the sandbox authorization gate',
  );
  if (actualMode === 'danger-full-access') {
    assert.equal(options.allowHostFullAccess, true, 'danger-full-access was not explicitly authorized');
    assert.equal(options.allowHostAgents, true, 'danger-full-access requires host Agent authorization');
    assert.ok(options.agents.includes('host-codex'), 'danger-full-access requires host-codex selection');
  }
  return actualMode;
}

function hostAgentSystemdRunArgs(unitName, description) {
  return [
    '--user',
    '--no-ask-password',
    '--unit=' + unitName,
    '--description=' + description,
    '--service-type=exec',
    '--property=KillMode=control-group',
    '--property=Restart=no',
    '--property=TimeoutStopSec=5s',
    '--property=RuntimeMaxSec=' + HOST_AGENT_RUNTIME_MAX_SECONDS + 's',
    '--expand-environment=no',
    '--collect',
    '--wait',
    '--pipe',
    '--quiet',
    process.execPath,
    scriptPath,
    HOST_AGENT_RUNNER_OPTION,
  ];
}

function systemdClientEnvironment() {
  const allowed = new Set(['PATH', 'LANG', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  return Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    value !== undefined &&
    (allowed.has(name) || /^LC_[A-Za-z0-9_]+$/u.test(name)) &&
    !/^(?:LD_|NODE_OPTIONS$|BASH_ENV$)/u.test(name),
  ));
}

function assertHostAgentPayloadOutsideSystemdArgv(systemdArgs, payload, proofValues = []) {
  assert.deepEqual(
    systemdArgs.slice(-3),
    [process.execPath, scriptPath, HOST_AGENT_RUNNER_OPTION],
    'systemd-run must invoke only the fixed internal host Agent runner',
  );
  const fixedValues = new Set([process.execPath, scriptPath, HOST_AGENT_RUNNER_OPTION]);
  const hiddenValues = [
    payload.command,
    payload.cwd,
    ...payload.args,
    ...Object.values(payload.env),
    ...proofValues,
  ].filter((value) => value && !fixedValues.has(value));
  for (const value of hiddenValues) {
    assert.equal(
      systemdArgs.includes(value),
      false,
      'host Agent payload value escaped into systemd-run argv',
    );
  }
}

async function launchHostAgentService(options, phase, agent, payload, launchOptions = {}) {
  const unitName = launchOptions.unitName || hostAgentUnitName(options, phase, agent);
  if (ledger.systemdUnits.has(unitName)) throw new Error('duplicate tracked systemd unit: ' + unitName);
  const before = await systemdUnitState(unitName);
  if (before.exists) throw new Error('refused to adopt pre-existing systemd unit: ' + unitName);
  const ownership = {
    nonce: ownershipNonce(),
    description: '',
    invocationId: undefined,
    controlGroup: undefined,
    observed: false,
    launcherRecord: undefined,
    stopPromise: undefined,
  };
  ownership.description = hostAgentUnitDescription(options.runId, ownership.nonce);
  const expected = {
    agent: payload.agent,
    command: payload.command,
    env: launchOptions.expectedEnvironment,
  };
  assert.ok(plainObject(expected.env), 'host Agent launch has no independently constructed environment contract');
  let encoded;
  let record;
  // This is the ownership fence for the signal/startup window: ledger registration happens
  // synchronously before systemd-run can request creation of the nonce-described unit.
  ledger.systemdUnits.set(unitName, ownership);
  try {
    encoded = encodeHostAgentRunnerPayload(payload, expected);
    const systemdArgs = hostAgentSystemdRunArgs(unitName, ownership.description);
    assertHostAgentPayloadOutsideSystemdArgv(systemdArgs, payload, launchOptions.proofValues);
    record = spawnCaptured('systemd-run', systemdArgs, {
      input: encoded,
      eraseInput: true,
      env: systemdClientEnvironment(),
      inheritEnv: false,
    });
    record.systemdUnitName = unitName;
    ownership.launcherRecord = record;
    const state = await eventually('owned transient systemd service ' + unitName, async () => {
      if (record.finished) {
        const result = await record.done;
        throw new Error(
          'systemd-run exited before the transient service became ready; exit=' +
          (result.signal || result.code) + '; stderr hash=' + hashText(result.stderr),
        );
      }
      const observed = await systemdUnitState(unitName, ownership);
      if (!observed.exists) return undefined;
      if (!observed.owned) throw new Error('systemd unit name was claimed outside this run: ' + unitName);
      if (!observed.execMainPid || !observed.controlGroup ||
          !/^[a-f0-9]{32}$/u.test(observed.invocationId || '') ||
          !['active', 'activating'].includes(observed.activeState)) return undefined;
      lockSystemdUnitOwnership(unitName, ownership, observed);
      return observed;
    }, HOST_AGENT_START_TIMEOUT_MS, 50);
    const detached = await assertHostServiceDetached(state.execMainPid, state.controlGroup);
    return {
      record,
      unitName,
      ownership,
      state,
      detached,
      systemdArgv: {
        payloadTransport: 'stdin',
        fixedArgumentCount: hostAgentSystemdRunArgs(unitName, ownership.description).length,
      },
    };
  } catch (error) {
    if (encoded) encoded.fill(0);
    let cleanupError;
    try {
      if (ledger.systemdUnits.has(unitName)) await stopTrackedSystemdUnit(unitName, true);
      else if (record && !record.finished) await reapCapturedProcess(record);
    } catch (nested) {
      cleanupError = nested;
    }
    if (cleanupError) {
      error.message += '; transient service cleanup failed: ' + redact(cleanupError.message);
    }
    throw error;
  }
}

async function launchHostAgent(options, phase, agent, markerValue) {
  const workspace = await prepareHostWorkspace(options, phase, agent, markerValue);
  const workspaceIdentity = localPathIdentity(await fs.lstat(workspace));
  const prompt = hostPrompt(workspace);
  const environment = hostAgentEnvironment();
  const pinnedExecutable = options.resolvedHostCommands?.[agent];
  assert.ok(pinnedExecutable?.path && pinnedExecutable?.identity, agent + ' has no preflight-pinned executable');
  const resolvedExecutable = await resolveHostAgentExecutable(agent, environment);
  assert.equal(resolvedExecutable.path, pinnedExecutable.path, agent + ' executable path changed after preflight');
  assert.equal(
    sameLocalPathIdentity(resolvedExecutable.identity, pinnedExecutable.identity),
    true,
    agent + ' executable identity changed after preflight',
  );
  let command;
  let args;
  if (agent === 'host-codex') {
    command = resolvedExecutable.path;
    args = hostCodexArgs(options, workspace, prompt);
    assertHostCodexLaunchAuthorization(options, args);
  } else if (agent === 'host-kimi') {
    command = resolvedExecutable.path;
    args = [
      '--work-dir', workspace, '--print', '--no-thinking', '--max-steps-per-turn', '8',
      '--mcp-config', '{}', '--skills-dir', path.join(workspace, 'empty-skills'),
      '--prompt', prompt,
    ];
  } else {
    throw new Error('unsupported host Agent: ' + agent);
  }
  await fs.mkdir(path.join(workspace, 'empty-skills'), { mode: 0o700 });
  const service = await launchHostAgentService(options, phase, agent, {
    schema: HOST_AGENT_RUNNER_SCHEMA,
    agent,
    command,
    args,
    cwd: workspace,
    env: { ...environment },
  }, {
    expectedEnvironment: environment,
  });
  return {
    record: service.record,
    systemd: service,
    workspace,
    workspaceIdentity,
    marker: markerValue,
    agent,
    phase,
    sandboxMode: agent === 'host-codex' ? hostCodexSandboxMode(options) : undefined,
    fullAccessAuthorized: agent === 'host-codex' ? options.allowHostFullAccess : false,
  };
}

async function quiesceHostAgentForDiagnostic(runRecord) {
  if (runRecord.systemd?.unitName && ledger.systemdUnits.has(runRecord.systemd.unitName)) {
    await stopTrackedSystemdUnit(runRecord.systemd.unitName, true);
  }
  if (!runRecord.record.finished) {
    try {
      await terminateProcess(runRecord.record);
    } catch (error) {
      if (!runRecord.record.finished) throw error;
    }
  }
  if (!runRecord.record.finished) {
    throw new Error('refused to capture host Agent evidence while its process is still running');
  }
  if (!runRecord.result) {
    try {
      runRecord.result = await runRecord.record.done;
    } catch (error) {
      runRecord.resultCaptureError = boundedRedactedText(error?.message || error, 2_048);
    }
  }
  return runRecord.result;
}

async function finishHostAgent(runRecord) {
  let timer;
  let result;
  try {
    result = await Promise.race([
      runRecord.record.done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(runRecord.agent + ' did not finish in 180 seconds')), 180_000);
      }),
    ]);
  } catch (error) {
    if (runRecord.systemd?.unitName && ledger.systemdUnits.has(runRecord.systemd.unitName)) {
      await stopTrackedSystemdUnit(runRecord.systemd.unitName, true);
    }
    if (!runRecord.record.finished) await reapCapturedProcess(runRecord.record);
    if (runRecord.record.finished) {
      try { runRecord.result = await runRecord.record.done; } catch {}
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  runRecord.result = result;
  if (runRecord.systemd?.unitName && ledger.systemdUnits.has(runRecord.systemd.unitName)) {
    await stopTrackedSystemdUnit(runRecord.systemd.unitName, true);
  }
  assert.equal(result.code, 0, runRecord.agent + ' exited unsuccessfully; stderr hash=' + hashText(result.stderr));
  const proof = await readLocalToolProof(runRecord.workspace, runRecord.marker, runRecord);
  return {
    realLlm: true,
    toolResult: proof,
    process: {
      exitCode: result.code,
      durationMs: result.durationMs,
      stdout: { bytes: Buffer.byteLength(result.stdout), sha256: hashText(result.stdout) },
      stderr: { bytes: Buffer.byteLength(result.stderr), sha256: hashText(result.stderr) },
    },
    launcher: {
      unit: runRecord.systemd?.unitName,
      invocationId: runRecord.systemd?.ownership?.invocationId,
      controlGroup: runRecord.systemd?.ownership?.controlGroup,
      detached: runRecord.systemd?.detached,
      runtimePlacement: runRecord.runtimePlacement,
    },
  };
}

async function hostAgentFailureDiagnostic(runRecord, failure) {
  assert.equal(
    runRecord.record.finished,
    true,
    'refused to inspect host Agent failure files while its process is still running',
  );
  let result = runRecord.result;
  if (!result && runRecord.record.finished) {
    try { result = await runRecord.record.done; } catch {}
  }
  const stdout = result?.stdout ?? runRecord.record.stdout ?? '';
  const stderr = result?.stderr ?? runRecord.record.stderr ?? '';
  const workspaceState = await localPathState(runRecord.workspace);
  const workspaceTrusted = workspaceState.exists && workspaceState.identity.directory &&
    sameLocalPathIdentity(workspaceState.identity, runRecord.workspaceIdentity);
  const skippedFileState = {
    exists: false,
    inspectionSkipped: workspaceState.exists ? 'workspace_identity_changed' : 'workspace_missing',
  };
  const [finalOutput, toolEvents, modelResult] = workspaceTrusted
    ? await Promise.all([
      diagnosticFileState(runRecord.workspace, 'final-output.txt', true),
      diagnosticFileState(runRecord.workspace, 'tool-events.log'),
      diagnosticFileState(runRecord.workspace, 'model-result.txt'),
    ])
    : [skippedFileState, skippedFileState, skippedFileState];
  return {
    schema: 'anysentry.real_agent_lifecycle_e2e.host_failure.v1',
    capturedAt: new Date().toISOString(),
    agent: runRecord.agent,
    phase: runRecord.phase,
    workspace: redact(runRecord.workspace),
    workspaceTrusted,
    accessPolicy: {
      fullAccessAuthorized: runRecord.fullAccessAuthorized === true,
      sandboxMode: runRecord.sandboxMode,
    },
    failure: {
      name: failure instanceof Error ? failure.name : 'Error',
      message: boundedRedactedText(failure instanceof Error ? failure.message : String(failure), 2_048),
    },
    process: {
      pid: runRecord.record.child.pid,
      finished: runRecord.record.finished,
      exitCode: result?.code ?? null,
      signal: result?.signal ?? null,
      durationMs: result?.durationMs ?? Math.max(0, Date.now() - runRecord.record.startedAt),
      stdout: boundedRedactedText(stdout),
      stderr: boundedRedactedText(stderr),
      codexJson: runRecord.agent === 'host-codex' ? boundedCodexJsonLines(stdout) : undefined,
      ...(runRecord.diagnosticTerminationError
        ? { terminationError: runRecord.diagnosticTerminationError }
        : {}),
      ...(runRecord.resultCaptureError
        ? { resultCaptureError: runRecord.resultCaptureError }
        : {}),
    },
    proof: {
      issues: runRecord.lastProofState?.issues ?? failure?.proofState?.issues ?? [],
      files: { finalOutput, toolEvents, modelResult },
    },
  };
}

async function persistHostAgentFailureDiagnostic(options, runRecord, failure) {
  const diagnostic = await hostAgentFailureDiagnostic(runRecord, failure);
  const name = 'host-agent-' + runRecord.phase + '-' + runRecord.agent + '-failure.json';
  const evidence = await writeJsonEvidence(options.artifactDir, name, diagnostic);
  return { file: path.basename(evidence.file), bytes: evidence.bytes, sha256: evidence.sha256 };
}

async function startDockerPi(options, phase, markerValue) {
  const name = k8sName(options, 'workload', 'docker', phase);
  const ownership = { nonce: ownershipNonce() };
  const runtimeUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  const runtimeGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
  const markerDirectory = await writeDockerPiMarkerFile(options, phase, markerValue);
  const args = [
    'run', '-d', '--name', name,
    '--label', 'anysentry.e2e.run-id=' + options.runId,
    '--label', 'anysentry.e2e.ownership=' + ownership.nonce,
    '--label', 'io.anysentry.observe=true',
    '--stop-timeout', String(CONTAINER_KILL_GRACE_SECONDS),
    '--read-only', '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL',
    '--user', runtimeUid + ':' + runtimeGid,
    '--pids-limit', '128', '--memory', '768m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m,uid=' + runtimeUid + ',gid=' + runtimeGid + ',mode=1770',
    '--tmpfs', '/workspace:rw,nosuid,size=64m,uid=' + runtimeUid + ',gid=' + runtimeGid + ',mode=0750',
    '--tmpfs', '/home/node/.pi/agent:rw,nosuid,size=64m,uid=' + runtimeUid + ',gid=' + runtimeGid + ',mode=0750',
    '-v', options.keyFile + ':/run/secrets/deepseek_api_key:ro',
    '-v', markerDirectory + ':/run/anysentry-e2e-marker:ro',
    ...dockerEnvArgs(piEnvironment(options, 'docker', phase)),
    '--entrypoint', '/usr/bin/timeout',
    resolvedDockerImage(options, options.agentImage),
    '-s', 'TERM', '-k', String(CONTAINER_KILL_GRACE_SECONDS), String(AGENT_MAX_RUNTIME_SECONDS),
    '/opt/agent-lab/entrypoint.sh',
  ];
  ledger.dockerContainers.set(name, ownership);
  const created = await trackMutation(() => run('docker', args, { timeoutMs: 60_000 }));
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('docker run returned an invalid workload ID');
  ownership.id = containerId;
  if (!(await dockerResourceOwned(name, ledger.runId, ownership))) {
    throw new Error('new Docker workload ownership could not be verified: ' + name);
  }
  await assertDockerContainerImage(name, resolvedDockerImage(options, options.agentImage));
  return { name, marker: markerValue, environment: 'docker' };
}

async function dockerPiProof(runRecord) {
  const expectedProofHash = hashText(runRecord.marker + '\n');
  await eventually('Docker Pi real LLM tool result', async () => {
    const result = await run('docker', [
      'exec', runRecord.name, '/bin/sh', '-c',
      'test -s /workspace/model-result.txt && sha256sum /workspace/tool-events.log',
    ], { allowFailure: true, timeoutMs: 10_000 });
    return result.code === 0 && result.stdout.trim().split(/\s+/u)[0] === expectedProofHash ? true : false;
  }, 180_000, 1_000);
  const logs = await run('docker', ['logs', runRecord.name], { timeoutMs: 15_000 });
  assert.match(logs.stdout + logs.stderr, /"mode":"loop"/u, 'Docker Pi did not run in real loop mode');
  assert.match(logs.stdout + logs.stderr, /"credentialSource":"DEEPSEEK_API_KEY"/u, 'Docker Pi did not consume the mounted DeepSeek credential');
  assert.match(logs.stdout + logs.stderr, /"pi_process_exited"[^\n]*"code":0/u, 'Docker Pi real model turn did not exit successfully');
  const hashes = await run('docker', [
    'exec', runRecord.name, '/bin/sh', '-c',
    'wc -c /workspace/tool-events.log /workspace/model-result.txt && sha256sum /workspace/tool-events.log /workspace/model-result.txt',
  ]);
  return {
    realLlm: true,
    markerPresent: true,
    logs: { bytes: Buffer.byteLength(logs.stdout + logs.stderr), sha256: hashText(logs.stdout + logs.stderr) },
    resultFiles: redact(hashes.stdout.trim()),
  };
}

async function startK8sPi(options, phase, nodeName, secretName, markerValue) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'workload', 'k8s', phase);
  const markerSecretName = await createK8sPiMarkerSecret(options, phase, markerValue);
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name,
      namespace,
      labels: {
        'anysentry.io/e2e-run-id': options.runId,
        'io.anysentry.observe': 'true',
      },
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: AGENT_MAX_RUNTIME_SECONDS,
      nodeName,
      automountServiceAccountToken: false,
      terminationGracePeriodSeconds: 15,
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [{
        name: 'workload',
        image: options.agentImage,
        imagePullPolicy: 'IfNotPresent',
        env: Object.entries(piEnvironment(options, 'k8s', phase))
          .map(([key, value]) => ({ name: key, value: String(value) })),
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
          { name: 'workspace', mountPath: '/workspace' },
          { name: 'pi-state', mountPath: '/home/node/.pi/agent' },
          { name: 'credentials', mountPath: '/run/secrets', readOnly: true },
          { name: 'marker', mountPath: '/run/anysentry-e2e-marker', readOnly: true },
          { name: 'tmp', mountPath: '/tmp' },
        ],
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { cpu: '1', memory: '768Mi' },
        },
      }],
      volumes: [
        { name: 'workspace', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'pi-state', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'credentials', secret: { secretName, defaultMode: 288 } },
        { name: 'marker', secret: { secretName: markerSecretName, defaultMode: 288 } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
      ],
    },
  };
  await createK8sObject(namespace, 'pod', name, manifest, ledger.k8sPods);
  return { name, namespace, marker: markerValue, markerSecretName, environment: 'k8s' };
}

async function k8sPiProof(runRecord) {
  const expectedProofHash = hashText(runRecord.marker + '\n');
  await eventually('Kubernetes Pi real LLM tool result', async () => {
    const result = await run('kubectl', [
      '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
      '/bin/sh', '-c',
      'test -s /workspace/model-result.txt && sha256sum /workspace/tool-events.log',
    ], { allowFailure: true, timeoutMs: 15_000 });
    return result.code === 0 && result.stdout.trim().split(/\s+/u)[0] === expectedProofHash ? true : false;
  }, 180_000, 1_000);
  const logs = await run('kubectl', [
    '-n', runRecord.namespace, 'logs', runRecord.name, '-c', 'workload',
  ], { timeoutMs: 15_000 });
  assert.match(logs.stdout + logs.stderr, /"mode":"loop"/u, 'Kubernetes Pi did not run in real loop mode');
  assert.match(logs.stdout + logs.stderr, /"credentialSource":"DEEPSEEK_API_KEY"/u, 'Kubernetes Pi did not consume the mounted DeepSeek credential');
  assert.match(logs.stdout + logs.stderr, /"pi_process_exited"[^\n]*"code":0/u, 'Kubernetes Pi real model turn did not exit successfully');
  const hashes = await run('kubectl', [
    '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
    '/bin/sh', '-c',
    'wc -c /workspace/tool-events.log /workspace/model-result.txt && sha256sum /workspace/tool-events.log /workspace/model-result.txt',
  ]);
  return {
    realLlm: true,
    markerPresent: true,
    logs: { bytes: Buffer.byteLength(logs.stdout + logs.stderr), sha256: hashText(logs.stdout + logs.stderr) },
    resultFiles: redact(hashes.stdout.trim()),
  };
}

function runtimeIdentityIsComplete(item) {
  return Boolean(
    item?.agentInstanceId && item?.agentScopeId &&
    Number.isInteger(item?.rootPid) && item.rootPid > 0 &&
    String(item?.rootStartTimeTicks || '') &&
    Number.isInteger(item?.rootGeneration) && item.rootGeneration > 0 &&
    item?.hostId && item?.bootId,
  );
}

async function waitForNewRunningInstance(apiBase, collector, baselineIds, scope, candidateMatches = async () => true) {
  return await eventually('new running ' + scope + ' instance on ' + collector, async () => {
    const runtime = await queryRuntime(apiBase, { collectorId: collector });
    const candidates = runtime.items.filter((item) =>
      !baselineIds.has(item.agentInstanceId) &&
      String(item.agentScopeId || '').toLowerCase() === scope.toLowerCase() &&
      item.runtimeState === 'running' && runtimeIdentityIsComplete(item),
    );
    for (const candidate of candidates) {
      if (await candidateMatches(candidate)) return candidate;
    }
    return undefined;
  }, 90_000, 250);
}

function runtimeCandidateMatchesHostAgent(candidate, agent, observedComm) {
  const expectedScope = agent === 'host-codex'
    ? {
      comms: new Set(['codex']),
      exes: new Set(['codex']),
      evidences: new Set(['runtime_signature:commExact=codex', 'runtime_signature:argv0Basename=codex']),
    }
    : {
      comms: new Set(['Kimi Code', 'kimi', 'kimi-cli']),
      exes: new Set(['kimi', 'kimi-cli']),
      evidences: new Set([
        'runtime_signature:commExact=kimi',
        'runtime_signature:commExact=kimi-cli',
        'runtime_signature:argv0Basename=kimi',
      ]),
    };
  if (expectedScope.comms.has(observedComm)) return true;
  const exeBase = path.basename(String(candidate?.exe || ''));
  if (expectedScope.exes.has(exeBase)) return true;
  return Array.isArray(candidate?.evidence) && candidate.evidence.some((item) => expectedScope.evidences.has(String(item)));
}

async function matchHostRuntimeToSystemdService(candidate, runRecord) {
  const service = runRecord.systemd;
  const state = await systemdUnitState(service.unitName, service.ownership);
  if (!state.exists) return undefined;
  if (!state.owned) throw new Error('host Agent systemd ownership changed while matching runtime');
  lockSystemdUnitOwnership(service.unitName, service.ownership, state);
  if (!state.controlGroup || state.controlGroup !== service.ownership.controlGroup) return undefined;
  const identity = (await processAncestry(candidate.rootPid, 1))[0];
  if (!identity || identity.startTime !== String(candidate.rootStartTimeTicks)) return undefined;
  if (candidate.rootPid === service.state.execMainPid) return undefined;
  let observedControlGroup;
  try {
    observedControlGroup = await processUnifiedControlGroup(candidate.rootPid);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!controlGroupContains(service.ownership.controlGroup, observedControlGroup)) return undefined;
  const confirmedIdentity = (await processAncestry(candidate.rootPid, 1))[0];
  if (!confirmedIdentity || confirmedIdentity.startTime !== String(candidate.rootStartTimeTicks)) return undefined;
  if (!runtimeCandidateMatchesHostAgent(candidate, runRecord.agent, confirmedIdentity.comm)) return undefined;
  return {
    processKey: String(candidate.rootPid) + ':' + String(candidate.rootStartTimeTicks),
    controlGroup: observedControlGroup,
    unit: service.unitName,
    invocationId: service.ownership.invocationId,
  };
}

async function waitForTerminalInstance(apiBase, collector, agentInstanceId) {
  return await eventually('terminal runtime instance ' + agentInstanceId, async () => {
    const runtime = await queryRuntime(apiBase, { collectorId: collector, agentInstanceId });
    const item = runtime.items.find((candidate) => candidate.agentInstanceId === agentInstanceId);
    return item && ['exited', 'lost'].includes(item.runtimeState) ? item : undefined;
  }, 90_000, 500);
}

async function waitForMarkerEvent(apiBase, collector, markerValue, agentInstanceId) {
  return await eventually('attributed marker event ' + markerValue, async () => {
    const result = await queryEvents(apiBase, collector, markerValue);
    return result.items.find((item) => exactMarkerToolEvent(item, markerValue, agentInstanceId));
  }, 90_000, 500);
}

function exactMarkerToolEvent(item, markerValue, agentInstanceId) {
  if (item?.eventKind !== 'ToolExec' || item.attribution?.agentInstanceId !== agentInstanceId) return false;
  const executable = path.posix.basename(String(item.process?.exe || ''));
  const argv = String(item.attributes?.argv || '').trim().split(/\s+/u).filter(Boolean);
  return executable === 'true' &&
    argv.length === 2 &&
    path.posix.basename(argv[0]) === 'true' &&
    argv[1] === markerValue &&
    item.attributes?.exec_confirmed === true &&
    item.attributes?.argv_incomplete === false &&
    item.attributes?.argv_truncated === false &&
    ['kernel_fragments', 'proc_cmdline'].includes(String(item.attributes?.argv_source || '')) &&
    Number(item.attributes?.observed_argc) === 2;
}

async function waitForUnknownCanaryEvent(apiBase, collector, markerValue, environment, containerId) {
  return await eventually('visible shadow filter canary ' + markerValue, async () => {
    const result = await queryEvents(apiBase, collector, markerValue);
    const item = result.items.find((candidate) =>
      JSON.stringify(candidate).includes(markerValue) &&
      candidate.attribution?.classification === 'unknown',
    );
    if (!item) return undefined;
    assert.equal(item.eventKind, 'ToolExec', 'shadow filter canary did not route a ToolExec event');
    const argv = String(item.attributes?.argv || '');
    assert.ok(argv.split(/\s+/u).includes(markerValue), 'shadow ToolExec does not contain the exact marker argument');
    assert.equal(item.attributes?.exec_confirmed, true, 'shadow ToolExec was not kernel-confirmed');
    assert.notEqual(item.attributes?.argv_incomplete, true, 'shadow ToolExec argv was incomplete');
    assert.notEqual(item.attributes?.argv_truncated, true, 'shadow ToolExec argv was truncated');
    if (environment === 'docker' || environment === 'k8s') {
      assert.ok(
        String(item.attribution?.physicalWorkloadId || '').includes(containerId),
        environment + ' filter canary did not retain its physical workload identity',
      );
    }
    return item;
  }, 90_000, 500);
}

function heartbeatCursor(item) {
  const filterMetrics = item?.filterMetrics && typeof item.filterMetrics === 'object'
    ? item.filterMetrics
    : {};
  return {
    lastHeartbeatAt: String(item?.lastHeartbeatAt || ''),
    filterMetricsFingerprint: hashText(JSON.stringify(filterMetrics)),
  };
}

function heartbeatAdvanced(previous, current) {
  const before = heartbeatCursor(previous);
  const after = heartbeatCursor(current);
  const beforeTs = Date.parse(before.lastHeartbeatAt);
  const afterTs = Date.parse(after.lastHeartbeatAt);
  if (!Number.isFinite(beforeTs) || !Number.isFinite(afterTs)) return false;
  if (afterTs < beforeTs) return false;
  // collectors/health combines the newest raw Rust heartbeat timestamp with the newest
  // Forwarder-enriched metrics. A newer timestamp alone can therefore be a raw heartbeat and is
  // not a safe drain barrier. The E2E collectors post runtime snapshots every second, so each
  // enriched heartbeat changes this bounded metrics fingerprint even when no event counter moves.
  return after.filterMetricsFingerprint !== before.filterMetricsFingerprint;
}

function finalShutdownHeartbeatAdvanced(previous, current) {
  const beforePosts = Number(previous?.filterMetrics?.runtimeSnapshotPosts);
  const afterPosts = Number(current?.filterMetrics?.runtimeSnapshotPosts);
  const beforeEpoch = Number(previous?.filterMetrics?.runtimeLeaseEpoch);
  const afterEpoch = Number(current?.filterMetrics?.runtimeLeaseEpoch);
  const beforeSnapshotAt = Date.parse(previous?.filterMetrics?.lastRuntimeSnapshotAt || '');
  const afterSnapshotAt = Date.parse(current?.filterMetrics?.lastRuntimeSnapshotAt || '');
  return previous?.filterMetrics?.shutdownFinal !== true &&
    current?.filterMetrics?.shutdownFinal === true &&
    Number.isFinite(beforePosts) && Number.isFinite(afterPosts) &&
    afterPosts > beforePosts &&
    Number.isSafeInteger(beforeEpoch) && beforeEpoch > 0 && afterEpoch === beforeEpoch &&
    Number.isFinite(beforeSnapshotAt) && Number.isFinite(afterSnapshotAt) &&
    afterSnapshotAt > beforeSnapshotAt &&
    heartbeatAdvanced(previous, current);
}

async function waitForNextHeartbeat(apiBase, collector, previousHeartbeat, label, predicate = () => true) {
  const before = heartbeatCursor(previousHeartbeat);
  assert.ok(Number.isFinite(Date.parse(before.lastHeartbeatAt)), 'heartbeat barrier is missing a valid timestamp');
  return await eventually(label, async () => {
    const item = await queryHeartbeat(apiBase, collector);
    return heartbeatAdvanced(previousHeartbeat, item) && predicate(item) ? item : undefined;
  }, 30_000, 200);
}

async function waitForK8sCanaryIdentity(options, runRecord, nodeName) {
  return await eventually('Kubernetes filter canary workload identity', async () => {
    const snapshot = await requestJson(
      options.k8sApiBase,
      'identity/snapshot?nodeName=' + encodeURIComponent(nodeName),
    );
    if (snapshot?.ready !== true) return undefined;
    const entry = snapshot.entries?.find((candidate) =>
      candidate.classification === 'unknown' &&
      candidate.podName === runRecord.name &&
      candidate.containerName === 'canary' &&
      candidate.ids?.includes(runRecord.containerId),
    );
    return entry ? { entry, snapshotVersion: Number(snapshot.version) || 0 } : undefined;
  }, 60_000, 500);
}

async function executeFilterCanaryScenario(context, collector) {
  const { environment, phase, apiBase, collectorId } = collector;
  const before = await queryHeartbeat(apiBase, collectorId);
  const runRecord = environment === 'k8s'
    ? await startK8sFilterCanary(context.options, phase, context.k8sNode)
    : await startDockerFilterCanary(context.options, environment, phase);
  let placement;
  try {
    if (environment === 'docker') {
      const beforeEntries = Number(before?.filterMetrics?.dockerEntries) || 0;
      placement = await eventually('Docker filter canary discovery', async () => {
        const item = await queryHeartbeat(apiBase, collectorId);
        return item?.filterMetrics?.dockerReady === true &&
          Number(item?.filterMetrics?.dockerEntries) >= beforeEntries + 1
          ? { dockerEntries: item.filterMetrics.dockerEntries }
          : undefined;
      }, 30_000, 200);
    } else if (environment === 'k8s') {
      placement = await waitForK8sCanaryIdentity(context.options, runRecord, context.k8sNode);
      const requiredVersion = placement.snapshotVersion;
      await eventually('Kubernetes collector consumed filter-canary identity snapshot', async () => {
        const item = await queryHeartbeat(apiBase, collectorId);
        return item?.filterMetrics?.identitySnapshotReady === true &&
          Number(item.filterMetrics.identitySnapshotVersion) >= requiredVersion
          ? item
          : undefined;
      }, 30_000, 200);
    }
    await armFilterWitness(collector, runRecord.marker);
    const quietBarrier = await queryHeartbeat(apiBase, collectorId);
    const armedHeartbeat = await waitForNextHeartbeat(
      apiBase,
      collectorId,
      quietBarrier,
      environment + ' filter canary heartbeat barrier',
    );
    await triggerFilterCanary(runRecord);
    await waitForFilterCanaryProcess(runRecord);
    const rawWitness = await waitForFilterWitness(collector, runRecord);
    const metricName = phase === 'shadow' ? 'wouldDiscoveryBudgetDrop' : 'discoveryBudgetDropped';
    const counterHeartbeat = await waitForNextHeartbeat(
      apiBase,
      collectorId,
      armedHeartbeat,
      environment + ' correlated filter counter ' + metricName,
      (item) => Number(item?.filterMetrics?.[metricName]) > 0 &&
        Boolean(matchingFilterReceipt(item, runRecord, rawWitness)),
    );
    const filterReceipt = matchingFilterReceipt(counterHeartbeat, runRecord, rawWitness);
    assert.ok(filterReceipt, environment + ' filter heartbeat has no matching suppression receipt');
    let event;
    if (phase === 'shadow') {
      event = await waitForUnknownCanaryEvent(
        apiBase,
        collectorId,
        runRecord.marker,
        environment,
        runRecord.containerId,
      );
    } else {
      const drained = await waitForNextHeartbeat(
        apiBase,
        collectorId,
        counterHeartbeat,
        environment + ' enforce post-filter drain heartbeat',
        (item) => !matchingFilterReceipt(item, runRecord, rawWitness),
      );
      const firstFiltered = await queryEvents(apiBase, collectorId, runRecord.marker);
      assert.equal(firstFiltered.total, 0, environment + ' enforce leaked the unknown filter canary into L1');
      const stable = await waitForNextHeartbeat(
        apiBase,
        collectorId,
        drained,
        environment + ' enforce stable absence heartbeat',
        (item) => !matchingFilterReceipt(item, runRecord, rawWitness),
      );
      const filtered = await queryEvents(apiBase, collectorId, runRecord.marker);
      assert.equal(filtered.total, 0, environment + ' enforce canary appeared after the drain interval');
      placement = { ...placement, enforceAbsenceCheckedThrough: stable.lastHeartbeatAt };
    }
    return {
      marker: runRecord.marker,
      classification: 'unknown',
      processExecuted: true,
      shadowVisible: phase === 'shadow',
      filterMetric: phase === 'shadow' ? 'wouldDiscoveryBudgetDrop' : 'discoveryBudgetDropped',
      filterMetricValue: Number(counterHeartbeat.filterMetrics?.[
        phase === 'shadow' ? 'wouldDiscoveryBudgetDrop' : 'discoveryBudgetDropped'
      ]) || 0,
      rawWitness: sanitized(rawWitness),
      filterReceipt: sanitized(filterReceipt),
      placement: sanitized(placement),
      event: event ? minimalEvent(event) : undefined,
    };
  } finally {
    if (environment === 'k8s') {
      if (ledger.k8sPods.get(runRecord.namespace)?.has(runRecord.name)) {
        await deleteOwnedK8s('pod', runRecord.namespace, runRecord.name, ledger.k8sPods);
      }
      if (ledger.k8sSecrets.get(runRecord.namespace)?.has(runRecord.secretName)) {
        await deleteOwnedK8s('secret', runRecord.namespace, runRecord.secretName, ledger.k8sSecrets);
      }
    } else if (ledger.dockerContainers.has(runRecord.name)) {
      await stopOwnedDockerContainer(runRecord.name, true);
    }
  }
}

function validateLifecycleIdentity(running, terminal, environment) {
  assert.equal(runtimeIdentityIsComplete(running), true, environment + ' running ProcessKey identity is incomplete');
  assert.equal(terminal.agentInstanceId, running.agentInstanceId, environment + ' instance ID changed at termination');
  assert.equal(terminal.rootPid, running.rootPid, environment + ' root PID changed at termination');
  assert.equal(terminal.rootStartTimeTicks, running.rootStartTimeTicks, environment + ' root start time changed at termination');
  assert.equal(terminal.hostId, running.hostId, environment + ' host ID changed at termination');
  assert.equal(terminal.bootId, running.bootId, environment + ' boot ID changed at termination');
  assert.ok(terminal.rootGeneration >= running.rootGeneration, environment + ' generation regressed');
  assert.ok(['probable_agent', 'confirmed_agent'].includes(terminal.classification), environment + ' Agent classification is invalid');
  if (environment === 'docker' || environment === 'k8s') {
    assert.ok(terminal.physicalWorkloadId || terminal.workloadRef, environment + ' process identity was not enriched with workload placement');
  }
}

async function assertApiIsolation(apiPlanes, intendedPlane, collector, markerValue) {
  const evidence = [];
  for (const plane of apiPlanes) {
    if (plane.name === intendedPlane || !plane.available) continue;
    const runtime = await queryRuntime(plane.baseUrl, { collectorId: collector });
    const events = await queryEvents(plane.baseUrl, collector, markerValue);
    assert.equal(runtime.total, 0, collector + ' leaked into ' + plane.name + ' runtime API');
    assert.equal(events.total, 0, collector + ' marker leaked into ' + plane.name + ' event API');
    evidence.push({ plane: plane.name, runtimeInstances: runtime.total, markerEvents: events.total });
  }
  return evidence;
}

function expectedScopeForAgent(agent) {
  if (agent === 'host-codex') return 'codex';
  if (agent === 'host-kimi') return 'kimi-cli';
  return 'pi';
}

async function executeHostAgentScenario(context, phase, agent) {
  const environment = 'host';
  const apiBase = context.options.hostApiBase;
  const id = collectorId(context.options, environment, phase);
  const markerValue = marker(context.options, environment, phase, agent);
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  let runRecord;
  try {
    runRecord = await launchHostAgent(context.options, phase, agent, markerValue);
    const running = await waitForNewRunningInstance(
      apiBase,
      id,
      baselineIds,
      expectedScopeForAgent(agent),
      async (candidate) => {
        const placement = await matchHostRuntimeToSystemdService(candidate, runRecord);
        if (placement) runRecord.runtimePlacement = placement;
        return Boolean(placement);
      },
    );
    const proof = await finishHostAgent(runRecord);
    const event = await waitForMarkerEvent(apiBase, id, markerValue, running.agentInstanceId);
    const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
    validateLifecycleIdentity(running, terminal, environment);
    const isolation = await assertApiIsolation(context.apiPlanes, environment, id, markerValue);
    return {
      agent,
      marker: markerValue,
      proof,
      running: minimalRuntime(running),
      terminal: minimalRuntime(terminal),
      markerEvent: minimalEvent(event),
      isolation,
    };
  } catch (error) {
    if (runRecord && error && typeof error === 'object') {
      try {
        await quiesceHostAgentForDiagnostic(runRecord);
      } catch (terminationError) {
        runRecord.diagnosticTerminationError = boundedRedactedText(
          terminationError?.message || terminationError,
          2_048,
        );
      }
      try {
        error.hostAgentDiagnostic = await persistHostAgentFailureDiagnostic(context.options, runRecord, error);
      } catch (diagnosticError) {
        error.hostAgentDiagnosticError = boundedRedactedText(diagnosticError?.message || diagnosticError, 2_048);
      }
    }
    throw error;
  }
}

async function executeDockerPiScenario(context, phase) {
  const environment = 'docker';
  const apiBase = context.options.dockerApiBase;
  const id = collectorId(context.options, environment, phase);
  const markerValue = marker(context.options, environment, phase, 'pi');
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  const runRecord = await startDockerPi(context.options, phase, markerValue);
  const running = await waitForNewRunningInstance(apiBase, id, baselineIds, 'pi');
  const proof = await dockerPiProof(runRecord);
  const event = await waitForMarkerEvent(apiBase, id, markerValue, running.agentInstanceId);
  await stopOwnedDockerContainer(runRecord.name, true);
  const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
  validateLifecycleIdentity(running, terminal, environment);
  const isolation = await assertApiIsolation(context.apiPlanes, environment, id, markerValue);
  return {
    agent: 'docker-pi',
    marker: markerValue,
    proof,
    running: minimalRuntime(running),
    terminal: minimalRuntime(terminal),
    markerEvent: minimalEvent(event),
    isolation,
  };
}

async function executeK8sPiScenario(context, phase) {
  const environment = 'k8s';
  const apiBase = context.options.k8sApiBase;
  const id = collectorId(context.options, environment, phase);
  const markerValue = marker(context.options, environment, phase, 'pi');
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  const runRecord = await startK8sPi(
    context.options,
    phase,
    context.k8sNode,
    context.k8sSecret,
    markerValue,
  );
  const running = await waitForNewRunningInstance(apiBase, id, baselineIds, 'pi');
  const proof = await k8sPiProof(runRecord);
  const event = await waitForMarkerEvent(apiBase, id, markerValue, running.agentInstanceId);
  await deleteOwnedK8s('pod', runRecord.namespace, runRecord.name, ledger.k8sPods);
  await deleteOwnedK8s('secret', runRecord.namespace, runRecord.markerSecretName, ledger.k8sSecrets);
  const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
  validateLifecycleIdentity(running, terminal, environment);
  const isolation = await assertApiIsolation(context.apiPlanes, environment, id, markerValue);
  return {
    agent: 'k8s-pi',
    marker: markerValue,
    proof,
    running: minimalRuntime(running),
    terminal: minimalRuntime(terminal),
    markerEvent: minimalEvent(event),
    isolation,
  };
}

async function stopPhaseCollector(collector, requireTracked = false) {
  let stopped = false;
  if (collector.environment === 'host' || collector.environment === 'docker') {
    if (ledger.dockerContainers.has(collector.name)) {
      if (collector.shutdownRequested && await waitForOwnedDockerContainerStopped(collector.name)) {
        await removeTrackedDockerContainer(collector.name, true);
      } else {
        await stopOwnedDockerContainer(collector.name, true, COLLECTOR_OUTER_GRACE_SECONDS);
      }
      stopped = true;
    }
  } else if (ledger.k8sPods.get(collector.namespace)?.has(collector.name)) {
    if (collector.shutdownRequested) {
      await removeTrackedK8sResource(
        'pod', collector.namespace, collector.name, ledger.k8sPods, true,
      );
    } else {
      await deleteOwnedK8s('pod', collector.namespace, collector.name, ledger.k8sPods);
    }
    stopped = true;
  }
  if (requireTracked && !stopped) {
    throw new Error(collector.environment + ' collector disappeared before final heartbeat collection');
  }
}

async function requestPhaseCollectorShutdown(collector) {
  if (collector.shutdownRequested) return;
  if (collector.environment === 'host' || collector.environment === 'docker') {
    const ownership = ledger.dockerContainers.get(collector.name);
    if (!ownership?.nonce) {
      throw new Error('missing tracked Docker collector ownership: ' + collector.name);
    }
    const state = await dockerResourceState(ownership.id || collector.name, ledger.runId, ownership);
    if (!state.exists || !state.owned) {
      throw new Error('refused to signal Docker collector after ownership changed: ' + collector.name);
    }
    ownership.id ||= state.id;
    const signaled = await trackMutation(() => run(
      'docker', ['kill', '--signal', 'TERM', ownership.id],
      { allowFailure: true, timeoutMs: 15_000 },
    ));
    if (signaled.code !== 0) {
      throw new Error('Docker collector shutdown request failed for ' + collector.name + ': ' +
        redact(signaled.stderr || signaled.stdout));
    }
  } else {
    const ownership = ledger.k8sPods.get(collector.namespace)?.get(collector.name);
    if (!ownership?.nonce) {
      throw new Error('missing tracked Kubernetes collector ownership: ' +
        collector.namespace + '/' + collector.name);
    }
    const state = await k8sResourceState(
      'pod', collector.namespace, collector.name, ledger.runId, ownership,
    );
    if (!state.exists || !state.owned) {
      throw new Error('refused to terminate Kubernetes collector after ownership changed: ' +
        collector.namespace + '/' + collector.name);
    }
    ownership.uid ||= state.uid;
    const requested = await trackMutation(() => run('kubectl', [
      '-n', collector.namespace, 'delete', 'pod',
      '--selector', 'anysentry.io/e2e-ownership=' + ownership.nonce,
      '--field-selector', 'metadata.name=' + collector.name,
      '--grace-period=' + String(COLLECTOR_OUTER_GRACE_SECONDS),
      '--wait=false',
    ], { allowFailure: true, timeoutMs: 20_000 }));
    if (requested.code !== 0) {
      throw new Error('Kubernetes collector shutdown request failed for ' +
        collector.namespace + '/' + collector.name + ': ' + redact(requested.stderr));
    }
  }
  collector.shutdownRequested = true;
}

async function finalizeCollectorPhase(context, collector, sampler, scenarioResults, filterCanary) {
  await delay(2_500);
  const beforeStop = await queryHeartbeat(collector.apiBase, collector.collectorId);
  assert.ok(beforeStop?.lastHeartbeatAt, collector.environment + ' collector has no heartbeat before shutdown');
  assert.notEqual(
    beforeStop.filterMetrics?.shutdownFinal,
    true,
    collector.environment + ' collector reported a final heartbeat before shutdown',
  );
  assert.ok(
    Number.isFinite(Number(beforeStop.filterMetrics?.runtimeSnapshotPosts)),
    collector.environment + ' collector has no runtime snapshot count before shutdown',
  );
  await requestPhaseCollectorShutdown(collector);
  const finalHeartbeat = await waitForNextHeartbeat(
    collector.apiBase,
    collector.collectorId,
    beforeStop,
    collector.environment + ' final enriched shutdown heartbeat',
    (item) => finalShutdownHeartbeatAdvanced(beforeStop, item),
  );
  await stopPhaseCollector(collector, true);
  const samples = await sampler.stop();
  const metrics = aggregateHeartbeatSamples(samples, finalHeartbeat);
  assertPhaseMetrics(collector.phase, metrics, collector.environment);
  const events = await queryEvents(collector.apiBase, collector.collectorId);
  const runtime = await queryRuntime(collector.apiBase, { collectorId: collector.collectorId });
  const expectedIds = new Set(scenarioResults.map((result) => result.running.agentInstanceId));
  const unexpected = runtime.items.filter((item) =>
    !collector.bootstrapInstanceIds.has(item.agentInstanceId) &&
    !expectedIds.has(item.agentInstanceId),
  );
  assert.ok(
    unexpected.length <= context.options.maxUnexpectedAgents,
    collector.environment + '/' + collector.phase + ' discovered unexpected Agent roots: ' +
      unexpected.map((item) => item.agentScopeId + ':' + item.agentInstanceId).join(', '),
  );
  const classifications = events.items.reduce((counts, item) => {
    const name = item.attribution?.classification || 'missing';
    counts[name] = (counts[name] || 0) + 1;
    return counts;
  }, {});
  return {
    environment: collector.environment,
    phase: collector.phase,
    collectorId: collector.collectorId,
    scenarios: scenarioResults,
    filterCanary,
    metrics,
    l1: {
      routedEvents: events.total,
      sampledEvents: events.items.length,
      classifications,
    },
    runtime: {
      total: runtime.total,
      summary: runtime.summary,
      unexpected: unexpected.map(minimalRuntime),
    },
  };
}

async function executeEnvironmentPhase(context, environment, phase) {
  let collector;
  if (environment === 'host') {
    collector = await startDockerCollector(context.options, environment, phase, context.options.hostApiBase);
  } else if (environment === 'docker') {
    collector = await startDockerCollector(context.options, environment, phase, context.options.dockerApiBase);
  } else {
    collector = await startK8sCollector(context.options, phase, context.k8sNode);
  }
  const bootstrap = await queryRuntime(collector.apiBase, { collectorId: collector.collectorId });
  collector.bootstrapInstanceIds = new Set(bootstrap.items.map((item) => item.agentInstanceId));
  const sampler = startHeartbeatSampler(collector.apiBase, collector.collectorId);
  const scenarios = [];
  let filterCanary;
  let primaryError;
  try {
    filterCanary = await executeFilterCanaryScenario(context, collector);
    if (environment === 'host') {
      for (const agent of context.options.agents.filter((name) => name.startsWith('host-'))) {
        scenarios.push(await executeHostAgentScenario(context, phase, agent));
      }
    } else if (environment === 'docker') {
      scenarios.push(await executeDockerPiScenario(context, phase));
    } else {
      scenarios.push(await executeK8sPiScenario(context, phase));
    }
    return await finalizeCollectorPhase(context, collector, sampler, scenarios, filterCanary);
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    primaryError.incompletePhase = diagnosticSanitized({
      environment,
      phase,
      collectorId: collector.collectorId,
      scenarios,
      filterCanary,
    });
    throw primaryError;
  } finally {
    const cleanupFailures = [];
    try {
      await sampler.stop();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await stopPhaseCollector(collector);
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length) {
      const cleanupError = new AggregateError(
        cleanupFailures,
        environment + '/' + phase + ' collector phase cleanup failed: ' +
          cleanupFailures.map((error) => redact(error instanceof Error ? error.message : String(error))).join('; '),
      );
      if (primaryError) {
        primaryError.phaseCleanupError = diagnosticSanitized({
          name: cleanupError.name,
          message: cleanupError.message,
        });
      } else {
        throw cleanupError;
      }
    }
  }
}

function phaseComparison(results) {
  const grouped = new Map();
  for (const result of results) {
    if (!grouped.has(result.environment)) grouped.set(result.environment, {});
    grouped.get(result.environment)[result.phase] = result;
  }
  return [...grouped.entries()].map(([environment, phases]) => {
    const compact = (phase) => phase ? {
      AgentInstances: phase.scenarios.length,
      observed: phase.metrics.totals.observed,
      forwarded: phase.metrics.totals.forwarded,
      l1RoutedEvents: phase.l1.routedEvents,
      confirmedAgentEvents: phase.metrics.totals.confirmedAgent,
      probableAgentEvents: phase.metrics.totals.probableAgent,
      actualDrops: phase.metrics.totals.filteredNonAgent + phase.metrics.totals.filteredNoise +
        phase.metrics.totals.discoveryBudgetDropped,
      wouldDrop: phase.metrics.totals.wouldFilterNonAgent + phase.metrics.totals.wouldFilterNoise +
        phase.metrics.totals.wouldDiscoveryBudgetDrop,
      unexpectedAgentInstances: phase.runtime.unexpected.length,
      filterCanary: phase.filterCanary ? {
        processExecuted: phase.filterCanary.processExecuted,
        shadowVisible: phase.filterCanary.shadowVisible,
        metric: phase.filterCanary.filterMetric,
        metricValue: phase.filterCanary.filterMetricValue,
        rawWitnessDigest: phase.filterCanary.rawWitness?.lineSha256,
      } : undefined,
    } : undefined;
    return { environment, shadow: compact(phases.shadow), enforce: compact(phases.enforce) };
  });
}

function requestedPlaneSet(options) {
  return new Set([
    ...(options.agents.some((agent) => agent.startsWith('host-')) ? ['host'] : []),
    ...(options.agents.includes('docker-pi') ? ['docker'] : []),
    ...(options.agents.includes('k8s-pi') ? ['k8s'] : []),
  ]);
}

function expectedScenarioCount(options, environment) {
  if (environment === 'host') return options.agents.filter((agent) => agent.startsWith('host-')).length;
  return 1;
}

function validateShadowGate(requestedPlanes, shadowResults, options) {
  assert.ok(requestedPlanes.size > 0, 'shadow gate requires at least one requested API plane');
  assert.equal(shadowResults.length, requestedPlanes.size, 'shadow did not complete every requested API plane');
  const evidence = [];
  for (const result of shadowResults) {
    assert.equal(result.phase, 'shadow', 'enforce attempted before a complete shadow result');
    assert.ok(requestedPlanes.has(result.environment), 'shadow returned an unrequested environment');
    assert.equal(
      result.scenarios.length,
      expectedScenarioCount(options, result.environment),
      result.environment + ' shadow did not complete every requested real Agent scenario',
    );
    assert.ok(
      result.runtime.unexpected.length <= options.maxUnexpectedAgents,
      result.environment + ' shadow exceeded the allowed unexpected Agent root count',
    );
    assert.ok(Number(result.metrics.last?.runtimeLeaseEpoch) > 0, result.environment + ' shadow has no runtime lease epoch');
    assert.ok(Number(result.metrics.last?.runtimeSnapshotPosts) > 0, result.environment + ' shadow posted no runtime snapshots');
    assert.equal(result.filterCanary?.processExecuted, true, result.environment + ' shadow filter canary did not execute');
    assert.equal(result.filterCanary?.shadowVisible, true, result.environment + ' shadow filter canary was not visible');
    assert.equal(result.filterCanary?.filterMetric, 'wouldDiscoveryBudgetDrop');
    assert.ok(result.filterCanary?.filterMetricValue > 0, result.environment + ' shadow filter counter did not increase');
    assert.match(result.filterCanary?.rawWitness?.lineSha256 || '', /^[a-f0-9]{64}$/u, result.environment + ' shadow has no raw Observer witness');
    for (const scenario of result.scenarios) {
      assert.equal(scenario.proof?.realLlm, true, scenario.agent + ' did not prove a real model run');
      assert.equal(scenario.proof?.toolResult?.markerPresent ?? scenario.proof?.markerPresent, true, scenario.agent + ' has no tool result marker');
      assert.ok(scenario.markerEvent?.eventId, scenario.agent + ' has no attributed marker event');
      assert.ok(['exited', 'lost'].includes(scenario.terminal?.runtimeState), scenario.agent + ' has no terminal lifecycle state');
    }
    evidence.push({
      environment: result.environment,
      scenarios: result.scenarios.length,
      runtimeLeaseEpoch: result.metrics.last.runtimeLeaseEpoch,
      runtimeSnapshotPosts: result.metrics.last.runtimeSnapshotPosts,
      l1RoutedEvents: result.l1.routedEvents,
      unexpectedAgentInstances: result.runtime.unexpected.length,
    });
  }
  return {
    passed: true,
    checkedAt: new Date().toISOString(),
    criteria: [
      'all selected planes completed shadow',
      'every scenario used a real model and produced a tool marker',
      'every marker was attributed and reached a terminal lifecycle state',
      'runtime lease and snapshot reporting were healthy',
      'unexpected Agent roots stayed within the configured acceptance threshold',
    ],
    evidence,
  };
}

async function executeE2e(options, preflightResult) {
  const protocolEvidence = await runLocalProtocolTests();
  ledger.tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-lifecycle-' + options.runId + '-'));
  ledger.tempRootIdentity = localPathIdentity(await fs.lstat(ledger.tempRoot));
  const needsPiCredential = options.agents.includes('docker-pi') || options.agents.includes('k8s-pi');
  if (needsPiCredential) {
    assert.ok(preflightResult.apiState.keyFile, 'DeepSeek key file fingerprint is unavailable');
    options = {
      ...options,
      keyFile: await stageCredentialFile(options, preflightResult.apiState.keyFile),
    };
  }
  options = {
    ...options,
    resolvedDockerImages: preflightResult.apiState.dockerImages,
    resolvedHostCommands: preflightResult.apiState.hostAgentCommands,
    forwarderModuleHashes: await forwarderModuleHashes(),
  };
  await fs.mkdir(options.artifactDir, { recursive: true, mode: 0o700 });
  const artifactStat = await fs.lstat(options.artifactDir);
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
    throw new Error('artifact output path is not a trusted directory: ' + options.artifactDir);
  }
  ledger.artifactRoot = path.resolve(options.artifactDir);
  ledger.artifactRootIdentity = localPathIdentity(artifactStat);
  const apiPlanes = [
    { name: 'host', baseUrl: options.hostApiBase, available: Boolean(preflightResult.apiState.host?.health && preflightResult.apiState.host?.runtime) },
    { name: 'docker', baseUrl: options.dockerApiBase, available: Boolean(preflightResult.apiState.docker?.health && preflightResult.apiState.docker?.runtime) },
    { name: 'k8s', baseUrl: options.k8sApiBase, available: Boolean(preflightResult.apiState.k8s?.health && preflightResult.apiState.k8s?.runtime) },
  ];
  const selectedPlanes = new Set([
    ...(options.agents.some((agent) => agent.startsWith('host-')) && apiPlanes[0].available ? ['host'] : []),
    ...(options.agents.includes('docker-pi') ? ['docker'] : []),
    ...(options.agents.includes('k8s-pi') ? ['k8s'] : []),
  ]);
  const requestedPlanes = requestedPlaneSet(options);
  assert.ok(selectedPlanes.size > 0, 'no requested API plane is available for execution');
  assert.deepEqual([...selectedPlanes].sort(), [...requestedPlanes].sort(), 'one or more requested API planes are unavailable');
  const context = {
    options,
    apiPlanes,
    k8sNode: undefined,
    k8sSecret: undefined,
  };
  const report = {
    schema: 'anysentry.real_agent_lifecycle_e2e.report.v1',
    runId: options.runId,
    startedAt: new Date().toISOString(),
    options: {
      phases: options.phases,
      allowEnforce: options.allowEnforce,
      allowHostAgents: options.allowHostAgents,
      allowHostFullAccess: options.allowHostFullAccess,
      hostCodexSandboxMode: hostCodexSandboxMode(options),
      agents: options.agents,
      maxUnexpectedAgents: options.maxUnexpectedAgents,
    },
    apiPlanes: apiPlanes.map((plane) => ({ name: plane.name, baseUrl: plane.baseUrl, available: plane.available })),
    protocolEvidence,
    phaseResults: [],
  };
  try {
    if (selectedPlanes.has('k8s')) {
      context.k8sNode = await resolveK8sNode(options);
      context.k8sSecret = await createK8sCredentialSecret(options);
      report.kubernetesNode = context.k8sNode;
    }
    for (const phase of options.phases) {
      if (phase === 'enforce') {
        assert.equal(report.shadowGate?.passed, true, 'enforce refused because this run did not pass shadow');
      }
      const phaseStart = report.phaseResults.length;
      if (selectedPlanes.has('host')) report.phaseResults.push(await executeEnvironmentPhase(context, 'host', phase));
      if (selectedPlanes.has('docker')) report.phaseResults.push(await executeEnvironmentPhase(context, 'docker', phase));
      if (selectedPlanes.has('k8s')) report.phaseResults.push(await executeEnvironmentPhase(context, 'k8s', phase));
      if (phase === 'shadow') {
        report.shadowGate = validateShadowGate(requestedPlanes, report.phaseResults.slice(phaseStart), options);
      }
    }
    for (const result of report.phaseResults.filter((item) => item.phase === 'enforce')) {
      assert.equal(result.filterCanary?.processExecuted, true, result.environment + ' enforce filter canary did not execute');
      assert.equal(result.filterCanary?.shadowVisible, false, result.environment + ' enforce filter canary reached L1');
      assert.equal(result.filterCanary?.filterMetric, 'discoveryBudgetDropped');
      assert.ok(result.filterCanary?.filterMetricValue > 0, result.environment + ' enforce filter counter did not increase');
      assert.match(result.filterCanary?.rawWitness?.lineSha256 || '', /^[a-f0-9]{64}$/u, result.environment + ' enforce has no raw Observer witness');
    }
    if (context.k8sSecret && ledger.k8sSecrets.get(options.k8sWorkloadNamespace)?.has(context.k8sSecret)) {
      await deleteOwnedK8s(
        'secret',
        options.k8sWorkloadNamespace,
        context.k8sSecret,
        ledger.k8sSecrets,
      );
      context.k8sSecret = undefined;
    }
    await removeRunCredential();
    report.comparison = phaseComparison(report.phaseResults);
    report.completedAt = new Date().toISOString();
    report.success = true;
    const evidence = await writeJsonEvidence(options.artifactDir, 'report.json', report);
    return { report, evidence };
  } catch (error) {
    report.comparison = phaseComparison(report.phaseResults);
    report.completedAt = new Date().toISOString();
    report.success = false;
    report.failure = {
      name: error instanceof Error ? error.name : 'Error',
      message: boundedRedactedText(error instanceof Error ? error.message : String(error), 4_096).tail,
      ...(error?.hostAgentDiagnostic ? { hostAgentDiagnostic: error.hostAgentDiagnostic } : {}),
      ...(error?.hostAgentDiagnosticError ? { hostAgentDiagnosticError: error.hostAgentDiagnosticError } : {}),
      ...(error?.phaseCleanupError ? { phaseCleanupError: error.phaseCleanupError } : {}),
    };
    if (error?.incompletePhase) report.incompletePhase = diagnosticSanitized(error.incompletePhase);
    try {
      const evidence = await writeJsonEvidence(options.artifactDir, 'report.json', report);
      if (error instanceof Error) error.message += '; failure evidence=' + evidence.file;
    } catch {}
    throw error;
  }
}

async function selfTestSafetyIo() {
  const probePrefix = path.join(os.tmpdir(), 'anysentry-codex-sandbox-probe-');
  let transientDirectory;
  try {
    transientDirectory = await createTrackedTransientDirectory(probePrefix);
    assert.equal(ledger.transientDirectories.has(transientDirectory), true);
    await removeTrackedTransientDirectory(transientDirectory);
    assert.equal(ledger.transientDirectories.has(transientDirectory), false);
    assert.equal((await localPathState(transientDirectory)).exists, false);
    transientDirectory = undefined;
  } finally {
    if (transientDirectory) await removeTrackedTransientDirectory(transientDirectory, true).catch(() => {});
  }

  const child = spawnCaptured('/bin/sleep', ['30'], {
    detached: true,
    env: {},
    inheritEnv: false,
  });
  const runRecord = { record: child };
  try {
    await assert.rejects(
      () => hostAgentFailureDiagnostic(runRecord, new Error('self-test')),
      /while its process is still running/u,
    );
    await quiesceHostAgentForDiagnostic(runRecord);
    assert.equal(child.finished, true);
    assert.equal(ledger.children.has(child), false);
  } finally {
    if (!child.finished) await terminateProcess(child).catch(() => {});
  }

  const previousArtifactRoot = ledger.artifactRoot;
  const previousArtifactIdentity = ledger.artifactRootIdentity;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-evidence-self-test-'));
  const rootIdentity = localPathIdentity(await fs.lstat(root));
  const artifactDirectory = path.join(root, 'artifacts');
  const outsideTarget = path.join(root, 'outside.json');
  try {
    const proofDirectory = path.join(root, 'proof');
    await fs.mkdir(proofDirectory, { mode: 0o700 });
    assert.deepEqual(
      await readLocalProofTextFile(proofDirectory, 'tool-events.log'),
      { exists: false, status: 'missing', bytes: 0 },
    );
    await fs.writeFile(path.join(proofDirectory, 'tool-events.log'), '', { mode: 0o600 });
    const emptyProof = await readLocalProofTextFile(proofDirectory, 'tool-events.log');
    assert.equal(emptyProof.status, 'ok');
    assert.equal(emptyProof.bytes, 0);
    await fs.symlink(outsideTarget, path.join(proofDirectory, 'model-result.txt'));
    assert.equal(
      (await readLocalProofTextFile(proofDirectory, 'model-result.txt')).status,
      'unsafe_file_type',
    );

    await fs.mkdir(artifactDirectory, { mode: 0o700 });
    ledger.artifactRoot = path.resolve(artifactDirectory);
    ledger.artifactRootIdentity = localPathIdentity(await fs.lstat(artifactDirectory));
    await fs.symlink(outsideTarget, path.join(artifactDirectory, 'linked.json'));
    await assert.rejects(
      () => writeJsonEvidence(artifactDirectory, 'linked.json', { status: 'must-not-write' }),
      /EEXIST|exist/iu,
    );
    assert.equal((await localPathState(outsideTarget)).exists, false);
    const safeEvidence = await writeJsonEvidence(artifactDirectory, 'safe.json', {
      authorization: ['Bearer opaque-authorization'],
      credentials: { token: 'opaque-token' },
      accessPolicy: { fullAccessAuthorized: true, sandboxMode: 'danger-full-access' },
      status: 'safe',
    });
    const safeContent = await fs.readFile(safeEvidence.file, 'utf8');
    assert.doesNotMatch(safeContent, /opaque-authorization|opaque-token/u);
    assert.equal(JSON.parse(safeContent).accessPolicy.sandboxMode, 'danger-full-access');
    await fs.rename(artifactDirectory, artifactDirectory + '-original');
    await fs.mkdir(artifactDirectory, { mode: 0o700 });
    await assert.rejects(
      () => writeJsonEvidence(artifactDirectory, 'after-replacement.json', { status: 'must-not-write' }),
      /directory identity changed/u,
    );
  } finally {
    ledger.artifactRoot = previousArtifactRoot;
    ledger.artifactRootIdentity = previousArtifactIdentity;
    const rootState = await localPathState(root);
    if (rootState.exists && sameLocalPathIdentity(rootState.identity, rootIdentity)) {
      await fs.rm(root, { recursive: true });
    }
  }
}

async function selfTestHostSystemdLauncher(options) {
  const manager = await run('systemctl', ['--user', 'is-system-running'], {
    allowFailure: true,
    timeoutMs: 10_000,
  });
  assert.equal(manager.code, 0, 'host launcher self-test requires a running systemd user manager');
  assert.equal(manager.stdout.trim(), 'running', 'host launcher self-test requires a healthy systemd user manager');
  const unitName = hostAgentUnitName(options, 'runner-self-test', 'host-codex');
  assert.equal((await systemdUnitState(unitName)).exists, false, 'host launcher self-test unit already exists');
  const payloadNonce = ownershipNonce();
  const environment = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    ANYSENTRY_HOST_RUNNER_SELF_TEST: payloadNonce,
  };
  let service;
  let childPid;
  let controlGroup;
  try {
    service = await launchHostAgentService(options, 'runner-self-test', 'host-codex', {
      schema: HOST_AGENT_RUNNER_SELF_TEST_SCHEMA,
      agent: 'self-test',
      command: process.execPath,
      args: [scriptPath, HOST_AGENT_CHILD_SELF_TEST_OPTION, payloadNonce],
      cwd: repoRoot,
      env: { ...environment },
    }, {
      unitName,
      proofValues: [payloadNonce, HOST_AGENT_CHILD_SELF_TEST_OPTION],
      expectedEnvironment: environment,
    });
    controlGroup = service.ownership.controlGroup;
    const [clientArgv, runnerArgv] = await Promise.all([
      processArguments(service.record.child.pid),
      processArguments(service.state.execMainPid),
    ]);
    for (const argv of [clientArgv, runnerArgv]) {
      assert.equal(argv.includes(payloadNonce), false, 'stdin payload nonce appeared in launcher argv');
      assert.equal(argv.includes(HOST_AGENT_CHILD_SELF_TEST_OPTION), false, 'stdin child command appeared in launcher argv');
    }
    const child = await eventually('host Agent systemd self-test child', async () => {
      for (const line of service.record.stdout.split(/\r?\n/u)) {
        try {
          const parsed = JSON.parse(line);
          if (parsed?.hostAgentChildSelfTest === true && positiveInteger(parsed.pid)) return parsed;
        } catch {}
      }
      if (service.record.finished) throw new Error('host Agent self-test service exited before child proof');
      return undefined;
    }, 10_000, 50);
    childPid = child.pid;
    const [childControlGroup, childAncestry] = await Promise.all([
      processUnifiedControlGroup(childPid),
      processAncestry(childPid),
    ]);
    assert.equal(controlGroupContains(controlGroup, childControlGroup), true, 'self-test child escaped the unit cgroup');
    assert.equal(
      childAncestry.some((record) => record.pid === service.state.execMainPid),
      true,
      'self-test child is not parented by the detached internal runner',
    );
    const clientExit = new Promise((resolve) => {
      service.record.child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    service.record.child.kill('SIGKILL');
    const killedClient = await clientExit;
    assert.equal(killedClient.signal, 'SIGKILL', 'self-test did not terminate the systemd-run client');
    const orphanedService = await eventually('host Agent unit after launcher-client loss', async () => {
      const state = await systemdUnitState(unitName, service.ownership);
      return state.exists && state.owned && state.activeState === 'active' ? state : undefined;
    }, 5_000, 50);
    assert.equal(orphanedService.invocationId, service.ownership.invocationId);
    await stopTrackedSystemdUnit(unitName);
    assert.equal(service.record.finished, true, 'systemd-run client was not reaped after unit cleanup');
    assert.equal(ledger.children.has(service.record), false, 'systemd-run client remained in the child ledger');
    assert.equal(ledger.systemdUnits.has(unitName), false, 'self-test unit remained in the ownership ledger');
    assert.equal((await systemdUnitState(unitName)).exists, false, 'self-test unit LoadState remained loaded');
    assert.equal(await systemdControlGroupExists(controlGroup), false, 'self-test unit cgroup remained');
    await eventually('host Agent self-test child removal', async () => {
      try {
        await fs.lstat('/proc/' + childPid);
        return undefined;
      } catch (error) {
        if (error?.code === 'ENOENT') return true;
        throw error;
      }
    }, 5_000, 50);
    return {
      unit: unitName,
      detached: service.detached.forbiddenSharedAncestorCount === 0,
      payloadAbsentFromSystemdRunArgv: true,
      clientLossRecoveredByUnitLedger: true,
      unitLoadStateRemoved: true,
      controlGroupRemoved: true,
      childRemoved: true,
    };
  } finally {
    if (ledger.systemdUnits.has(unitName)) await stopTrackedSystemdUnit(unitName, true).catch(() => {});
    if (service?.record && !service.record.finished) await reapCapturedProcess(service.record).catch(() => {});
  }
}

async function selfTest() {
  const options = parseOptions([
    '--run-id', 'self-test-001',
    '--agents', 'host-codex,docker-pi,k8s-pi',
  ]);
  assert.equal(options.execute, false);
  assert.equal(options.selfTest, false);
  assert.deepEqual(options.phases, ['shadow']);
  assert.equal(normalizeApiBase('http://127.0.0.1:29653/security-center/'), DEFAULT_DOCKER_API);
  assert.throws(() => parseOptions(['--run-id', '../unsafe']), /run-id/u);
  assert.throws(() => parseOptions(['--api-key', 'sk-not-allowed']), /unknown option/u);
  assert.throws(
    () => parseOptions(['--agents', 'host-codex', '--allow-host-full-access']),
    /allow-host-agents/u,
  );
  assert.throws(
    () => parseOptions(['--agents', 'docker-pi', '--allow-host-agents', '--allow-host-full-access']),
    /host-codex/u,
  );
  assert.throws(() => parseOptions(['--phases', 'enforce']), /allow-enforce/u);
  assert.throws(() => parseOptions(['--phases', 'enforce', '--allow-enforce']), /cannot run alone/u);
  const gated = parseOptions(['--phases', 'shadow,enforce', '--allow-enforce']);
  assert.deepEqual(gated.phases, ['shadow', 'enforce']);
  assert.equal(responseAllowsPost(new Response(null, {
    status: 204,
    headers: { Allow: 'GET, HEAD, POST' },
  })), true);
  assert.equal(responseAllowsPost(new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Methods': 'GET,HEAD,PUT,PATCH,POST,DELETE' },
  })), true);
  assert.equal(responseAllowsPost(new Response(null, {
    status: 204,
    headers: { Allow: 'GET, HEAD', 'Access-Control-Allow-Methods': 'GET, DELETE' },
  })), false);
  const plan = executionPlan(options);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.safety.deploymentManifestsOrExistingResourcesModified, false);
  assert.equal(plan.safety.protocolProbeWritesToApi, false);
  assert.equal(plan.safety.hostCodexFullAccessRequiresExplicitFlag, true);
  assert.equal(plan.hostAgentAuthorization.codexSandboxMode, 'workspace-write');
  assert.ok(plan.resources.every((resource) => resource.name.includes('self-test-001')));
  assert.notEqual(plan.apiPlanes.docker.baseUrl, plan.apiPlanes.kubernetes.baseUrl);
  assert.notEqual(plan.apiPlanes.host.baseUrl, plan.apiPlanes.docker.baseUrl);
  assert.deepEqual([...requestedPlaneSet(options)].sort(), ['docker', 'host', 'k8s']);
  assert.throws(() => validateShadowGate(new Set(), [], options), /at least one/u);
  const nonceA = ownershipNonce();
  const nonceB = ownershipNonce();
  assert.match(nonceA, /^[a-f0-9]{32}$/u);
  assert.notEqual(nonceA, nonceB);
  const runnerEnvironment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', HTTPS_PROXY: 'http://127.0.0.1:8080' };
  const runnerPayload = {
    schema: HOST_AGENT_RUNNER_SCHEMA,
    agent: 'host-codex',
    command: '/opt/anysentry/bin/codex',
    args: ['exec', 'literal-$HOME', '安全测试'],
    cwd: '/tmp/anysentry-runner-self-test',
    env: { ...runnerEnvironment },
  };
  assert.deepEqual(
    validateHostAgentRunnerPayload(runnerPayload, {
      agent: 'host-codex', command: runnerPayload.command, env: runnerEnvironment,
    }).args,
    runnerPayload.args,
  );
  assert.throws(
    () => validateHostAgentRunnerPayload({ ...runnerPayload, command: '/bin/sh' }),
    /allowlisted/u,
  );
  for (const name of ['LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'UNEXPECTED']) {
    assert.throws(
      () => validateHostAgentRunnerPayload({ ...runnerPayload, env: { ...runnerEnvironment, [name]: 'blocked' } }),
      /environment/u,
    );
  }
  assert.throws(
    () => validateHostAgentRunnerPayload({ ...runnerPayload, command: 'codex' }),
    /command/u,
  );
  assert.throws(
    () => validateHostAgentRunnerPayload(runnerPayload, {
      agent: 'host-codex', command: runnerPayload.command, env: { ...runnerEnvironment, LANG: 'C' },
    }),
    /filtered launch environment/u,
  );
  assert.throws(
    () => encodeHostAgentRunnerPayload({
      ...runnerPayload,
      args: Array.from({ length: 5 }, () => 'x'.repeat(120 * 1024)),
    }),
    /input limit/u,
  );
  const firstAck = { accepted: true, applied: true, duplicate: false, leaseEpoch: 1 };
  const replayAck = { accepted: false, applied: false, duplicate: false, leaseEpoch: 1, reason: 'runtime lease is stale' };
  assert.equal(pickAck(firstAck).applied, true);
  assert.equal(pickAck(replayAck).accepted, false);
  const running = {
    agentInstanceId: 'instance-a', agentScopeId: 'codex', runtimeState: 'running',
    rootPid: 123, rootStartTimeTicks: '456', rootGeneration: 1, hostId: 'host', bootId: 'boot',
    classification: 'probable_agent',
  };
  const terminal = { ...running, runtimeState: 'exited', exitCode: 0 };
  validateLifecycleIdentity(running, terminal, 'host');
  assert.equal(runtimeIdentityIsComplete(running), true);
  assert.throws(() => validateLifecycleIdentity(running, { ...terminal, rootStartTimeTicks: '457' }, 'host'), /start time/u);
  assert.equal(runtimeCandidateMatchesHostAgent({ exe: '/opt/codex' }, 'host-codex', 'node'), true);
  assert.equal(runtimeCandidateMatchesHostAgent({ evidence: ['runtime_signature:commExact=kimi'] }, 'host-kimi', 'node'), true);
  assert.equal(runtimeCandidateMatchesHostAgent({ exe: '/usr/bin/node', evidence: [] }, 'host-codex', 'node'), false);
  const heartbeatBase = {
    lastHeartbeatAt: '2026-01-01 00:00:00',
    eventCount: 10,
    filterMetrics: {
      observed: 4,
      forwarded: 3,
      runtimeLeaseEpoch: 1,
      runtimeSnapshotPosts: 2,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:00.000Z',
    },
  };
  assert.equal(heartbeatAdvanced(heartbeatBase, structuredClone(heartbeatBase)), false);
  assert.equal(heartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:01',
    eventCount: 11,
  }), false, 'a raw heartbeat must not satisfy an enriched heartbeat barrier');
  assert.equal(heartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    filterMetrics: { ...heartbeatBase.filterMetrics, runtimeSnapshotPosts: 3 },
  }), true, 'same-second Forwarder metrics must advance the heartbeat barrier');
  assert.equal(heartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      e2eFilterReceipts: [{ markerSha256: 'a'.repeat(64), lineSha256: 'b'.repeat(64) }],
    },
  }), true, 'a same-second canary receipt must advance the heartbeat barrier');
  const receiptBarrier = {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      e2eFilterReceipts: [{ markerSha256: 'a'.repeat(64), lineSha256: 'b'.repeat(64) }],
    },
  };
  assert.equal(heartbeatAdvanced(receiptBarrier, {
    ...receiptBarrier,
    lastHeartbeatAt: '2026-01-01 00:00:01',
  }), false, 'a later raw heartbeat must not drain an enriched canary receipt');
  assert.equal(heartbeatAdvanced(receiptBarrier, {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:01',
    filterMetrics: { ...heartbeatBase.filterMetrics, runtimeSnapshotPosts: 3 },
  }), true, 'the next enriched heartbeat must drain the canary receipt');
  assert.equal(heartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    lastHeartbeatAt: '2025-12-31 23:59:59',
    filterMetrics: { ...heartbeatBase.filterMetrics, runtimeSnapshotPosts: 3 },
  }), false, 'an older health record must not advance the heartbeat barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:01',
    filterMetrics: { ...heartbeatBase.filterMetrics, runtimeSnapshotPosts: 3 },
  }), false, 'an ordinary periodic enriched heartbeat must not satisfy the shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:01',
    eventCount: 11,
  }), false, 'a newer raw heartbeat must not satisfy the shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), true, 'a same-second final heartbeat after a new snapshot must satisfy the shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeLeaseEpoch: 2,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), false, 'a replacement Forwarder lease must not satisfy the original shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      shutdownFinal: true,
    },
  }), false, 'a snapshot attempt without a newer success timestamp must not satisfy shutdown');
  assert.equal(finalShutdownHeartbeatAdvanced({
    ...heartbeatBase,
    filterMetrics: { ...heartbeatBase.filterMetrics, shutdownFinal: true },
  }, {
    ...heartbeatBase,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), false, 'a collector that was already final cannot reuse the shutdown barrier');
  const zeroWindowErrors = {
    windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
  };
  const shadow = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: { filterMode: 'shadow', observed: 1, forwarded: 1, wouldDiscoveryBudgetDrop: 1 },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: { filterMode: 'shadow', observed: 2, forwarded: 2, probableAgent: 1 },
    },
  ]);
  assertPhaseMetrics('shadow', shadow, 'self-test');
  assert.equal(shadow.totals.observed, 3);
  const preFinalSample = {
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
    ...zeroWindowErrors,
    filterMetrics: { filterMode: 'shadow', observed: 1, forwarded: 1, runtimeSnapshotPosts: 1 },
  };
  const explicitFinalSample = {
    lastHeartbeatAt: '2026-01-01T00:00:01.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
    ...zeroWindowErrors,
    filterMetrics: {
      filterMode: 'shadow', observed: 4, forwarded: 3, runtimeSnapshotPosts: 2, shutdownFinal: true,
    },
  };
  const finalInterval = aggregateHeartbeatSamples([preFinalSample], explicitFinalSample);
  assert.equal(finalInterval.count, 2, 'the explicit final heartbeat must be a sampled interval');
  assert.equal(finalInterval.totals.observed, 5, 'the final interval observed count must not be lost');
  assert.equal(finalInterval.totals.forwarded, 4, 'the final interval forwarded count must not be lost');
  const finalIntervalAlreadySampled = aggregateHeartbeatSamples(
    [preFinalSample, explicitFinalSample],
    explicitFinalSample,
  );
  assert.equal(finalIntervalAlreadySampled.count, 2, 'an already sampled final heartbeat must not be duplicated');
  assert.equal(finalIntervalAlreadySampled.totals.observed, 5);
  const maskedForwarderError = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 1, errorCount: 1,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 1, errorCount: 1 },
      filterMetrics: { filterMode: 'shadow', observed: 1, runtimeSnapshotPosts: 1 },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:01.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 1, errorCount: 1 },
      filterMetrics: { filterMode: 'shadow', observed: 0, runtimeSnapshotPosts: 2 },
    },
  ]);
  assert.equal(maskedForwarderError.errors.outputDropped, 1);
  assert.equal(maskedForwarderError.errors.errorCount, 1);
  assert.throws(
    () => assertPhaseMetrics('shadow', maskedForwarderError, 'self-test-masked-error'),
    /outputDropped|errorCount/u,
  );
  const missingWindowEvidence = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      filterMetrics: { filterMode: 'shadow', runtimeSnapshotPosts: 1 },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      filterMetrics: { filterMode: 'shadow', runtimeSnapshotPosts: 2 },
    },
  ]);
  assert.throws(
    () => assertPhaseMetrics('shadow', missingWindowEvidence, 'self-test-missing-window-evidence'),
    /window-stable drop\/error evidence/u,
  );
  assert.equal(redact('token=secret-value sk-123456789'), 'token=<redacted> sk-<redacted>');
  const boundedDiagnostic = boundedRedactedText('x'.repeat(512) + ' token=secret-value sk-123456789', 128);
  assert.equal(boundedDiagnostic.truncated, true);
  assert.ok(Buffer.byteLength(boundedDiagnostic.tail) <= 128);
  assert.doesNotMatch(boundedDiagnostic.tail, /secret-value|sk-123456789/u);
  assert.notEqual(boundedDiagnostic.sha256, hashText('x'.repeat(512) + ' token=secret-value sk-123456789'));
  const structuredDiagnostic = boundedRedactedText(JSON.stringify({
    authorization: ['Bearer opaque-authorization'],
    cookie: { session: 'opaque-cookie' },
    credentials: { value: 'opaque-credential' },
  }), 2_048);
  assert.doesNotMatch(
    structuredDiagnostic.tail,
    /opaque-authorization|opaque-cookie|opaque-credential/u,
  );
  const headerDiagnostic = boundedRedactedText(
    'Authorization: Bearer opaque-bearer\nCookie: session=opaque-session',
    2_048,
  );
  assert.doesNotMatch(headerDiagnostic.tail, /opaque-bearer|opaque-session/u);
  const unicodeDiagnostic = boundedRedactedText('汉'.repeat(128), 17);
  assert.ok(Buffer.byteLength(unicodeDiagnostic.tail) <= 17);
  assert.doesNotMatch(unicodeDiagnostic.tail, /�/u);
  const jsonDiagnostic = boundedCodexJsonLines(Array.from({ length: 40 }, (_, index) => JSON.stringify({
    type: 'event',
    index,
    token: 'secret-value',
    message: 'x'.repeat(2_000),
  })).join('\n'));
  assert.ok(jsonDiagnostic.returnedLines <= DIAGNOSTIC_JSON_MAX_LINES);
  assert.ok(jsonDiagnostic.lines.every((line) => Buffer.byteLength(line.json) <= DIAGNOSTIC_JSON_LINE_LIMIT));
  assert.ok(jsonDiagnostic.lines.reduce((sum, line) => sum + Buffer.byteLength(line.json), 0) <= DIAGNOSTIC_JSON_LIMIT);
  assert.doesNotMatch(JSON.stringify(jsonDiagnostic), /secret-value/u);
  const prompt = piPrompt();
  const piEnv = piEnvironment(options, 'docker', 'shadow');
  assert.doesNotMatch(prompt, /e2e-marker-001/u);
  assert.match(prompt, /\/opt\/agent-lab\/app\/pi-e2e-marker\.sh/u);
  assert.doesNotMatch(JSON.stringify(piEnv), /e2e-marker-001/u);
  assert.equal(piEnv.PI_E2E_MARKER_FILE, '/run/anysentry-e2e-marker/value');
  const hostAction = markerAction('e2e-marker-001');
  assert.match(hostAction, /exec \/usr\/bin\/true 'e2e-marker-001'/u);
  assert.match(hostAction, /tool-events\.log/u);
  const hostWorkspace = '/tmp/anysentry-host-codex-self-test';
  const workspaceArgs = hostCodexArgs(options, hostWorkspace, hostPrompt(hostWorkspace));
  assert.equal(workspaceArgs[workspaceArgs.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(workspaceArgs.includes('--ignore-user-config'));
  assert.ok(workspaceArgs.includes('--ignore-rules'));
  assert.ok(workspaceArgs.includes('--json'));
  assert.equal(workspaceArgs[workspaceArgs.indexOf('-C') + 1], hostWorkspace);
  assert.equal(workspaceArgs[workspaceArgs.indexOf('-o') + 1], path.join(hostWorkspace, 'final-output.txt'));
  assert.equal(assertHostCodexLaunchAuthorization(options, workspaceArgs), 'workspace-write');
  assert.equal(workspaceArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  const fullAccessOptions = parseOptions([
    '--agents', 'host-codex', '--allow-host-agents', '--allow-host-full-access',
  ]);
  const fullAccessArgs = hostCodexArgs(fullAccessOptions, hostWorkspace, hostPrompt(hostWorkspace));
  assert.equal(hostCodexSandboxMode(fullAccessOptions), 'danger-full-access');
  assert.equal(fullAccessArgs[fullAccessArgs.indexOf('--sandbox') + 1], 'danger-full-access');
  assert.ok(fullAccessArgs.includes('--ignore-user-config'));
  assert.ok(fullAccessArgs.includes('--ignore-rules'));
  assert.equal(assertHostCodexLaunchAuthorization(fullAccessOptions, fullAccessArgs), 'danger-full-access');
  assert.equal(fullAccessArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  assert.throws(
    () => assertHostCodexLaunchAuthorization(options, [
      ...workspaceArgs.slice(0, workspaceArgs.indexOf('--sandbox') + 1),
      'danger-full-access',
      ...workspaceArgs.slice(workspaceArgs.indexOf('--sandbox') + 2),
    ]),
    /does not match authorization/u,
  );
  assert.deepEqual(localToolProofIssues(
    { status: 'missing', text: '' },
    { status: 'ok', text: '' },
    'e2e-marker-001',
  ), ['tool-events.log:missing', 'model-result.txt:empty']);
  assert.deepEqual(localToolProofIssues(
    { status: 'ok', text: 'different-marker\n' },
    { status: 'ok', text: 'summary\n' },
    'e2e-marker-001',
  ), ['tool-events.log:marker_missing']);
  const witness = {
    schema: 'anysentry.e2e_raw_witness.v1',
    observedAt: '2026-01-01T00:00:00.000Z',
    eventKind: 'ToolExec',
    markerSha256: expectedMarkerHash('e2e-marker-001'),
    argvMarkerMatched: true,
    execConfirmed: true,
    lineSha256: 'b'.repeat(64),
    process: { pid: 42, cgroup: '/docker/' + 'c'.repeat(64) },
  };
  validateWitnessRecord(witness, 'e2e-marker-001', 'docker', 'c'.repeat(64));
  const receiptHeartbeat = {
    filterMetrics: {
      e2eFilterReceipts: [{
        schema: 'anysentry.e2e_filter_receipt.v1',
        eventKind: 'ToolExec',
        markerSha256: expectedMarkerHash('e2e-marker-001'),
        lineSha256: 'b'.repeat(64),
        physicalWorkloadId: 'docker:test:' + 'c'.repeat(64),
        classification: 'unknown',
        filterReason: 'unknown',
        filteredAt: '2026-01-01T00:00:00.001Z',
      }],
    },
  };
  assert.ok(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'docker', containerId: 'c'.repeat(64),
  }, witness));
  assert.equal(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'different-marker', environment: 'docker', containerId: 'c'.repeat(64),
  }, witness), undefined);
  assert.equal(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'docker', containerId: 'c'.repeat(64),
  }, { ...witness, lineSha256: 'd'.repeat(64) }), undefined);
  assert.equal(matchingFilterReceipt({
    filterMetrics: {
      e2eFilterReceipts: [{
        ...receiptHeartbeat.filterMetrics.e2eFilterReceipts[0],
        filteredAt: '2025-12-31T23:59:59.999Z',
      }],
    },
  }, {
    marker: 'e2e-marker-001', environment: 'docker', containerId: 'c'.repeat(64),
  }, witness), undefined);
  const exactEvent = {
    eventKind: 'ToolExec',
    attribution: { agentInstanceId: 'instance-a' },
    process: { exe: '/usr/bin/true' },
    attributes: {
      argv: '/usr/bin/true e2e-marker-001',
      exec_confirmed: true,
      argv_incomplete: false,
      argv_truncated: false,
      argv_source: 'kernel_fragments',
      observed_argc: 2,
    },
  };
  assert.equal(exactMarkerToolEvent(exactEvent, 'e2e-marker-001', 'instance-a'), true);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, process: { exe: '/usr/bin/pi' } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, attributes: { ...exactEvent.attributes, argv: 'grep e2e-marker-001' } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, attributes: { ...exactEvent.attributes, exec_confirmed: false } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, attributes: { ...exactEvent.attributes, argv_incomplete: true } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, attributes: { ...exactEvent.attributes, argv_truncated: true } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent({ ...exactEvent, attributes: { ...exactEvent.attributes, observed_argc: 3 } }, 'e2e-marker-001', 'instance-a'), false);
  assert.equal(exactMarkerToolEvent(exactEvent, 'e2e-marker-001', 'instance-b'), false);
  const boundedCanary = filterCanaryCommand();
  assert.match(boundedCanary, new RegExp('remaining=' + FILTER_CANARY_WAIT_SECONDS, 'u'));
  assert.match(boundedCanary, /\/bin\/sleep 1/u);
  assert.doesNotMatch(boundedCanary, /do\s+:;/u);
  assert.ok(FILTER_CANARY_MAX_RUNTIME_SECONDS > FILTER_CANARY_WAIT_SECONDS);
  assert.ok(AGENT_MAX_RUNTIME_SECONDS >= 10 * 60);
  assert.ok(COLLECTOR_MAX_RUNTIME_SECONDS > AGENT_MAX_RUNTIME_SECONDS);
  assert.ok(FORWARDER_SHUTDOWN_TIMEOUT_MS < SUPERVISOR_SHUTDOWN_TIMEOUT_MS);
  assert.ok(SUPERVISOR_SHUTDOWN_TIMEOUT_MS < COLLECTOR_OUTER_GRACE_SECONDS * 1_000);
  assert.ok(COLLECTOR_TIMEOUT_KILL_SECONDS * 1_000 < SUPERVISOR_COLLECTOR_TIMEOUT_MS);
  const supervisorEnvironment = collectorSupervisorEnvironment();
  assert.equal(supervisorEnvironment.OBSERVER_SUPERVISOR_COLLECTOR_COMMAND, '/usr/bin/timeout');
  assert.deepEqual(
    JSON.parse(supervisorEnvironment.OBSERVER_SUPERVISOR_COLLECTOR_ARGS_JSON),
    [
      '-s', 'TERM', '-k', String(COLLECTOR_TIMEOUT_KILL_SECONDS),
      String(COLLECTOR_MAX_RUNTIME_SECONDS), 'a3s-observer-collector',
    ],
  );
  assert.equal(supervisorEnvironment.OBSERVER_SUPERVISOR_FORWARDER_COMMAND, '/bin/sh');
  assert.deepEqual(
    JSON.parse(supervisorEnvironment.OBSERVER_SUPERVISOR_FORWARDER_ARGS_JSON),
    ['-c', '/usr/local/bin/node /opt/observer-e2e-witness.js | /usr/local/bin/node /opt/observer-forward.js'],
  );
  assert.equal(dockerInspectSaysMissing({ stderr: 'Error: No such object: old-id' }), true);
  assert.equal(k8sGetSaysMissing({ stderr: 'Error from server (NotFound): pods "old" not found' }), true);
  const pathIdentity = { dev: '1', ino: '2', mode: 0o100600, directory: false, file: true };
  assert.equal(sameLocalPathIdentity(pathIdentity, { ...pathIdentity }), true);
  assert.equal(sameLocalPathIdentity({ ...pathIdentity, ino: '3' }, pathIdentity), false);
  assert.ok(FORWARDER_MODULES.includes('observer-supervisor.js'));
  assert.ok(FORWARDER_MODULES.includes('observer-e2e-witness.js'));
  await selfTestSafetyIo();
  const hostSystemdLauncher = await selfTestHostSystemdLauncher(options);
  return {
    protocolReserved: true,
    dryRunDefault: true,
    cleanupOwnershipRequired: true,
    hostSystemdLauncher,
    safetyContracts: [
      'host full-access CLI and launch-point gate',
      'bounded credential-redacted diagnostics',
      'host process quiesced before failure evidence capture',
      'no-follow exclusive evidence writes with artifact directory identity pinning',
      'tracked transient sandbox-probe directory cleanup',
      'nonce and InvocationID fenced transient host service cleanup',
      'host runtime ProcessKey and cgroup correlation',
      'supervisor-owned collector shutdown with explicit final heartbeat evidence',
    ],
  };
}

function printPreflight(result) {
  const symbols = { pass: 'PASS', block: 'BLOCK', warn: 'WARN', skip: 'SKIP', pending: 'PENDING' };
  for (const item of result.checks) {
    console.log('[' + (symbols[item.status] || item.status.toUpperCase()) + '] ' + item.name + ': ' + item.detail);
  }
  console.log('preflight: blockers=' + result.blockers.length + '; warnings=' + result.warnings.length);
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (error) {
    console.error('[invalid arguments] ' + redact(error.message));
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.selfTest) {
    const result = await selfTest();
    console.log(JSON.stringify({ status: 'passed', selfTest: result }, null, 2));
    return;
  }
  ledger.runId = options.runId;
  const needsK8s = options.agents.includes('k8s-pi');
  const apiState = {};
  let successOutput;
  let primaryError;
  try {
    if (needsK8s && await commandAvailable('kubectl')) await startPortForward(options);
    const result = await preflight(options, apiState);
    printPreflight(result);
    if (!options.execute) {
      console.log(JSON.stringify(executionPlan(options), null, 2));
      console.log(result.blockers.length
        ? '[dry-run] plan generated; execute is blocked until preflight blockers are resolved.'
        : '[dry-run] plan generated; no run-scoped resources were created and transient preflight probes were removed. Re-run with --execute to start the real E2E.');
      return;
    }
    if (result.blockers.length) {
      throw new Error('execute refused because preflight has ' + result.blockers.length + ' blocker(s)');
    }
    const outcome = await executeE2e(options, result);
    successOutput = {
      status: 'passed',
      runId: options.runId,
      report: outcome.evidence.file,
      reportSha256: outcome.evidence.sha256,
      comparison: outcome.report.comparison,
    };
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    throw primaryError;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      const cleanupMessage = redact(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      );
      primaryError.message += '; global cleanup failed: ' + cleanupMessage;
      primaryError.globalCleanupError = diagnosticSanitized({
        name: cleanupError instanceof Error ? cleanupError.name : 'Error',
        message: cleanupMessage,
      });
    }
  }
  if (successOutput) console.log(JSON.stringify(successOutput, null, 2));
}

const internalMode = process.argv[2];
if (internalMode === HOST_AGENT_RUNNER_OPTION) {
  if (process.argv.length !== 3) {
    console.error('[host Agent runner failed] internal runner accepts input only on stdin');
    process.exitCode = 2;
  } else {
    void runHostAgentRunner().catch((error) => {
      console.error('[host Agent runner failed] ' + redact(error?.message || error));
      process.exitCode = 1;
    });
  }
} else if (internalMode === HOST_AGENT_CHILD_SELF_TEST_OPTION) {
  if (process.argv.length !== 4) {
    console.error('[host Agent child self-test failed] invalid arguments');
    process.exitCode = 2;
  } else {
    void runHostAgentChildSelfTest().catch((error) => {
      console.error('[host Agent child self-test failed] ' + redact(error?.message || error));
      process.exitCode = 1;
    });
  }
} else {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      ledger.aborting = true;
      process.exitCode = 130;
      void cleanup()
        .catch((error) => console.error('[cleanup failed after ' + signal + '] ' + redact(error?.message || error)))
        .finally(() => process.exit());
    });
  }

  void main().catch((error) => {
    console.error('[failed] ' + redact(error?.stack || error?.message || error));
    process.exitCode = 1;
  });
}
