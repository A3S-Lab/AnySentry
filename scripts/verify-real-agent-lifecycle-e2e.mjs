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
 * and an independently validated models.json through read-only mounts or a run-scoped Kubernetes
 * Secret. Host Kimi receives a run-owned 0600 config generated from the same validated model and
 * credential, outside the Agent workspace and with isolated state. The models file may reference
 * only $DEEPSEEK_API_KEY; it cannot contain a literal key. Reports contain only non-secret model
 * identifiers, hashes of non-secret files, boolean proof, and sanitized AnySentry records.
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, '..');
const require = createRequire(import.meta.url);
const {
  canonicalDocument: canonicalRuntimeSignatureDocument,
  defaultSignatureDocument,
  documentHash: runtimeSignatureDocumentHash,
  matcherHash: runtimeSignatureMatcherHash,
} = require('./observer-agent-runtime-signatures.js');
const DEFAULT_KEY_FILE = '/tmp/observer-study-deepseek-key';
const DEFAULT_DOCKER_API = 'http://127.0.0.1:29653/security-center';
const DEFAULT_HOST_API = 'http://127.0.0.1:29655/security-center';
const DEFAULT_K8S_PORT = 39653;
const DEFAULT_NAMESPACE = 'anysentry-agent-test';
const DEFAULT_OBSERVER_IMAGE = '127.0.0.1:5000/anysentry-observer:agent-runtime-lab';
const DEFAULT_K8S_OBSERVER_IMAGE = 'localhost:5000/anysentry-observer:local';
const DEFAULT_AGENT_IMAGE = '127.0.0.1:5000/anysentry-agent-runtime-lab:0.1.0';
const DEFAULT_PI_PROVIDER = 'deepseek';
const DEFAULT_PI_MODEL = 'deepseek-v4-flash';
const ALLOWED_PHASES = new Set(['shadow', 'enforce']);
const ALLOWED_AGENTS = new Set(['host-codex', 'host-kimi', 'docker-pi', 'k8s-pi']);
const E2E_EVENT_QUERY_LIMIT = 200;
const E2E_EVENT_QUERY_FUTURE_SKEW_MS = 2 * 60_000;
const E2E_EVENT_QUERY_START_SKEW_MS = 2 * 60_000;
const E2E_DURABLE_QUERY_WAIT_MS = 45_000;
const API_BOOT_EPOCH_TOLERANCE_MS = 5_000;
const MEMORY_API_MIN_BASELINE_UPTIME_SECONDS =
  Math.ceil((2 * API_BOOT_EPOCH_TOLERANCE_MS) / 1_000) + 1;
const CAPTURE_LIMIT = 2 * 1024 * 1024;
const DIAGNOSTIC_TEXT_LIMIT = 16 * 1024;
const DIAGNOSTIC_JSON_LIMIT = 32 * 1024;
const DIAGNOSTIC_JSON_LINE_LIMIT = 4 * 1024;
const DIAGNOSTIC_JSON_MAX_LINES = 24;
const DIAGNOSTIC_FILE_HASH_LIMIT = 256 * 1024;
const LOCAL_PROOF_FILE_LIMIT = 1024 * 1024;
const PI_MODELS_FILE_LIMIT = 64 * 1024;
const KIMI_CONFIG_PROVIDER_KEY = 'anysentry-e2e-openai';
const KIMI_CONFIG_MODEL_KEY = 'anysentry-e2e-model';
const MIN_KIMI_VERSION = [1, 49, 0];
const runtimeEvidenceRedactionLiterals = new Set();
const RUNTIME_SIGNATURE_MOUNT_DIRECTORY = '/run/anysentry-runtime-signatures';
const RUNTIME_SIGNATURE_FILE_NAME = 'runtime-signatures.json';
const HOST_AGENT_RUNNER_OPTION = '--internal-host-agent-runner';
const HOST_AGENT_CHILD_SELF_TEST_OPTION = '--internal-host-agent-child-self-test';
const HOST_AGENT_RUNNER_SCHEMA = 'anysentry.host_agent_runner.v1';
const HOST_AGENT_RUNNER_SELF_TEST_SCHEMA = 'anysentry.host_agent_runner.self_test.v1';
const HOST_FILTER_CANARY_RUNNER_SCHEMA = 'anysentry.host_filter_canary_runner.v1';
const HOST_AGENT_RUNNER_INPUT_LIMIT = 512 * 1024;
const HOST_AGENT_STOP_TIMEOUT_MS = 15_000;
const HOST_AGENT_START_TIMEOUT_MS = 15_000;
const HOST_AGENT_UNIT_SETTLE_MS = 1_000;
const POLL_MS = 500;
const FILTER_CANARY_WAIT_SECONDS = 120;
const FILTER_CANARY_MAX_RUNTIME_SECONDS = 180;
const FILTER_CANARY_COMPLETION_FILE = 'exit-code';
const PRE_RELEASE_MARKER_FUTURE_SKEW_MS = 2 * 60_000;
const PRE_RELEASE_DURABLE_WAIT_MS = 45_000;
const AGENT_MAX_RUNTIME_SECONDS = 20 * 60;
const PI_RUNTIME_EXIT_WAIT_MS = 120_000;
const PI_RETRY_SECONDS = 600;
const PI_MARKER_HELPER_SOURCE_FILE = path.join(
  repoRoot,
  'examples/agent-runtime-lab/app/pi-e2e-marker.sh',
);
const PI_MARKER_HELPER_CONTAINER_FILE = '/opt/agent-lab/app/pi-e2e-marker.sh';
const PI_MARKER_RELEASE_FILE = '/run/anysentry-e2e-release/go';
const PI_MARKER_HOLD_COMMAND = '/bin/sleep 3;:';
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
  'KIMI_SHARE_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]);
const FORWARDER_MODULES = [
  'observer-supervisor.js',
  'observer-forward.js',
  'observer-agent-attribution.js',
  'observer-launch-context.js',
  'observer-systemd-enrichment.js',
  'observer-attribution-repair.js',
  'observer-attribution-merge.js',
  'observer-agent-runtime-signatures.js',
  'observer-agent-templates.js',
  'observer-docker-discovery.js',
  'observer-behavior-discovery.js',
  'observer-priority-queue.js',
  'observer-event-dedup.js',
  'observer-workload-filter.js',
  'observer-infrastructure-roots.js',
  'observer-filter-rules.js',
  'observer-file-aggregation.js',
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
    '  --models-file PATH                Pi models.json; must reference $DEEPSEEK_API_KEY',
    '  --pi-provider ID                  Provider key from models.json (default: deepseek)',
    '  --pi-model ID                     Exact Pi model ID (default: deepseek-v4-flash)',
    '  --artifact-dir PATH               Evidence output directory',
    '  --phases shadow,enforce            Phases to run (default: shadow)',
    '  --allow-enforce                   Permit enforce only after this run passes shadow',
    '  --allow-host-agents               Explicitly opt in to local Codex/Kimi tool execution',
    '  --allow-host-full-access          Explicitly run host Codex with danger-full-access',
    '  --exercise-signature-reload       Hot-reload run-scoped builtin runtime signatures v1 -> v2',
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

function parseKimiVersion(value) {
  const match = String(value).match(/\b(\d+)\.(\d+)\.(\d+)\b/u);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function versionAtLeast(actual, minimum) {
  if (!Array.isArray(actual) || actual.length !== minimum.length) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
}

function parseOptions(argv) {
  const options = {
    execute: false,
    runId: generatedRunId(),
    keyFile: DEFAULT_KEY_FILE,
    modelsFile: undefined,
    piProvider: DEFAULT_PI_PROVIDER,
    piModel: DEFAULT_PI_MODEL,
    artifactDir: undefined,
    phases: ['shadow'],
    allowEnforce: false,
    allowHostAgents: false,
    allowHostFullAccess: false,
    exerciseSignatureReload: false,
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
    else if (arg === '--exercise-signature-reload') options.exerciseSignatureReload = true;
    else if (arg === '--require-host') options.requireHost = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--run-id') options.runId = valueAfter(argv, index++, arg);
    else if (arg === '--key-file') options.keyFile = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--models-file') options.modelsFile = path.resolve(valueAfter(argv, index++, arg));
    else if (arg === '--pi-provider') options.piProvider = valueAfter(argv, index++, arg);
    else if (arg === '--pi-model') options.piModel = valueAfter(argv, index++, arg);
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
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(options.piProvider)) {
    throw new Error('--pi-provider must be a lowercase provider identifier with at most 64 characters');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(options.piModel)) {
    throw new Error('--pi-model contains unsupported characters or exceeds 256 characters');
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
  let safe = String(value ?? '');
  for (const literal of runtimeEvidenceRedactionLiterals) {
    if (literal) safe = safe.replaceAll(literal, '<redacted-run-config>');
  }
  return safe
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<redacted-private-key>')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/g, '<redacted-jwt>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-<redacted>')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1<redacted>')
    .replace(/((?:set-)?cookie\s*:\s*)[^\r\n]+/gi, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|credentials?)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/("(?:api[_-]?key|token|secret|password|credentials?|authorization|proxy-authorization|cookie|set-cookie)"\s*:\s*")[^"]*(")/gi, '$1<redacted>$2');
}

function registerRuntimeEvidenceRedactionLiteral(value) {
  if (typeof value === 'string' && value.length >= 4) runtimeEvidenceRedactionLiterals.add(value);
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
  } else if (value.schema === HOST_FILTER_CANARY_RUNNER_SCHEMA) {
    const validFilterCanary = value.agent === 'filter-canary' &&
      value.command === '/usr/bin/true' &&
      value.args.length === 1 &&
      /^[a-f0-9]{64}$/u.test(value.args[0]) &&
      /^filter-canary-host-(?:shadow|enforce)$/u.test(path.basename(value.cwd)) &&
      Object.keys(value.env).length === 0;
    if (!validFilterCanary) throw new Error('host filter canary runner contract is invalid');
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

async function waitForHostFilterCanaryMarker(payload) {
  const triggerFile = path.join(payload.cwd, 'go');
  const valueFile = path.join(payload.cwd, 'value');
  const deadline = Date.now() + FILTER_CANARY_WAIT_SECONDS * 1_000;
  let triggered = false;
  while (Date.now() < deadline) {
    try {
      const trigger = await fs.lstat(triggerFile);
      if (!trigger.isFile() || trigger.isSymbolicLink()) {
        throw new Error('host filter canary trigger is not a regular file');
      }
      triggered = true;
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  if (!triggered) throw new Error('host filter canary trigger timed out');

  let handle;
  let encoded;
  try {
    handle = await fs.open(valueFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 161) {
      throw new Error('host filter canary marker file is invalid');
    }
    encoded = await handle.readFile();
    const matched = encoded.toString('utf8').match(/^([a-z0-9-]{1,160})\n$/u);
    if (!matched || expectedMarkerHash(matched[1]) !== payload.args[0]) {
      throw new Error('host filter canary marker differs from the launch contract');
    }
    return matched[1];
  } finally {
    if (encoded) encoded.fill(0);
    await handle?.close();
  }
}

async function runHostAgentRunner() {
  const payload = await readHostAgentRunnerPayload();
  const childArgs = payload.schema === HOST_FILTER_CANARY_RUNNER_SCHEMA
    ? [await waitForHostFilterCanaryMarker(payload)]
    : payload.args;
  const child = spawn(payload.command, childArgs, {
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

function parseStorageCapability(health, observedAtMs) {
  const storage = health?.storage;
  const uptimeSeconds = Number(health?.uptimeSeconds);
  const hotRingSize = Number(storage?.hotRingSize);
  const hotRingCapacity = Number(storage?.hotRingCapacity);
  if (
    !storage ||
    !['clickhouse', 'memory'].includes(storage.mode) ||
    typeof storage.clickhouseConfigured !== 'boolean' ||
    typeof storage.clickhouseReady !== 'boolean' ||
    !Number.isFinite(uptimeSeconds) || uptimeSeconds < 0 ||
    !Number.isSafeInteger(hotRingSize) || hotRingSize < 0 ||
    !Number.isSafeInteger(hotRingCapacity) || hotRingCapacity <= 0 ||
    hotRingSize > hotRingCapacity ||
    !Number.isFinite(observedAtMs)
  ) {
    return undefined;
  }
  return {
    mode: storage.mode,
    clickhouseConfigured: storage.clickhouseConfigured,
    clickhouseReady: storage.clickhouseReady,
    hotRingSize,
    hotRingCapacity,
    uptimeSeconds,
    observedAtMs,
    bootEpochEstimateMs: observedAtMs - uptimeSeconds * 1_000,
  };
}

async function readApiStorageCapability(baseUrl) {
  const startedAtMs = Date.now();
  const health = await requestJson(baseUrl, 'healthz', undefined, { timeoutMs: 5_000 });
  const observedAtMs = Math.round((startedAtMs + Date.now()) / 2);
  const storage = parseStorageCapability(health, observedAtMs);
  if (!storage) throw new Error('healthz returned no usable storage capability');
  return storage;
}

async function apiCapability(baseUrl, queryShape = false) {
  const result = {
    baseUrl,
    health: false,
    storage: undefined,
    runtime: false,
    lease: false,
    identity: undefined,
    errors: [],
  };
  try {
    result.storage = await readApiStorageCapability(baseUrl);
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
      } catch (error) {
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

function eventStorageContract(storage, planeName = undefined) {
  if (
    storage?.mode === 'clickhouse' &&
    storage.clickhouseConfigured === true &&
    storage.clickhouseReady === true
  ) {
    return 'clickhouse-durable';
  }
  if (
    planeName === 'host' &&
    storage?.mode === 'memory' &&
    storage.clickhouseConfigured === false &&
    storage.clickhouseReady === false
  ) {
    return 'authoritative-hot-ring';
  }
  return undefined;
}

function hotRingTrimBatch(capacity) {
  return Math.min(1_000, Math.max(100, Math.floor(capacity / 10)));
}

function memoryNoTrimThreshold(capacity) {
  return capacity - hotRingTrimBatch(capacity);
}

function memoryStorageHasNoTrimEvidence(storage) {
  return eventStorageContract(storage, 'host') === 'authoritative-hot-ring' &&
    storage.hotRingSize <= memoryNoTrimThreshold(storage.hotRingCapacity);
}

function memoryStorageIsAuditableBaseline(storage) {
  return memoryStorageHasNoTrimEvidence(storage) &&
    Number.isFinite(storage.uptimeSeconds) &&
    storage.uptimeSeconds >= MEMORY_API_MIN_BASELINE_UPTIME_SECONDS &&
    Number.isFinite(storage.bootEpochEstimateMs);
}

function storageCapabilitySummary(storage, planeName = undefined) {
  return storage ? {
    mode: storage.mode,
    clickhouseConfigured: storage.clickhouseConfigured,
    clickhouseReady: storage.clickhouseReady,
    hotRingSize: storage.hotRingSize,
    hotRingCapacity: storage.hotRingCapacity,
    uptimeSeconds: storage.uptimeSeconds,
    eventEvidenceContract: eventStorageContract(storage, planeName),
    memoryNoTrimProved: planeName === 'host' && storage.mode === 'memory'
      ? memoryStorageHasNoTrimEvidence(storage)
      : undefined,
    memoryBootBaselineProved: planeName === 'host' && storage.mode === 'memory'
      ? memoryStorageIsAuditableBaseline(storage)
      : undefined,
  } : undefined;
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
    stat.uid === expected.uid && stat.mode === expected.mode && stat.size === expected.size &&
    (!Object.hasOwn(expected, 'mtimeMs') || stat.mtimeMs === expected.mtimeMs) &&
    (!Object.hasOwn(expected, 'ctimeMs') || stat.ctimeMs === expected.ctimeMs);
}

function rejectEmbeddedPiCredential(value, location = '$', allowedApiKeyLocation = '') {
  if (typeof value === 'string') {
    if (/\bsk-[A-Za-z0-9_-]{8,}\b/u.test(value)) {
      throw new Error('Pi models file contains a literal credential at ' + location);
    }
    if (location !== allowedApiKeyLocation && (value.includes('$') || value.startsWith('!'))) {
      throw new Error('Pi models file may not use environment or command interpolation at ' + location);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((nested, index) => rejectEmbeddedPiCredential(
      nested,
      location + '[' + index + ']',
      allowedApiKeyLocation,
    ));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedLocation = location + '.' + key;
    if (/^(?:authorization|proxy-authorization|cookie|tokens?|secrets?|passwords?|credentials?)$/iu.test(key)) {
      throw new Error('Pi models file may not embed credential-bearing field ' + nestedLocation);
    }
    if (/api[_-]?key/iu.test(key)) {
      if (nestedLocation !== allowedApiKeyLocation || nested !== '$DEEPSEEK_API_KEY') {
        throw new Error('Pi models file apiKey must be the exact $DEEPSEEK_API_KEY reference');
      }
    }
    rejectEmbeddedPiCredential(nested, nestedLocation, allowedApiKeyLocation);
  }
}

function rejectUnknownFields(value, allowed, label) {
  if (!plainObject(value)) throw new Error(label + ' must be an object');
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) throw new Error(label + ' has unsupported fields: ' + unknown.join(', '));
}

function validatePiModelsDocument(document, providerId, modelId) {
  if (!plainObject(document) || !plainObject(document.providers)) {
    throw new Error('Pi models file must contain a providers object');
  }
  rejectUnknownFields(document, new Set(['providers']), 'Pi models document');
  if (Object.keys(document.providers).length !== 1 || !Object.hasOwn(document.providers, providerId)) {
    throw new Error('Pi models file must contain exactly the selected provider');
  }
  const provider = document.providers[providerId];
  if (!plainObject(provider)) throw new Error('Pi models file does not define provider ' + providerId);
  rejectUnknownFields(
    provider,
    new Set(['baseUrl', 'api', 'apiKey', 'models']),
    'Pi provider ' + providerId,
  );
  if (provider.api !== 'openai-completions') {
    throw new Error('Pi provider must use api=openai-completions');
  }
  if (provider.apiKey !== '$DEEPSEEK_API_KEY') {
    throw new Error('Pi provider apiKey must be the exact $DEEPSEEK_API_KEY reference');
  }
  let baseUrl;
  try {
    baseUrl = new URL(provider.baseUrl);
  } catch {
    throw new Error('Pi provider baseUrl is not a valid URL');
  }
  if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password ||
      baseUrl.search || baseUrl.hash) {
    throw new Error('Pi provider baseUrl must be credential-free http(s) without query or fragment');
  }
  if (!baseUrl.pathname || !baseUrl.pathname.replace(/\/+$/u, '').endsWith('/v1')) {
    throw new Error('Pi provider baseUrl must end with /v1');
  }
  if (!Array.isArray(provider.models)) throw new Error('Pi provider models must be an array');
  if (provider.models.length !== 1) throw new Error('Pi provider must contain exactly one model');
  const matches = provider.models.filter((model) => plainObject(model) && model.id === modelId);
  if (matches.length !== 1) {
    throw new Error('Pi models file must define the selected model exactly once: ' + modelId);
  }
  const model = matches[0];
  rejectUnknownFields(
    model,
    new Set([
      'id', 'name', 'reasoning', 'input', 'contextWindow', 'maxTokens',
      'thinkingLevelMap', 'compat',
    ]),
    'selected Pi model',
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u.test(model.id)) {
    throw new Error('selected Pi model ID contains unsupported characters');
  }
  if (typeof model.name !== 'string' || model.name.length < 1 || model.name.length > 160 ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(model.name)) {
    throw new Error('selected Pi model name must be a printable string of at most 160 characters');
  }
  if (typeof model.reasoning !== 'boolean') {
    throw new Error('selected Pi model reasoning must be boolean');
  }
  if (!Array.isArray(model.input) || model.input.length !== 1 || model.input[0] !== 'text') {
    throw new Error('selected Pi model input must be exactly ["text"]');
  }
  if (!Number.isInteger(model.contextWindow) || model.contextWindow < 1_024 ||
      model.contextWindow > 10_000_000) {
    throw new Error('selected Pi model contextWindow must be an integer from 1024 through 10000000');
  }
  if (!Number.isInteger(model.maxTokens) || model.maxTokens < 1 ||
      model.maxTokens > Math.min(model.contextWindow, 1_000_000)) {
    throw new Error('selected Pi model maxTokens must be a positive integer within contextWindow');
  }
  if (model.thinkingLevelMap !== undefined) {
    rejectUnknownFields(
      model.thinkingLevelMap,
      new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
      'selected Pi model thinkingLevelMap',
    );
    if (Object.values(model.thinkingLevelMap).some((value) =>
      value !== null && (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/u.test(value)))) {
      throw new Error('selected Pi model thinkingLevelMap values must be null or safe identifiers');
    }
  }
  if (model.compat !== undefined) {
    const booleanCompat = new Set([
      'supportsStore', 'supportsDeveloperRole', 'supportsReasoningEffort',
      'supportsUsageInStreaming', 'supportsStrictMode',
      'requiresReasoningContentOnAssistantMessages',
    ]);
    rejectUnknownFields(
      model.compat,
      new Set([...booleanCompat, 'maxTokensField', 'thinkingFormat']),
      'selected Pi model compat',
    );
    for (const field of booleanCompat) {
      if (Object.hasOwn(model.compat, field) && typeof model.compat[field] !== 'boolean') {
        throw new Error('selected Pi model compat.' + field + ' must be boolean');
      }
    }
    if (Object.hasOwn(model.compat, 'maxTokensField') &&
        !['max_tokens', 'max_completion_tokens'].includes(model.compat.maxTokensField)) {
      throw new Error('selected Pi model compat.maxTokensField is unsupported');
    }
    if (Object.hasOwn(model.compat, 'thinkingFormat') &&
        !['openai', 'openrouter', 'deepseek', 'together', 'zai', 'qwen'].includes(model.compat.thinkingFormat)) {
      throw new Error('selected Pi model compat.thinkingFormat is unsupported');
    }
  }
  rejectEmbeddedPiCredential(
    document,
    '$',
    '$.providers.' + providerId + '.apiKey',
  );
  return {
    providerId,
    modelId,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    api: provider.api,
    baseUrl: baseUrl.toString().replace(/\/$/u, ''),
    transportSecurity: baseUrl.protocol === 'https:' ? 'tls' : 'plaintext-http',
  };
}

async function readStablePiModelsFile(file, expected) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > PI_MODELS_FILE_LIMIT) {
    throw new Error('Pi models file must be a regular nonsymlink file of 2-' + PI_MODELS_FILE_LIMIT + ' bytes');
  }
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size ||
        (expected && !matchesFileFingerprint(before, expected))) {
      throw new Error('Pi models file identity changed');
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        content.length !== before.size) {
      throw new Error('Pi models file changed while it was being read');
    }
    return { stat: before, content };
  } finally {
    await handle.close();
  }
}

async function inspectPiModelsFile(options) {
  const { stat, content } = await readStablePiModelsFile(options.modelsFile);
  let document;
  try {
    document = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Pi models file is not valid JSON');
  }
  const model = validatePiModelsDocument(document, options.piProvider, options.piModel);
  return {
    fingerprint: {
      dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid,
      mode: stat.mode, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs,
    },
    model,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function stagePiModelsFile(options, expected) {
  const { content } = await readStablePiModelsFile(options.modelsFile, expected.fingerprint);
  let document;
  try {
    document = JSON.parse(content.toString('utf8'));
  } catch {
    throw new Error('Pi models file became invalid JSON after preflight');
  }
  const model = validatePiModelsDocument(document, options.piProvider, options.piModel);
  if (JSON.stringify(model) !== JSON.stringify(expected.model) ||
      createHash('sha256').update(content).digest('hex') !== expected.sha256) {
    throw new Error('Pi models file semantics or content changed after preflight');
  }
  const destination = path.join(ledger.tempRoot, 'pi-models.json');
  await fs.writeFile(destination, content, { mode: 0o600, flag: 'wx' });
  await verifyRunOwnedFile(destination, content.length, expected.sha256, 'staged Pi models file');
  return destination;
}

async function readNoFollow(file) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifyRunOwnedFile(file, expectedSize, expectedSha256, label) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content;
  try {
    const before = await handle.stat();
    const ownedByCaller = typeof process.getuid !== 'function' || before.uid === process.getuid();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || !ownedByCaller ||
        before.size !== expectedSize) {
      throw new Error(label + ' has an unsafe identity, mode, owner, or size');
    }
    content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        content.length !== expectedSize ||
        createHash('sha256').update(content).digest('hex') !== expectedSha256) {
      throw new Error(label + ' changed or does not match its staged content');
    }
    return localPathIdentity(after);
  } finally {
    content?.fill(0);
    await handle.close();
  }
}

async function atomicallyPublishRunOwnedFile(directory, directoryIdentity, name, content, label) {
  assert.equal(path.basename(name), name, label + ' name must be a basename');
  const beforeDirectory = await localPathState(directory);
  if (!beforeDirectory.exists || !beforeDirectory.identity.directory ||
      !sameLocalPathIdentity(beforeDirectory.identity, directoryIdentity)) {
    throw new Error(label + ' directory identity changed before publication');
  }
  const target = path.join(directory, name);
  if ((await localPathState(target)).exists) {
    throw new Error(label + ' target already exists');
  }
  const temporary = path.join(directory, '.' + name + '.' + ownershipNonce() + '.tmp');
  const expectedSha256 = createHash('sha256').update(content).digest('hex');
  let handle;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const temporaryIdentity = await verifyRunOwnedFile(
      temporary,
      content.length,
      expectedSha256,
      label + ' temporary file',
    );
    const readyDirectory = await localPathState(directory);
    if (!readyDirectory.exists || !sameLocalPathIdentity(readyDirectory.identity, directoryIdentity) ||
        (await localPathState(target)).exists) {
      throw new Error(label + ' publication target or directory changed');
    }
    await fs.rename(temporary, target);
    const targetIdentity = await verifyRunOwnedFile(
      target,
      content.length,
      expectedSha256,
      label,
    );
    if (!sameLocalPathIdentity(targetIdentity, temporaryIdentity)) {
      throw new Error(label + ' identity changed during atomic rename');
    }
    const afterDirectory = await localPathState(directory);
    if (!afterDirectory.exists || !sameLocalPathIdentity(afterDirectory.identity, directoryIdentity)) {
      throw new Error(label + ' directory identity changed after publication');
    }
    return { file: target, identity: targetIdentity, sha256: expectedSha256 };
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function assertModelsExcludeCredential(modelsFile, credentialFile) {
  const [models, credential] = await Promise.all([
    readNoFollow(modelsFile),
    readNoFollow(credentialFile),
  ]);
  try {
    let start = 0;
    let end = credential.length;
    while (start < end && (credential[start] === 0x0a || credential[start] === 0x0d)) start += 1;
    while (end > start && (credential[end - 1] === 0x0a || credential[end - 1] === 0x0d)) end -= 1;
    const value = credential.subarray(start, end);
    if (!value.length) throw new Error('staged DeepSeek credential is empty');
    if (models.indexOf(value) !== -1) {
      throw new Error('Pi models file contains the exact staged credential value');
    }
  } finally {
    models.fill(0);
    credential.fill(0);
  }
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
    if (!matchesFileFingerprint(after, expected) || credential.length !== expected.size ||
        createHash('sha256').update(credential).digest('hex') !== expected.sha256) {
      throw new Error('DeepSeek key file changed while creating the run-owned copy');
    }
  } finally {
    await handle.close();
  }
  const destination = path.join(ledger.tempRoot, 'deepseek-api-key');
  let stagedIdentity;
  try {
    let start = 0;
    let end = credential.length;
    while (start < end && (credential[start] === 0x0a || credential[start] === 0x0d)) start += 1;
    while (end > start && (credential[end - 1] === 0x0a || credential[end - 1] === 0x0d)) end -= 1;
    const value = credential.subarray(start, end);
    const credentialText = value.toString('utf8');
    if (!value.length || !Buffer.from(credentialText, 'utf8').equals(value) ||
        /[\u0000\r\n]/u.test(credentialText)) {
      throw new Error('DeepSeek key file must contain one nonempty UTF-8 credential value');
    }
    registerRuntimeEvidenceRedactionLiteral(credentialText);
    await fs.writeFile(destination, credential, { mode: 0o600, flag: 'wx' });
    stagedIdentity = await verifyRunOwnedFile(
      destination,
      credential.length,
      expected.sha256,
      'staged DeepSeek key file',
    );
  } finally {
    credential?.fill(0);
  }
  ledger.tempCredential = {
    path: destination,
    identity: stagedIdentity,
    size: expected.size,
    sha256: expected.sha256,
  };
  return destination;
}

async function readVerifiedRunOwnedFile(file, expectedSize, expectedSha256, expectedIdentity, label) {
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content;
  try {
    const before = await handle.stat();
    const ownedByCaller = typeof process.getuid !== 'function' || before.uid === process.getuid();
    if (!before.isFile() || (before.mode & 0o777) !== 0o600 || !ownedByCaller ||
        before.size !== expectedSize ||
        (expectedIdentity && !sameLocalPathIdentity(localPathIdentity(before), expectedIdentity))) {
      throw new Error(label + ' has an unsafe or changed identity, mode, owner, or size');
    }
    content = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        content.length !== expectedSize ||
        createHash('sha256').update(content).digest('hex') !== expectedSha256) {
      throw new Error(label + ' changed or does not match its staged content');
    }
    return { content, identity: localPathIdentity(after) };
  } catch (error) {
    content?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

function kimiConfigDocument(model, credential) {
  assert.equal(model.api, 'openai-completions', 'Host Kimi requires an OpenAI-compatible model');
  assert.match(model.providerId, /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u);
  assert.match(model.modelId, /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/u);
  assert.ok(Number.isInteger(model.contextWindow) && model.contextWindow >= 1_024);
  assert.ok(Number.isInteger(model.maxTokens) && model.maxTokens >= 1);
  assert.ok(typeof credential === 'string' && credential.length > 0 && !/[\u0000\r\n]/u.test(credential));
  return {
    default_model: KIMI_CONFIG_MODEL_KEY,
    default_thinking: false,
    default_yolo: false,
    show_thinking_stream: false,
    telemetry: false,
    merge_all_available_skills: false,
    loop_control: {
      max_steps_per_turn: 8,
      max_retries_per_step: 3,
      reserved_context_size: Math.max(
        1_000,
        Math.min(model.maxTokens, model.contextWindow - 1, 50_000),
      ),
    },
    providers: {
      [KIMI_CONFIG_PROVIDER_KEY]: {
        type: 'openai_legacy',
        base_url: model.baseUrl,
        api_key: credential,
        reasoning_key: 'reasoning_content',
      },
    },
    models: {
      [KIMI_CONFIG_MODEL_KEY]: {
        provider: KIMI_CONFIG_PROVIDER_KEY,
        model: model.modelId,
        max_context_size: model.contextWindow,
        capabilities: [],
      },
    },
  };
}

async function stageKimiConfigFile(model, credentialFile, credentialIntegrity) {
  const { content: credential } = await readVerifiedRunOwnedFile(
    credentialFile,
    credentialIntegrity.size,
    credentialIntegrity.sha256,
    ledger.tempCredential?.identity,
    'staged DeepSeek key file for Host Kimi',
  );
  let credentialText = '';
  let configBuffer;
  try {
    let start = 0;
    let end = credential.length;
    while (start < end && (credential[start] === 0x0a || credential[start] === 0x0d)) start += 1;
    while (end > start && (credential[end - 1] === 0x0a || credential[end - 1] === 0x0d)) end -= 1;
    const value = credential.subarray(start, end);
    credentialText = value.toString('utf8');
    if (!value.length || !Buffer.from(credentialText, 'utf8').equals(value) ||
        /[\u0000\r\n]/u.test(credentialText)) {
      throw new Error('staged DeepSeek credential is not a single nonempty UTF-8 value');
    }
    registerRuntimeEvidenceRedactionLiteral(credentialText);
    configBuffer = Buffer.from(JSON.stringify(kimiConfigDocument(model, credentialText), null, 2) + '\n');
    const destination = path.join(ledger.tempRoot, 'kimi-config.json');
    const sha256 = createHash('sha256').update(configBuffer).digest('hex');
    await fs.writeFile(destination, configBuffer, { mode: 0o600, flag: 'wx' });
    const identity = await verifyRunOwnedFile(
      destination,
      configBuffer.length,
      sha256,
      'run-owned Host Kimi config',
    );
    return {
      path: destination,
      identity,
      bytes: configBuffer.length,
      sha256,
      providerKey: KIMI_CONFIG_PROVIDER_KEY,
      modelKey: KIMI_CONFIG_MODEL_KEY,
    };
  } finally {
    credential.fill(0);
    configBuffer?.fill(0);
    credentialText = '';
  }
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

function hostFilterCanaryUnitName(options, phase) {
  return k8sName(options, 'filter-canary', 'host', phase) + '.service';
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

async function systemdControlGroupIdentity(controlGroup) {
  const normalized = normalizeSystemdControlGroup(controlGroup);
  const stat = await fs.lstat(path.join('/sys/fs/cgroup', normalized));
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      !Number.isSafeInteger(stat.ino) || stat.ino <= 0) {
    throw new Error('systemd control group is not a real cgroup directory');
  }
  return localPathIdentity(stat);
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
    execMainStartTimeTicks: service[0]?.startTime,
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
      if (options.exerciseSignatureReload) {
        resources.push({
          kind: 'secret',
          name: k8sName(options, 'runtime-signatures', 'k8s', phase),
        });
      }
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
    const names = [
      hostFilterCanaryUnitName(options, phase),
      ...options.agents
        .filter((name) => name.startsWith('host-'))
        .map((agent) => hostAgentUnitName(options, phase, agent)),
    ];
    for (const name of names) {
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

async function collectorHistoryAbsenceChecks(options, checks, apiState) {
  const planes = [
    ...(options.agents.some((agent) => agent.startsWith('host-'))
      ? [{ environment: 'host', baseUrl: options.hostApiBase, available: Boolean(apiState.host?.health) }]
      : []),
    ...(options.agents.includes('docker-pi')
      ? [{ environment: 'docker', baseUrl: options.dockerApiBase, available: Boolean(apiState.docker?.health) }]
      : []),
    ...(options.agents.includes('k8s-pi')
      ? [{ environment: 'k8s', baseUrl: options.k8sApiBase, available: Boolean(apiState.k8s?.health) }]
      : []),
  ];
  for (const plane of planes) {
    if (!plane.available) continue;
    for (const phase of options.phases) {
      const id = collectorId(options, plane.environment, phase);
      try {
        const existing = await queryHeartbeat(plane.baseUrl, id);
        check(
          checks,
          'collector history absent: ' + id,
          existing ? 'block' : 'pass',
          existing
            ? 'the exact collector ID already has API heartbeat history; use a new run ID'
            : 'no prior heartbeat exists for this run-scoped collector ID',
        );
      } catch (error) {
        check(
          checks,
          'collector history absent: ' + id,
          'block',
          'could not verify API heartbeat history: ' +
            redact(error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}

async function preflight(options, apiState = {}) {
  const checks = [];
  const needsK8s = options.agents.includes('k8s-pi');
  const needsPiCredential = options.agents.includes('docker-pi') || options.agents.includes('k8s-pi');
  const needsAuthorizedLlmCredential = needsPiCredential || options.agents.includes('host-kimi');
  const hostSelected = options.agents.some((agent) => agent.startsWith('host-'));
  // Probe every independently-addressed online plane so later negative isolation assertions are
  // not limited to the selected plane. Dry-run uses GET/OPTIONS only; execute additionally checks
  // the runtime response shape (whose list operation may prune expired in-memory records).
  if (!apiState.host) apiState.host = await apiCapability(options.hostApiBase, options.execute);
  if (!apiState.docker) apiState.docker = await apiCapability(options.dockerApiBase, options.execute);
  if (needsK8s && !apiState.k8s) apiState.k8s = await apiCapability(options.k8sApiBase, options.execute);
  const hostApiReady = Boolean(
    apiState.host?.health && apiState.host?.runtime && apiState.host?.lease && apiState.host?.snapshot &&
    eventStorageContract(apiState.host?.storage, 'host') &&
    (apiState.host?.storage?.mode !== 'memory' || memoryStorageIsAuditableBaseline(apiState.host.storage)),
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
    if (executable) {
      const filteredEnvironment = hostAgentEnvironment();
      const versionResult = await run(executable.path, ['--version'], {
        allowFailure: true,
        timeoutMs: 15_000,
        env: filteredEnvironment,
        inheritEnv: false,
      });
      const version = parseKimiVersion(versionResult.stdout + versionResult.stderr);
      const supportedVersion = versionResult.code === 0 && versionAtLeast(version, MIN_KIMI_VERSION);
      if (version) apiState.hostKimiVersion = version.join('.');
      check(
        checks,
        'Kimi CLI version',
        supportedVersion ? 'pass' : 'block',
        version
          ? version.join('.') + ' (requires >= ' + MIN_KIMI_VERSION.join('.') + ')'
          : 'could not determine installed Kimi CLI version',
      );
      const help = await run(executable.path, ['--help'], {
        allowFailure: true,
        timeoutMs: 15_000,
        env: filteredEnvironment,
        inheritEnv: false,
      });
      const requiredFlags = ['--config-file', '--model', '--print', '--mcp-config', '--skills-dir'];
      const missingFlags = requiredFlags.filter((flag) => !(help.stdout + help.stderr).includes(flag));
      check(
        checks,
        'Kimi run-owned configuration support',
        help.code === 0 && missingFlags.length === 0 ? 'pass' : 'block',
        missingFlags.length
          ? 'installed Kimi CLI lacks required flags: ' + missingFlags.join(', ')
          : 'global Kimi configuration is ignored; a private config and state directory will be generated',
      );
    }
  }

  if (needsAuthorizedLlmCredential) {
    try {
      const stat = await fs.lstat(options.keyFile);
      const handle = await fs.open(options.keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const safeMode = (stat.mode & 0o777) === 0o600;
      const safeSize = stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512;
      const ownedByCaller = typeof process.getuid !== 'function' || stat.uid === process.getuid();
      let credential;
      let opened;
      let after;
      let credentialSha256;
      try {
        opened = await handle.stat();
        if (safeMode && safeSize && ownedByCaller &&
            stat.dev === opened.dev && stat.ino === opened.ino && stat.size === opened.size) {
          credential = await handle.readFile();
          after = await handle.stat();
          if (after.dev === opened.dev && after.ino === opened.ino && after.size === opened.size &&
              after.mtimeMs === opened.mtimeMs && after.ctimeMs === opened.ctimeMs &&
              credential.length === opened.size) {
            credentialSha256 = createHash('sha256').update(credential).digest('hex');
          }
        }
      } finally {
        credential?.fill(0);
        await handle.close();
      }
      const stableOpen = Boolean(credentialSha256);
      apiState.keyFile = {
        dev: String(stat.dev), ino: String(stat.ino), uid: stat.uid,
        mode: stat.mode, size: stat.size,
        mtimeMs: opened?.mtimeMs, ctimeMs: opened?.ctimeMs,
        sha256: credentialSha256,
      };
      check(
        checks,
        'DeepSeek key file',
        safeMode && safeSize && ownedByCaller && stableOpen ? 'pass' : 'block',
        'exists; bytes=' + stat.size + '; mode=' + (stat.mode & 0o777).toString(8) +
          '; regular_nonsymlink=' + safeSize + '; stable_open=' + stableOpen +
          '; owned_by_caller=' + ownedByCaller +
          '; value was read only for a non-reportable integrity digest',
      );
    } catch {
      check(checks, 'DeepSeek key file', 'block', 'missing or unreadable: ' + options.keyFile);
    }
    if (options.modelsFile) {
      try {
        const inspected = await inspectPiModelsFile(options);
        const safeMode = (inspected.fingerprint.mode & 0o777) === 0o600;
        const ownedByCaller = typeof process.getuid !== 'function' ||
          inspected.fingerprint.uid === process.getuid();
        apiState.piModelsFile = inspected;
        check(
          checks,
          'Pi models file',
          safeMode && ownedByCaller ? 'pass' : 'block',
          'provider=' + inspected.model.providerId + '; model=' + inspected.model.modelId +
            '; bytes=' + inspected.fingerprint.size +
            '; mode=' + (inspected.fingerprint.mode & 0o777).toString(8) +
            '; owned_by_caller=' + ownedByCaller + '; sha256=' + inspected.sha256,
        );
        if (inspected.model.transportSecurity === 'plaintext-http') {
          check(
            checks,
            'Pi LLM transport security',
            'warn',
            'the authorized endpoint uses plaintext HTTP; Bearer credentials require a trusted network or later rotation',
          );
        } else {
          check(checks, 'Pi LLM transport security', 'pass', 'the configured endpoint uses TLS');
        }
      } catch (error) {
        check(
          checks,
          'Pi models file',
          'block',
          redact(error instanceof Error ? error.message : String(error)),
        );
      }
    } else {
      check(
        checks,
        'Pi models file',
        options.agents.includes('host-kimi') ? 'block' : 'warn',
        options.agents.includes('host-kimi')
          ? 'host-kimi requires --models-file so its run-owned gateway config can be generated safely'
          : 'not supplied; Pi will use its built-in provider catalog for ' + options.piProvider + '/' + options.piModel,
      );
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
      ...(options.exerciseSignatureReload ? [['patch', 'secrets']] : []),
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
    check(
      checks,
      'Docker API durable event evidence',
      eventStorageContract(dockerApi.storage, 'docker') === 'clickhouse-durable' ? 'pass' : 'block',
      eventStorageContract(dockerApi.storage, 'docker') === 'clickhouse-durable'
        ? 'ClickHouse is configured and ready for collector-scoped durable evidence queries'
        : 'ClickHouse-backed durable event evidence is unavailable',
    );
  }

  if (needsK8s) {
    const k8sApi = apiState.k8s;
    apiState.k8s = k8sApi;
    check(checks, 'Kubernetes API health via dedicated port-forward', k8sApi.health ? 'pass' : 'block', k8sApi.health ? 'online' : k8sApi.errors.join('; '));
    check(checks, 'Kubernetes API lifecycle endpoints', k8sApi.runtime && k8sApi.snapshot ? 'pass' : 'block', k8sApi.runtime && k8sApi.snapshot ? 'available' : k8sApi.errors.join('; '));
    check(checks, 'Kubernetes API runtime lease', k8sApi.lease ? 'pass' : 'block', k8sApi.lease ? 'available' : k8sApi.errors.join('; '));
    check(
      checks,
      'Kubernetes API durable event evidence',
      eventStorageContract(k8sApi.storage, 'k8s') === 'clickhouse-durable' ? 'pass' : 'block',
      eventStorageContract(k8sApi.storage, 'k8s') === 'clickhouse-durable'
        ? 'ClickHouse is configured and ready for collector-scoped durable evidence queries'
        : 'ClickHouse-backed durable event evidence is unavailable',
    );
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
    const hostStorage = eventStorageContract(hostApi.storage, 'host');
    const hostMemorySafe = hostApi.storage?.mode !== 'memory' || memoryStorageIsAuditableBaseline(hostApi.storage);
    if (hostApi.health && hostApi.runtime && hostApi.lease && hostApi.snapshot && hostStorage && hostMemorySafe) {
      check(
        checks,
        'Host debug API',
        'pass',
        'online with lifecycle, lease, and ' + hostStorage +
          (hostStorage === 'authoritative-hot-ring' ? ' event evidence without prior ring trim' : ' event evidence'),
      );
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
  await collectorHistoryAbsenceChecks(options, checks, apiState);
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
      resources.push({ plane: 'host', kind: 'systemd user service', name: hostFilterCanaryUnitName(options, phase) });
      for (const agent of options.agents.filter((name) => name.startsWith('host-'))) {
        resources.push({ plane: 'host', kind: 'systemd user service', name: hostAgentUnitName(options, phase, agent) });
      }
      if (options.exerciseSignatureReload) {
        resources.push({
          plane: 'host',
          kind: 'run-workspace signature directory',
          name: k8sName(options, 'runtime-signatures', 'host', phase),
        });
      }
    }
    if (options.agents.includes('docker-pi')) {
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'collector', 'docker', phase) });
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'workload', 'docker', phase) });
      resources.push({ plane: 'docker', kind: 'Docker container', name: k8sName(options, 'filter-canary', 'docker', phase) });
      if (options.exerciseSignatureReload) {
        resources.push({
          plane: 'docker',
          kind: 'run-workspace signature directory',
          name: k8sName(options, 'runtime-signatures', 'docker', phase),
        });
      }
    }
    if (options.agents.includes('k8s-pi')) {
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'collector', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'workload', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Pod', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'filter-canary', 'k8s', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Secret', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'filter-canary', 'value', phase) });
      resources.push({ plane: 'kubernetes', kind: 'Secret', namespace: options.k8sWorkloadNamespace, name: k8sName(options, 'pi-marker', phase) });
      if (options.exerciseSignatureReload) {
        resources.push({
          plane: 'kubernetes',
          kind: 'Secret',
          namespace: options.k8sWorkloadNamespace,
          name: k8sName(options, 'runtime-signatures', 'k8s', phase),
        });
      }
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
    runtimeSignatureReload: options.exerciseSignatureReload ? {
      enabled: true,
      scope: 'run-scoped',
      transition: 'complete builtin document v1 -> v2',
      runtimeIdsScopesAndMatchPredicatesChanged: false,
      displayNamesChanged: true,
      completedBeforeAgentStart: true,
    } : { enabled: false },
    eventIngestScope: {
      mode: 'collector-phase-tool-exec-marker-prefix',
      prefixDimensions: ['runId', 'environment', 'phase'],
      prefixSha256ReportedPerPhase: true,
      collectorHeartbeatsBypassScope: true,
      attributionAndRuntimeDiscoveryRunBeforeScope: true,
      testOnly: true,
      productionDefault: 'disabled-when-env-absent',
      markerPrefixReported: false,
    },
    eventEvidenceQueries: {
      timeWindow: 'fixed-phase-start-to-query-end-with-bounded-clock-skew',
      clickhousePlanes: 'collector-scoped-durable-plus-hot-ring-merge-without-fallback',
      hostMemoryPlane: 'explicit-hot-ring-fallback-with-boot-continuity-and-no-trim-proof',
      markerFiltering: 'client-side-exact-argv-token',
      serverTextSearchUsed: false,
      completeGlobalApiInventoryClaimed: false,
      completeFreshCollectorPageRequired: true,
    },
    pi: options.agents.some((agent) => agent.endsWith('-pi')) ? {
      provider: options.piProvider,
      model: options.piModel,
      modelsFile: options.modelsFile ? 'caller-owned validated file' : 'built-in provider catalog',
      lifecycleProof: 'fresh-workload-round-1-runtime-visible-then-release-held-tool-result-and-successful-exit',
      retrySeconds: PI_RETRY_SECONDS,
      successfulExitWaitSeconds: PI_RUNTIME_EXIT_WAIT_MS / 1_000,
      markerHelperSourceSha256: options.piMarkerHelperSha256,
      markerHelperVerifiedBeforeAgentProcess: true,
      markerHelperRuntimeVerifiedPerScenario: true,
      markerHelperPathReported: false,
    } : undefined,
    hostKimi: options.agents.includes('host-kimi') ? {
      provider: options.piProvider,
      model: options.piModel,
      configuration: 'generated run-owned 0600 file',
      state: 'isolated run-owned 0700 directory',
    } : undefined,
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
      credentialInput: 'caller-owned key file only; validated models file may reference only $DEEPSEEK_API_KEY',
      hostCodexFullAccessRequiresExplicitFlag: true,
      preExistingResourcesAdopted: false,
      cleanupOwnershipLabelRequired: true,
      deploymentManifestsOrExistingResourcesModified: false,
      runtimeSignatureReloadTouchesOnlyRunOwnedResources: true,
      e2eMarkerScopeTouchesOnlyRunOwnedCollectors: true,
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
      'Pi marker helper image bytes are verified before the Agent process can start',
      'the verified helper remains gated with no tool proof before release, the durable merged API view is negative, and the kernel event does not predate release',
      'marker event is attributed to the expected Agent instance',
      'run-owned collectors admit only this run marker ToolExec events while still processing all runtime attribution',
      'a real Host non-Agent is policy-discarded while container unknown work reaches L1 only in shadow',
      'shadow and enforce counters obey their mode invariants',
      'collector ID and marker never appear in another API plane',
      ...(options.exerciseSignatureReload ? [
        'run-scoped builtin runtime signature v1 -> v2 display-name reload and reconciliation succeed before Agent start',
      ] : []),
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
  for (const literal of runtimeEvidenceRedactionLiterals) {
    assert.equal(content.includes(literal), false, 'evidence contains a run configuration literal');
  }
  if (ledger.tempCredential) {
    const { content: credential } = await readVerifiedRunOwnedFile(
      ledger.tempCredential.path,
      ledger.tempCredential.size,
      ledger.tempCredential.sha256,
      ledger.tempCredential.identity,
      'staged DeepSeek key file before evidence write',
    );
    try {
      let start = 0;
      let end = credential.length;
      while (start < end && (credential[start] === 0x0a || credential[start] === 0x0d)) start += 1;
      while (end > start && (credential[end - 1] === 0x0a || credential[end - 1] === 0x0d)) end -= 1;
      const serialized = Buffer.from(content);
      try {
        assert.equal(
          end > start && serialized.indexOf(credential.subarray(start, end)) === -1,
          true,
          'evidence contains the exact run credential',
        );
      } finally {
        serialized.fill(0);
      }
    } finally {
      credential.fill(0);
    }
  }
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

function assertCompleteRuntimeInventory(runtime, label) {
  assert.equal(
    Number.isSafeInteger(runtime?.total) && runtime.total >= 0,
    true,
    label + ' runtime inventory has no valid total',
  );
  assert.equal(
    runtime.items.length,
    runtime.total,
    label + ' runtime inventory is truncated; refusing to classify a partial root set',
  );
  return runtime;
}

function e2eEventQueryWindow(startTime, clockMs = Date.now()) {
  const startMs = Date.parse(String(startTime || ''));
  assert.equal(Number.isFinite(startMs), true, 'E2E event query has no fixed phase start');
  assert.equal(Number.isFinite(clockMs), true, 'E2E event query clock is invalid');
  return {
    timeType: 'custom',
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(clockMs + E2E_EVENT_QUERY_FUTURE_SKEW_MS).toISOString(),
  };
}

async function requestEventList(baseUrl, collector, extra = {}) {
  const result = await requestJson(baseUrl, 'events/list', {
    ...extra,
    collectorId: collector,
    includeUnknown: true,
    noise: 'include',
    scope: 'raw',
    limit: E2E_EVENT_QUERY_LIMIT,
  });
  assert.ok(Array.isArray(result?.items), 'events/list returned an unexpected shape');
  return result;
}

function validateCompleteE2eEventResult(result, collector, storageContract, startMs, endMs, label) {
  assert.equal(Array.isArray(result?.items), true, label + ' returned no event items array');
  assert.equal(
    Number.isSafeInteger(result?.total) && result.total >= 0,
    true,
    label + ' returned no valid total',
  );
  assert.equal(
    result.items.length,
    result.total,
    label + ' returned a truncated collector inventory',
  );
  assert.ok(
    result.total < E2E_EVENT_QUERY_LIMIT,
    label + ' reached the collector page boundary',
  );
  for (const item of result.items) {
    assert.equal(
      item?.collectorId,
      collector,
      label + ' returned an event from another collector',
    );
    const eventAtMs = apiEventAtMs(item?.at);
    assert.ok(
      eventAtMs >= startMs && eventAtMs <= endMs,
      label + ' returned an event outside its fixed phase window',
    );
  }
  if (storageContract === 'clickhouse-durable') {
    assert.equal(result.storageFallback, undefined, label + ' used a durable storage fallback');
  } else {
    assert.equal(storageContract, 'authoritative-hot-ring', label + ' has no supported storage contract');
    assert.equal(
      result.storageFallback,
      'hot_ring',
      label + ' did not prove the expected memory-only authoritative store',
    );
  }
  return result;
}

async function proveAuthoritativeMemoryContinuity(
  plane,
  label,
  readStorage = readApiStorageCapability,
) {
  const baseline = plane.storage;
  assert.equal(memoryStorageIsAuditableBaseline(baseline), true,
    label + ' baseline memory API cannot prove stable boot and untrimmed ring state');
  const current = await readStorage(plane.baseUrl);
  assert.equal(eventStorageContract(current, plane.name), 'authoritative-hot-ring',
    label + ' memory storage mode changed');
  assert.equal(current.hotRingCapacity, baseline.hotRingCapacity,
    label + ' memory ring capacity changed');
  assert.equal(memoryStorageHasNoTrimEvidence(current), true,
    label + ' memory ring entered the post-trim ambiguity region');
  assert.ok(current.uptimeSeconds >= baseline.uptimeSeconds,
    label + ' API uptime regressed during the evidence run');
  assert.ok(
    Math.abs(current.bootEpochEstimateMs - baseline.bootEpochEstimateMs) <= API_BOOT_EPOCH_TOLERANCE_MS,
    label + ' API process changed during the evidence run',
  );
  return {
    bootContinuityProved: true,
    noRingTrimProved: true,
    baselineUptimeSeconds: baseline.uptimeSeconds,
    observedUptimeSeconds: current.uptimeSeconds,
    hotRingSize: current.hotRingSize,
    hotRingCapacity: current.hotRingCapacity,
    trimSafetyThreshold: memoryNoTrimThreshold(current.hotRingCapacity),
  };
}

async function queryEvents(
  plane,
  collector,
  extra = {},
  label = 'E2E event evidence',
  dependencies = {},
) {
  assert.equal(typeof plane?.baseUrl, 'string', label + ' has no API base');
  const storageContract = eventStorageContract(plane.storage, plane.name);
  assert.ok(storageContract, label + ' has no supported API storage contract');
  assert.equal(extra.q, undefined, label + ' must filter exact markers client-side');
  assert.equal(extra.timeType, 'custom', label + ' must use a fixed custom window');
  const startMs = Date.parse(String(extra.startTime || ''));
  const endMs = Date.parse(String(extra.endTime || ''));
  assert.equal(Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs, true,
    label + ' has an invalid custom window');

  let attempts = 0;
  const request = dependencies.requestEventList ?? requestEventList;
  const wait = dependencies.eventually ?? eventually;
  const read = async () => {
    attempts += 1;
    const result = await request(plane.baseUrl, collector, {
      ...extra,
      durable: true,
      includeUnknown: true,
      noise: 'include',
      scope: 'raw',
      limit: E2E_EVENT_QUERY_LIMIT,
    });
    if (storageContract === 'clickhouse-durable' && result.storageFallback !== undefined) {
      throw new Error(label + ' used a durable storage fallback: ' + result.storageFallback);
    }
    return result;
  };
  const result = storageContract === 'clickhouse-durable'
    ? await wait(label + ' durable read', read, E2E_DURABLE_QUERY_WAIT_MS, 1_000)
    : await read();
  validateCompleteE2eEventResult(result, collector, storageContract, startMs, endMs, label);
  const memoryContinuity = storageContract === 'authoritative-hot-ring'
    ? await proveAuthoritativeMemoryContinuity(
        plane,
        label,
        dependencies.readApiStorageCapability ?? readApiStorageCapability,
      )
    : undefined;
  return {
    ...result,
    e2eQueryProof: {
      storageContract,
      durableRequested: true,
      storageFallback: result.storageFallback,
      apiTotalApproximate: result.totalApproximate === true,
      collectorFilterPushedDown: storageContract === 'clickhouse-durable',
      exactMarkerFiltering: 'client-side',
      completeGlobalApiInventoryClaimed: false,
      completeFreshCollectorPageProved: true,
      pageBoundaryRejected: true,
      attempts,
      ...memoryContinuity,
      queryWindow: {
        timeType: 'custom',
        startTime: new Date(startMs).toISOString(),
        endTime: new Date(endMs).toISOString(),
      },
    },
  };
}

function apiPlaneForEnvironment(context, environment) {
  const plane = context.apiPlanes.find((candidate) => candidate.name === environment);
  assert.ok(plane?.available, environment + ' API plane is unavailable');
  assert.ok(
    eventStorageContract(plane.storage, plane.name),
    environment + ' API plane has no event evidence contract',
  );
  return plane;
}

function collectorEventQueryWindow(collector, clockMs = Date.now()) {
  return e2eEventQueryWindow(collector.eventQueryStartTime, clockMs);
}

async function queryCollectorEvents(context, collector, label, plane = undefined) {
  const selectedPlane = plane ?? apiPlaneForEnvironment(context, collector.environment);
  return await queryEvents(
    selectedPlane,
    collector.collectorId,
    collectorEventQueryWindow(collector),
    label,
  );
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

async function assertCollectorHistoryAbsentBeforeStart(baseUrl, collector, environment, phase) {
  const existing = await queryHeartbeat(baseUrl, collector);
  assert.equal(
    existing,
    undefined,
    environment + '/' + phase + ' collector ID acquired API history after preflight; use a new run ID',
  );
}

function numericMetric(metrics, name) {
  const value = metrics?.[name];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function optionalNumericMetric(metrics, name) {
  const raw = metrics?.[name];
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function nonNegativeSafeInteger(metrics, name) {
  const value = metrics?.[name];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function execEvidenceQuality(item) {
  const evidence = item?.execEvidence && typeof item.execEvidence === 'object'
    ? item.execEvidence
    : {};
  const latest = evidence.latest && typeof evidence.latest === 'object'
    ? evidence.latest
    : undefined;
  const rawWindow = evidence.window && typeof evidence.window === 'object'
    ? evidence.window
    : {};
  const metricFields = ['exec', 'execTruncated', 'execIncomplete', 'execReassemblyTimeout'];
  const latestFields = [...metricFields, 'intervalSecs'];
  const windowFields = [...metricFields, 'heartbeatCount', 'intervalSecs', 'shutdownFinalCount'];
  const validLatestContract = Boolean(latest) && latestFields.every((name) =>
    nonNegativeSafeInteger(latest, name) !== undefined,
  ) && typeof latest.shutdownFinal === 'boolean';
  const validWindowContract = windowFields.every((name) =>
    nonNegativeSafeInteger(rawWindow, name) !== undefined,
  );
  const window = {
    exec: nonNegativeSafeInteger(rawWindow, 'exec') ?? 0,
    execTruncated: nonNegativeSafeInteger(rawWindow, 'execTruncated') ?? 0,
    execIncomplete: nonNegativeSafeInteger(rawWindow, 'execIncomplete') ?? 0,
    execReassemblyTimeout: nonNegativeSafeInteger(rawWindow, 'execReassemblyTimeout') ?? 0,
    heartbeatCount: nonNegativeSafeInteger(rawWindow, 'heartbeatCount') ?? 0,
    intervalSecs: nonNegativeSafeInteger(rawWindow, 'intervalSecs') ?? 0,
    shutdownFinalCount: nonNegativeSafeInteger(rawWindow, 'shutdownFinalCount') ?? 0,
  };
  const normalizedLatest = validLatestContract ? {
    exec: nonNegativeSafeInteger(latest, 'exec'),
    execTruncated: nonNegativeSafeInteger(latest, 'execTruncated'),
    execIncomplete: nonNegativeSafeInteger(latest, 'execIncomplete'),
    execReassemblyTimeout: nonNegativeSafeInteger(latest, 'execReassemblyTimeout'),
    intervalSecs: nonNegativeSafeInteger(latest, 'intervalSecs'),
    shutdownFinal: latest.shutdownFinal,
  } : undefined;
  const lastReportedAt = typeof evidence.lastReportedAt === 'string' &&
    Number.isFinite(Date.parse(evidence.lastReportedAt))
    ? evidence.lastReportedAt
    : undefined;
  const countsFitExec = (metrics) => metrics &&
    ['execTruncated', 'execIncomplete', 'execReassemblyTimeout']
      .every((name) => metrics[name] <= metrics.exec);
  const internallyConsistent = countsFitExec(normalizedLatest) && countsFitExec(window) &&
    window.shutdownFinalCount <= window.heartbeatCount &&
    (!normalizedLatest?.shutdownFinal || window.shutdownFinalCount > 0);
  const ratio = (value) => window.exec > 0 ? value / window.exec : undefined;
  return {
    reported: evidence.reported === true && validLatestContract && validWindowContract &&
      Boolean(lastReportedAt) && window.heartbeatCount > 0 && internallyConsistent,
    lastReportedAt,
    latest: normalizedLatest,
    window,
    ratios: {
      truncated: ratio(window.execTruncated),
      incomplete: ratio(window.execIncomplete),
      reassemblyTimeout: ratio(window.execReassemblyTimeout),
    },
  };
}

function startHeartbeatSampler(baseUrl, collector) {
  let stopping = false;
  const samples = [];
  const seen = new Set();
  const done = (async () => {
    while (!stopping) {
      try {
        const item = await queryHeartbeat(baseUrl, collector);
        const fingerprint = item?.filterMetricsReported === true && item?.lastHeartbeatAt
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
    snapshot() {
      return [...samples];
    },
    async stop() {
      stopping = true;
      await done;
      return samples;
    },
  };
}

function aggregateHeartbeatSamples(samples, finalHeartbeat = samples.at(-1)) {
  // A raw-only Collector heartbeat is intentionally visible in health with decoupled fallback
  // metrics. It is not a Forwarder interval and must not be counted as zero-valued evidence.
  const aggregatedSamples = samples.filter((item) => item?.filterMetricsReported === true);
  if (finalHeartbeat?.filterMetricsReported === true) {
    const finalFingerprint = heartbeatCursor(finalHeartbeat).filterMetricsFingerprint;
    if (!aggregatedSamples.some((item) =>
      heartbeatCursor(item).filterMetricsFingerprint === finalFingerprint)) {
      aggregatedSamples.push(finalHeartbeat);
    }
  }
  const sumFields = [
    'observed', 'forwarded', 'confirmedAgent', 'probableAgent', 'unknown', 'nonAgent',
    'filteredNonAgent', 'wouldFilterNonAgent', 'filteredUnknown', 'wouldFilterUnknown',
    'filteredNoise', 'wouldFilterNoise',
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
  const operationalCounterFields = [
    'queueDropped', 'identityErrors', 'dockerErrors', 'runtimeSnapshotErrors',
    'runtimeSnapshotRejected', 'runtimeLeaseErrors',
  ];
  let operationalErrorEvidence = aggregatedSamples.length > 0;
  for (const item of aggregatedSamples) {
    const metrics = item.filterMetrics || {};
    operationalErrorEvidence &&= operationalCounterFields.every((name) =>
      nonNegativeSafeInteger(metrics, name) !== undefined,
    ) && typeof metrics.runtimeLeaseFenced === 'boolean';
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
  const evidenceQuality = execEvidenceQuality(finalHeartbeat ?? aggregatedSamples.at(-1));
  const diagnostics = {
    runtimeSnapshotRetries: numericMetric(finalMetrics, 'runtimeSnapshotRetries'),
    runtimeSnapshotRecovered: numericMetric(finalMetrics, 'runtimeSnapshotRecovered'),
    lastRuntimeSnapshotFailureAt: typeof finalMetrics.lastRuntimeSnapshotFailureAt === 'string'
      ? finalMetrics.lastRuntimeSnapshotFailureAt
      : undefined,
    lastRuntimeSnapshotFailure: typeof finalMetrics.lastRuntimeSnapshotFailure === 'string'
      ? finalMetrics.lastRuntimeSnapshotFailure
      : undefined,
    lastRuntimeSnapshotFailureVersion: optionalNumericMetric(finalMetrics, 'lastRuntimeSnapshotFailureVersion'),
    lastRuntimeSnapshotRetryAt: typeof finalMetrics.lastRuntimeSnapshotRetryAt === 'string'
      ? finalMetrics.lastRuntimeSnapshotRetryAt
      : undefined,
    lastRuntimeSnapshotRetryReason: typeof finalMetrics.lastRuntimeSnapshotRetryReason === 'string'
      ? finalMetrics.lastRuntimeSnapshotRetryReason
      : undefined,
  };
  return {
    count: aggregatedSamples.length,
    firstHeartbeatAt: aggregatedSamples[0]?.lastHeartbeatAt,
    lastHeartbeatAt: finalHeartbeat?.lastHeartbeatAt ?? aggregatedSamples.at(-1)?.lastHeartbeatAt,
    filterMode: finalMetrics.filterMode ?? aggregatedSamples.at(-1)?.filterMetrics?.filterMode,
    windowErrorEvidence,
    operationalErrorEvidence,
    last: finalMetrics,
    totals,
    errors,
    evidenceQuality,
    diagnostics,
  };
}

function assertPhaseMetrics(phase, metrics, environment) {
  assert.ok(metrics.count >= 2, environment + '/' + phase + ' captured fewer than two heartbeat intervals');
  assert.equal(
    metrics.windowErrorEvidence,
    true,
    environment + '/' + phase + ' did not receive final window-stable drop/error evidence',
  );
  assert.equal(
    metrics.operationalErrorEvidence,
    true,
    environment + '/' + phase + ' did not receive complete operational error counters',
  );
  assert.equal(
    metrics.evidenceQuality?.reported,
    true,
    environment + '/' + phase + ' has no complete raw Collector exec evidence',
  );
  assert.ok(
    metrics.evidenceQuality.window.exec > 0,
    environment + '/' + phase + ' raw Collector evidence contains no ToolExec events',
  );
  assert.equal(
    metrics.evidenceQuality.latest?.shutdownFinal,
    true,
    environment + '/' + phase + ' did not receive the final raw Collector heartbeat',
  );
  assert.ok(
    metrics.evidenceQuality.window.shutdownFinalCount > 0,
    environment + '/' + phase + ' raw Collector window has no shutdown-final evidence',
  );
  assert.equal(metrics.filterMode, phase, environment + ' collector reported the wrong filter mode');
  for (const [name, value] of Object.entries(metrics.errors)) {
    if (name === 'runtimeLeaseFenced') assert.equal(value, false, environment + ' forwarder was fenced');
    else assert.equal(value, 0, environment + ' reported non-zero ' + name);
  }
  if (phase === 'shadow') {
    assert.equal(metrics.totals.filteredNonAgent, 0, 'shadow mode performed non-Agent filtering');
    assert.equal(metrics.totals.filteredUnknown, 0, 'shadow mode performed broad Unknown filtering');
    assert.equal(metrics.totals.filteredNoise, 0, 'shadow mode performed noise filtering');
    assert.equal(metrics.totals.discoveryBudgetDropped, 0, 'shadow mode dropped unknown events');
  } else {
    assert.equal(metrics.totals.wouldFilterNonAgent, 0, 'enforce mode emitted shadow non-Agent counters');
    assert.equal(metrics.totals.wouldFilterUnknown, 0, 'enforce mode emitted shadow Unknown counters');
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
    at: item?.at ?? item?.eventTime,
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

function collectorEventTransportEnvironment() {
  return {
    // The ingest controller currently awaits per-event durable work in order. A host-wide E2E
    // collector can fill the normal adaptive 128-event batch quickly enough that the server
    // consumes every event but returns the acknowledgement after the default 10-second client
    // deadline. Keep the test batch bounded and give its acknowledgement a realistic deadline;
    // transport ambiguity is still terminal and is never blindly retried.
    FORWARD_BATCH_SIZE: '8',
    FORWARD_HTTP_TIMEOUT_MS: '60000',
  };
}

function collectorEventIngestScopeEnvironment(options, environment, phase) {
  assert.ok(['host', 'docker', 'k8s'].includes(environment), 'E2E ingest scope environment is invalid');
  assert.ok(ALLOWED_PHASES.has(phase), 'E2E ingest scope phase is invalid');
  const prefix = ['asel-marker', options.runId, environment, phase, ''].join('-');
  assert.match(
    prefix,
    /^asel-marker-[a-z0-9](?:[a-z0-9-]{0,26}[a-z0-9])?-(?:host|docker|k8s)-(?:shadow|enforce)-$/u,
    'collector-phase E2E ingest marker prefix is invalid',
  );
  return { ANYSENTRY_E2E_INGEST_MARKER_PREFIX: prefix };
}

function collectorEventIngestScopeProof(options, environment, phase) {
  const prefix = collectorEventIngestScopeEnvironment(options, environment, phase)
    .ANYSENTRY_E2E_INGEST_MARKER_PREFIX;
  return {
    mode: 'collector-phase-tool-exec-marker-prefix',
    environment,
    phase,
    prefixSha256: createHash('sha256').update(prefix).digest('hex'),
    collectorHeartbeatsBypassScope: true,
    attributionAndRuntimeDiscoveryRunBeforeScope: true,
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

function runtimeSignatureReloadDocuments() {
  const version1 = canonicalRuntimeSignatureDocument(defaultSignatureDocument());
  const version2 = canonicalRuntimeSignatureDocument({
    ...version1,
    version: 2,
    runtimes: version1.runtimes.map((runtime) => ({
      ...runtime,
      displayName: runtime.displayName + ' [AnySentry E2E v2]',
    })),
  });
  assert.equal(version1.version, 1, 'builtin runtime signature document must start at version 1');
  assert.equal(version2.version, 2, 'runtime signature reload target must be version 2');
  const matchingSemantics = (document) => document.runtimes.map((runtime) => ({
    id: runtime.id,
    agentScopeId: runtime.agentScopeId,
    enabled: runtime.enabled,
    variants: runtime.variants,
  }));
  assert.deepEqual(
    matchingSemantics(version2),
    matchingSemantics(version1),
    'runtime signature reload must preserve every builtin runtime ID, scope, and match predicate',
  );
  assert.equal(
    new Set(version2.runtimes.map((runtime) => runtime.displayName)).size,
    version2.runtimes.length,
    'runtime signature reload target display names must remain unique',
  );
  assert.ok(
    version2.runtimes.every((runtime, index) =>
      runtime.displayName !== version1.runtimes[index].displayName),
    'runtime signature reload target must make its v2 display names externally observable',
  );
  const describe = (document) => {
    const raw = JSON.stringify(document, null, 2) + '\n';
    return {
      document,
      version: document.version,
      runtimeCount: document.runtimes.filter((runtime) => runtime.enabled).length,
      raw,
      rawSha256: hashText(raw),
      documentSha256: runtimeSignatureDocumentHash(document),
      matcherSha256: runtimeSignatureMatcherHash(document),
      matchPredicatesSha256: hashText(JSON.stringify(matchingSemantics(document))),
    };
  };
  const result = { version1: describe(version1), version2: describe(version2) };
  assert.notEqual(
    result.version1.documentSha256,
    result.version2.documentSha256,
    'runtime signature version change must change the canonical document hash',
  );
  assert.notEqual(
    result.version1.matcherSha256,
    result.version2.matcherSha256,
    'observable display-name updates must change the registry matcher hash',
  );
  assert.equal(
    result.version1.matchPredicatesSha256,
    result.version2.matchPredicatesSha256,
    'runtime signature v1 -> v2 exercise must preserve IDs, scopes, and match predicates',
  );
  return result;
}

function assertTrackedTempRoot() {
  if (!ledger.tempRoot || !ledger.tempRootIdentity) {
    throw new Error('runtime signature files require a tracked run workspace');
  }
  return localPathState(ledger.tempRoot).then((state) => {
    if (!state.exists || !state.identity.directory ||
        !sameLocalPathIdentity(state.identity, ledger.tempRootIdentity)) {
      throw new Error('refused to use runtime signature files after run workspace identity changed');
    }
  });
}

async function prepareLocalRuntimeSignatureReload(options, environment, phase) {
  await assertTrackedTempRoot();
  const directory = path.join(
    ledger.tempRoot,
    k8sName(options, 'runtime-signatures', environment, phase),
  );
  const file = path.join(directory, RUNTIME_SIGNATURE_FILE_NAME);
  const documents = runtimeSignatureReloadDocuments();
  await fs.mkdir(directory, { mode: 0o700 });
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() ||
      (directoryStat.mode & 0o777) !== 0o700) {
    throw new Error('run-owned runtime signature path is not a private directory');
  }
  await fs.writeFile(file, documents.version1.raw, { flag: 'wx', mode: 0o600 });
  const fileStat = await fs.lstat(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || (fileStat.mode & 0o777) !== 0o600) {
    throw new Error('run-owned runtime signature document is not a private regular file');
  }
  return {
    kind: 'local-directory',
    directory,
    directoryIdentity: localPathIdentity(directoryStat),
    file,
    documents,
  };
}

async function atomicallyReplaceLocalRuntimeSignatures(config) {
  const directoryState = await localPathState(config.directory);
  if (!directoryState.exists || !directoryState.identity.directory ||
      !sameLocalPathIdentity(directoryState.identity, config.directoryIdentity)) {
    throw new Error('refused to update runtime signatures after run-owned directory identity changed');
  }
  const temporary = path.join(
    config.directory,
    '.' + RUNTIME_SIGNATURE_FILE_NAME + '.' + ownershipNonce(),
  );
  try {
    await fs.writeFile(temporary, config.documents.version2.raw, { flag: 'wx', mode: 0o600 });
    const temporaryStat = await fs.lstat(temporary);
    if (!temporaryStat.isFile() || temporaryStat.isSymbolicLink() ||
        (temporaryStat.mode & 0o777) !== 0o600) {
      throw new Error('runtime signature replacement is not a private regular file');
    }
    await fs.rename(temporary, config.file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  const [afterDirectory, afterFile, content] = await Promise.all([
    localPathState(config.directory),
    fs.lstat(config.file),
    fs.readFile(config.file),
  ]);
  if (!afterDirectory.exists ||
      !sameLocalPathIdentity(afterDirectory.identity, config.directoryIdentity) ||
      !afterFile.isFile() || afterFile.isSymbolicLink() || (afterFile.mode & 0o777) !== 0o600) {
    throw new Error('runtime signature atomic replacement changed a pinned local identity');
  }
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    config.documents.version2.rawSha256,
    'runtime signature atomic replacement content differs from v2',
  );
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

function markerHelperHashProof(output, expectedSha256, environment) {
  const match = String(output).trim().match(/^([a-f0-9]{64})\s+(.+)$/u);
  assert.ok(match, environment + ' Pi marker helper returned an invalid sha256sum record');
  assert.equal(
    match[2],
    PI_MARKER_HELPER_CONTAINER_FILE,
    environment + ' Pi marker helper path changed',
  );
  assert.equal(
    match[1],
    expectedSha256,
    environment + ' Pi marker helper differs from the current verified source',
  );
  return {
    sourceSha256: expectedSha256,
    runtimeSha256: match[1],
    pathReported: false,
  };
}

async function assertDockerPiMarkerHelper(name, expectedSha256) {
  assert.match(expectedSha256 || '', /^[a-f0-9]{64}$/u, 'Docker Pi marker helper source hash is unavailable');
  const result = await run('docker', [
    'exec', name, 'sha256sum', PI_MARKER_HELPER_CONTAINER_FILE,
  ], { timeoutMs: 15_000 });
  return markerHelperHashProof(result.stdout, expectedSha256, 'Docker');
}

function piMarkerHelperGateCommand(expectedSha256, continueToCommand) {
  assert.match(
    expectedSha256 || '',
    /^[a-f0-9]{64}$/u,
    'Pi marker helper gate requires a verified source hash',
  );
  const expectedRecord = expectedSha256 + '  ' + PI_MARKER_HELPER_CONTAINER_FILE;
  return [
    'set -eu',
    'actual="$(sha256sum ' + PI_MARKER_HELPER_CONTAINER_FILE + ')"',
    '[ "$actual" = "' + expectedRecord + '" ]',
    ...(continueToCommand ? ['exec "$@"'] : []),
  ].join('; ');
}

async function assertDockerPiImageAndMarkerHelper(
  name,
  configuredImage,
  runtimeImageId,
  expectedSha256,
  expectedCommand,
) {
  const inspected = await run('docker', [
    'inspect', '--format',
    '{{json .Config.Entrypoint}}\n{{json .Config.Cmd}}\n{{.Image}}',
    name,
  ], { timeoutMs: 15_000 });
  const [entrypointLine, commandLine, imageLine] = inspected.stdout.trim().split(/\r?\n/u);
  assert.deepEqual(JSON.parse(entrypointLine), ['/bin/sh'], 'Docker Pi pre-LLM gate entrypoint changed');
  assert.deepEqual(JSON.parse(commandLine), expectedCommand, 'Docker Pi pre-LLM gate command changed');
  assert.equal(imageLine, runtimeImageId, 'Docker Pi runtime image differs from its pinned image');
  const markerHelper = await assertDockerPiMarkerHelper(name, expectedSha256);
  return {
    configuredImage,
    runtimeImageId,
    preLlmGate: {
      method: 'container-entrypoint-sha256-before-agent-exec',
      completed: true,
      expectedSha256,
      pathReported: false,
    },
    markerHelper,
  };
}

async function assertK8sPiImageAndMarkerHelper(namespace, pod, configuredImage, expectedSha256) {
  assert.match(expectedSha256 || '', /^[a-f0-9]{64}$/u, 'Kubernetes Pi marker helper source hash is unavailable');
  return await eventually('Kubernetes Pi workload image and marker helper provenance', async () => {
    const podResult = await run('kubectl', [
      '-n', namespace, 'get', 'pod', pod, '-o', 'json',
    ], { allowFailure: true, timeoutMs: 10_000 });
    if (podResult.code !== 0) return undefined;
    let document;
    try { document = JSON.parse(podResult.stdout); } catch { return undefined; }
    const expectedContainers = ['workload', 'release-gate'];
    const specContainers = new Map((document?.spec?.containers || []).map((container) => [
      container.name,
      container.image,
    ]));
    const statusContainers = new Map((document?.status?.containerStatuses || []).map((status) => [
      status.name,
      status,
    ]));
    const gateSpec = (document?.spec?.initContainers || []).find((container) =>
      container.name === 'marker-helper-gate');
    const gateStatus = (document?.status?.initContainerStatuses || []).find((status) =>
      status.name === 'marker-helper-gate');
    const gateCommand = piMarkerHelperGateCommand(expectedSha256, false);
    if (gateSpec?.image !== configuredImage ||
        JSON.stringify(gateSpec?.command) !== JSON.stringify(['/bin/sh', '-c']) ||
        JSON.stringify(gateSpec?.args) !== JSON.stringify([gateCommand]) ||
        gateStatus?.state?.terminated?.exitCode !== 0 ||
        !gateStatus?.imageID) return undefined;
    const proof = [];
    for (const container of expectedContainers) {
      if (specContainers.get(container) !== configuredImage ||
          !statusContainers.get(container)?.state?.running ||
          !statusContainers.get(container)?.imageID) return undefined;
      const hash = await run('kubectl', [
        '-n', namespace, 'exec', pod, '-c', container, '--',
        'sha256sum', PI_MARKER_HELPER_CONTAINER_FILE,
      ], { allowFailure: true, timeoutMs: 10_000 });
      if (hash.code !== 0) return undefined;
      proof.push({
        container,
        configuredImage,
        runtimeImageId: statusContainers.get(container).imageID,
        markerHelper: markerHelperHashProof(hash.stdout, expectedSha256, 'Kubernetes/' + container),
      });
    }
    return {
      preLlmGate: {
        container: 'marker-helper-gate',
        configuredImage,
        runtimeImageId: gateStatus.imageID,
        method: 'successful-init-container-sha256-before-workload-start',
        completed: true,
        expectedSha256,
        pathReported: false,
      },
      containers: proof,
    };
  }, 120_000, 500);
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
  await assertCollectorHistoryAbsentBeforeStart(apiBase, id, environment, phase);
  const signatureReloadConfig = options.exerciseSignatureReload
    ? await prepareLocalRuntimeSignatureReload(options, environment, phase)
    : undefined;
  // The host collector shares the Linux host network so that a debug API published only on
  // 127.0.0.1 remains private. The Docker collector stays bridged and uses host-gateway.
  const target = environment === 'host' ? apiBase : containerApiBase(apiBase);
  const ownership = { nonce: ownershipNonce() };
  const env = {
    A3S_OBSERVER_JSON: '1',
    A3S_OBSERVER_COLLECTOR_ID: id,
    A3S_NODE_NAME: 'e2e-' + environment + '-' + options.runId,
    // This lifecycle gate proves kernel ToolExec capture and attribution. File probes are an
    // independent, opt-in high-volume signal and would make a zero-drop ToolExec gate depend on
    // unrelated filesystem traffic from the whole host.
    A3S_OBSERVER_FILES: '0',
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
    ...(signatureReloadConfig ? {
      ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE:
        path.posix.join(RUNTIME_SIGNATURE_MOUNT_DIRECTORY, RUNTIME_SIGNATURE_FILE_NAME),
    } : {}),
    ...collectorEventIngestScopeEnvironment(options, environment, phase),
    ...collectorEventTransportEnvironment(),
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
    ...(signatureReloadConfig
      ? ['-v', signatureReloadConfig.directory + ':' + RUNTIME_SIGNATURE_MOUNT_DIRECTORY + ':ro']
      : []),
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
  return {
    name,
    collectorId: id,
    environment,
    phase,
    apiBase,
    signatureReloadConfig,
    eventIngestScope: collectorEventIngestScopeProof(options, environment, phase),
  };
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

async function createK8sRuntimeSignatureSecret(options, phase) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'runtime-signatures', 'k8s', phase);
  const documents = runtimeSignatureReloadDocuments();
  const secret = {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name,
      namespace,
      labels: { 'anysentry.io/e2e-run-id': options.runId },
    },
    type: 'Opaque',
    data: {
      [RUNTIME_SIGNATURE_FILE_NAME]: Buffer.from(documents.version1.raw).toString('base64'),
    },
  };
  await createK8sObject(namespace, 'secret', name, secret, ledger.k8sSecrets);
  return { kind: 'k8s-secret', namespace, name, documents };
}

function parseOwnedRuntimeSignatureSecret(raw, config, ownership) {
  const secret = JSON.parse(raw);
  assert.equal(secret?.metadata?.uid, ownership.uid, 'runtime signature Secret UID changed');
  assert.equal(
    secret?.metadata?.labels?.['anysentry.io/e2e-run-id'],
    ledger.runId,
    'runtime signature Secret run ownership changed',
  );
  assert.equal(
    secret?.metadata?.labels?.['anysentry.io/e2e-ownership'],
    ownership.nonce,
    'runtime signature Secret nonce ownership changed',
  );
  assert.notEqual(secret?.immutable, true, 'runtime signature Secret unexpectedly became immutable');
  assert.ok(
    typeof secret?.metadata?.resourceVersion === 'string' &&
      secret.metadata.resourceVersion.length > 0 &&
      secret.metadata.resourceVersion.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(secret.metadata.resourceVersion),
    'runtime signature Secret has no safe resourceVersion',
  );
  const encoded = secret?.data?.[RUNTIME_SIGNATURE_FILE_NAME];
  assert.equal(typeof encoded, 'string', 'runtime signature Secret has no document');
  return {
    resourceVersion: secret.metadata.resourceVersion,
    rawSha256: createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex'),
  };
}

async function updateK8sRuntimeSignatureSecret(config) {
  const ownership = ledger.k8sSecrets.get(config.namespace)?.get(config.name);
  if (!ownership?.nonce || !ownership?.uid) {
    throw new Error('missing tracked runtime signature Secret ownership');
  }
  const beforeResult = await run('kubectl', [
    '-n', config.namespace, 'get', 'secret', config.name, '-o', 'json',
  ]);
  const before = parseOwnedRuntimeSignatureSecret(beforeResult.stdout, config, ownership);
  assert.equal(
    before.rawSha256,
    config.documents.version1.rawSha256,
    'runtime signature Secret changed before the v2 update',
  );
  const patch = [
    { op: 'test', path: '/metadata/uid', value: ownership.uid },
    { op: 'test', path: '/metadata/resourceVersion', value: before.resourceVersion },
    {
      op: 'test',
      path: '/metadata/labels/anysentry.io~1e2e-run-id',
      value: ledger.runId,
    },
    {
      op: 'test',
      path: '/metadata/labels/anysentry.io~1e2e-ownership',
      value: ownership.nonce,
    },
    {
      op: 'replace',
      path: '/data/' + RUNTIME_SIGNATURE_FILE_NAME.replace(/~/gu, '~0').replace(/\//gu, '~1'),
      value: Buffer.from(config.documents.version2.raw).toString('base64'),
    },
  ];
  const updated = await trackMutation(() => run('kubectl', [
    '-n', config.namespace, 'patch', 'secret', config.name,
    '--type=json', '-p', JSON.stringify(patch),
  ], { allowFailure: true, timeoutMs: 45_000 }));
  if (updated.code !== 0) {
    throw new Error('failed to update run-owned runtime signature Secret: ' + redact(updated.stderr));
  }
  const afterResult = await run('kubectl', [
    '-n', config.namespace, 'get', 'secret', config.name, '-o', 'json',
  ]);
  const after = parseOwnedRuntimeSignatureSecret(afterResult.stdout, config, ownership);
  assert.notEqual(after.resourceVersion, before.resourceVersion, 'runtime signature Secret resourceVersion did not advance');
  assert.equal(
    after.rawSha256,
    config.documents.version2.rawSha256,
    'runtime signature Secret did not retain the v2 document',
  );
}

async function createK8sCredentialSecret(options) {
  const namespace = options.k8sWorkloadNamespace;
  const name = k8sName(options, 'deepseek');
  const credential = await fs.readFile(options.keyFile);
  if (credential.length < 1 || credential.length > 512) throw new Error('DeepSeek key file size changed after preflight');
  const models = options.piModelsFile ? await fs.readFile(options.piModelsFile) : undefined;
  if (models && (models.length < 2 || models.length > PI_MODELS_FILE_LIMIT)) {
    throw new Error('Pi models file size changed after staging');
  }
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
    data: {
      deepseek_api_key: credential.toString('base64'),
      ...(models ? { 'models.json': models.toString('base64') } : {}),
    },
  };
  try {
    await createK8sObject(namespace, 'secret', name, secret, ledger.k8sSecrets);
  } finally {
    credential.fill(0);
    models?.fill(0);
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
  await assertCollectorHistoryAbsentBeforeStart(options.k8sApiBase, id, 'k8s', phase);
  const signatureReloadConfig = options.exerciseSignatureReload
    ? await createK8sRuntimeSignatureSecret(options, phase)
    : undefined;
  const serviceBase = k8sApiServiceBase(options);
  const envValues = {
    A3S_OBSERVER_JSON: '1',
    A3S_OBSERVER_COLLECTOR_ID: id,
    // Keep the run-scoped collector focused on the ToolExec signal under test. Production can
    // still enable the independent high-volume file probes in its own deployment configuration.
    A3S_OBSERVER_FILES: '0',
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
    ...(signatureReloadConfig ? {
      ANYSENTRY_AGENT_RUNTIME_SIGNATURES_FILE:
        path.posix.join(RUNTIME_SIGNATURE_MOUNT_DIRECTORY, RUNTIME_SIGNATURE_FILE_NAME),
    } : {}),
    ...collectorEventIngestScopeEnvironment(options, 'k8s', phase),
    ...collectorEventTransportEnvironment(),
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
          ...(signatureReloadConfig ? [{
            name: 'runtime-signatures',
            mountPath: RUNTIME_SIGNATURE_MOUNT_DIRECTORY,
            readOnly: true,
          }] : []),
        ],
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { memory: '1Gi' },
        },
      }],
      volumes: [
        { name: 'sys', hostPath: { path: '/sys', type: 'Directory' } },
        { name: 'witness', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
        ...(signatureReloadConfig ? [{
          name: 'runtime-signatures',
          secret: { secretName: signatureReloadConfig.name, defaultMode: 256 },
        }] : []),
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
  return {
    name,
    namespace,
    collectorId: id,
    environment: 'k8s',
    phase,
    apiBase: options.k8sApiBase,
    signatureReloadConfig,
    eventIngestScope: collectorEventIngestScopeProof(options, 'k8s', phase),
  };
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
    PI_PROVIDER: options.piProvider,
    PI_MODEL: options.piModel,
    PI_THINKING: 'off',
    PI_TURN_TIMEOUT_SECONDS: '90',
    // A real E2E proof is bound to the fresh workload's first Pi turn. Keep retries outside the
    // bounded proof window so a failed first turn cannot borrow a later turn's successful exit.
    PI_RETRY_SECONDS: String(PI_RETRY_SECONDS),
    DEEPSEEK_API_KEY_FILE: '/run/secrets/deepseek_api_key',
    PI_E2E_MARKER_FILE: '/run/anysentry-e2e-marker/value',
    PI_E2E_RELEASE_FILE: environment === 'docker'
      ? '/run/anysentry-e2e-marker/go'
      : PI_MARKER_RELEASE_FILE,
    PI_AGENT_PROMPT: piPrompt(),
  };
}

function parsePiRuntimeLogRecords(logText) {
  return String(logText).split(/\r?\n/u).flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return plainObject(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

function piRuntimeLogDiagnostic(logText, expectedAgentId) {
  const source = String(logText ?? '');
  const records = parsePiRuntimeLogRecords(source);
  const lifecycleEvents = new Set([
    'started',
    'pi_process_starting',
    'pi_process_timeout',
    'pi_process_error',
    'pi_process_exited',
    'pi_retry_scheduled',
    'next_agent_turn_scheduled',
    'shutdown_requested',
    'fatal',
  ]);
  const lifecycle = records.filter((record) =>
    record.runtime === 'pi' && lifecycleEvents.has(record.event));
  const matchingRoundOneStart = lifecycle.some((record) =>
    record.event === 'pi_process_starting' &&
    record.agentId === expectedAgentId &&
    record.round === 1);
  const matchingRoundOneFailure = lifecycle.some((record) =>
    record.agentId === expectedAgentId &&
    record.round === 1 &&
    (record.event === 'pi_process_timeout' ||
      record.event === 'pi_process_error' ||
      (record.event === 'pi_process_exited' && (record.code !== 0 || record.signal !== null))));
  const safeInteger = (value) => Number.isSafeInteger(value) ? value : undefined;
  const safeSignal = (value) => typeof value === 'string' && /^SIG[A-Z0-9]+$/u.test(value)
    ? value
    : value === null ? null : undefined;
  const lastLifecycleEvents = lifecycle.slice(-8).map((record) => ({
    event: record.event,
    agentIdMatches: record.agentId === expectedAgentId,
    ...(safeInteger(record.round) !== undefined ? { round: safeInteger(record.round) } : {}),
    ...(safeInteger(record.code) !== undefined ? { code: safeInteger(record.code) } : {}),
    ...(safeSignal(record.signal) !== undefined ? { signal: safeSignal(record.signal) } : {}),
    ...(Number.isFinite(record.timeoutSeconds) && record.timeoutSeconds > 0
      ? { timeoutSeconds: Number(record.timeoutSeconds) }
      : {}),
  }));
  return {
    capturedBytes: Buffer.byteLength(source),
    redactedLogSha256: hashText(redactStructuredText(source)),
    parsedRecords: records.length,
    lifecycleRecords: lifecycle.length,
    matchingStartRecords: lifecycle.filter((record) =>
      record.event === 'pi_process_starting' && record.agentId === expectedAgentId).length,
    matchingSuccessfulExitRecords: lifecycle.filter((record) =>
      record.event === 'pi_process_exited' &&
      record.agentId === expectedAgentId &&
      record.round === 1 &&
      record.code === 0 &&
      record.signal === null &&
      !matchingRoundOneFailure &&
      matchingRoundOneStart).length,
    lastLifecycleEvents,
  };
}

function inspectPiRuntimeLogs(logText, options, environment, phase, label) {
  const records = parsePiRuntimeLogRecords(logText).filter((record) => record.runtime === 'pi');
  const expectedAgentId = 'e2e-' + environment + '-' + phase + '-' + options.runId;
  const starts = records.filter((record) => record.event === 'pi_process_starting');
  const diagnostic = piRuntimeLogDiagnostic(logText, expectedAgentId);
  if (!starts.length) return { successful: false, llm: undefined, diagnostic };
  assert.equal(starts.length, 1, label + ' Pi emitted more than one process-start record');
  for (const start of starts) {
    assert.equal(start.agentId, expectedAgentId, label + ' Pi used the wrong Agent ID');
    assert.equal(start.round, 1, label + ' Pi proof is not bound to the fresh workload first turn');
    assert.equal(start.mode, 'loop', label + ' Pi did not run in real loop mode');
    assert.equal(start.provider, options.piProvider, label + ' Pi used the wrong provider');
    assert.equal(start.model, options.piModel, label + ' Pi used the wrong model');
    assert.equal(
      start.credentialSource,
      'DEEPSEEK_API_KEY',
      label + ' Pi did not consume the mounted DeepSeek credential',
    );
  }
  const start = starts[0];
  const terminalEvents = records.filter((record) =>
    ['pi_process_timeout', 'pi_process_error', 'pi_process_exited'].includes(record.event));
  for (const terminal of terminalEvents) {
    assert.equal(terminal.agentId, expectedAgentId, label + ' Pi terminal record used the wrong Agent ID');
    assert.equal(terminal.round, 1, label + ' Pi terminal record belongs to a different turn');
  }
  const exits = terminalEvents.filter((record) => record.event === 'pi_process_exited');
  assert.ok(exits.length <= 1, label + ' Pi emitted duplicate first-turn exit records');
  const terminalFailure = terminalEvents.some((record) =>
    record.event === 'pi_process_timeout' ||
    record.event === 'pi_process_error' ||
    (record.event === 'pi_process_exited' && (record.code !== 0 || record.signal !== null)));
  const successful = !terminalFailure &&
    exits.length === 1 && exits[0].code === 0 && exits[0].signal === null;
  return {
    successful,
    terminalFailure,
    llm: {
      provider: start.provider,
      model: start.model,
      agentId: start.agentId,
      credentialSource: start.credentialSource,
      round: start.round,
    },
    diagnostic,
  };
}

function assertPiRuntimeLogs(logText, options, environment, phase, label) {
  const inspected = inspectPiRuntimeLogs(logText, options, environment, phase, label);
  const expectedAgentId = 'e2e-' + environment + '-' + phase + '-' + options.runId;
  const start = inspected.llm;
  assert.ok(start, label + ' Pi did not emit a structured process-start record');
  assert.ok(
    inspected.successful,
    label + ' Pi real model turn did not exit successfully; structured state=' +
      JSON.stringify(inspected.diagnostic),
  );
  assert.equal(start.agentId, expectedAgentId, label + ' Pi used the wrong Agent ID');
  return start;
}

async function waitForSuccessfulPiRuntimeLogs(
  readLogs,
  options,
  environment,
  phase,
  label,
  timeoutMs = PI_RUNTIME_EXIT_WAIT_MS,
  intervalMs = POLL_MS,
) {
  const deadline = Date.now() + timeoutMs;
  const expectedAgentId = 'e2e-' + environment + '-' + phase + '-' + options.runId;
  let latestLogText = '';
  let latestRead = { code: undefined, signal: undefined, stderrBytes: 0, stderrSha256: undefined };
  while (Date.now() < deadline) {
    if (ledger.aborting) {
      const interrupted = new Error('execution interrupted while waiting for ' + label + ' Pi exit');
      interrupted.piRuntimeDiagnostic = {
        ...piRuntimeLogDiagnostic(latestLogText, expectedAgentId),
        logRead: latestRead,
      };
      throw interrupted;
    }
    let result;
    try {
      result = await readLogs();
    } catch (error) {
      latestRead = {
        code: undefined,
        signal: undefined,
        stderrBytes: 0,
        stderrSha256: undefined,
        readError: boundedRedactedText(
          error instanceof Error ? error.message : String(error),
          512,
        ).tail,
      };
      await delay(intervalMs);
      continue;
    }
    latestRead = {
      code: Number.isSafeInteger(result.code) ? result.code : result.code === null ? null : undefined,
      signal: typeof result.signal === 'string' && /^SIG[A-Z0-9]+$/u.test(result.signal)
        ? result.signal
        : result.signal === null ? null : undefined,
      stderrBytes: Buffer.byteLength(result.stderr || ''),
      stderrSha256: hashText(redactStructuredText(result.stderr || '')),
    };
    if (result.code === 0) {
      latestLogText = [result.stdout || '', result.stderr || '']
        .filter((stream) => stream.length > 0)
        .join('\n');
      try {
        const inspected = inspectPiRuntimeLogs(
          latestLogText,
          options,
          environment,
          phase,
          label,
        );
        if (inspected.successful) {
          return {
            logText: latestLogText,
            llm: inspected.llm,
            diagnostic: { ...inspected.diagnostic, logRead: latestRead },
          };
        }
        if (inspected.terminalFailure) {
          const failure = new Error(label + ' Pi fresh-workload first turn terminated without success');
          failure.piRuntimeDiagnostic = {
            ...inspected.diagnostic,
            logRead: latestRead,
          };
          throw failure;
        }
      } catch (error) {
        if (error instanceof Error) {
          error.piRuntimeDiagnostic = {
            ...piRuntimeLogDiagnostic(latestLogText, expectedAgentId),
            logRead: latestRead,
          };
        }
        throw error;
      }
    }
    await delay(intervalMs);
  }
  const failure = new Error(label + ' Pi real model turn did not emit a successful structured exit before timeout');
  failure.piRuntimeDiagnostic = {
    ...piRuntimeLogDiagnostic(latestLogText, expectedAgentId),
    logRead: latestRead,
  };
  throw failure;
}

async function writeDockerPiMarkerFile(options, phase, markerValue) {
  assert.match(markerValue, /^[a-z0-9-]{1,160}$/u, 'Pi marker must use the safe alphabet');
  const directory = path.join(ledger.tempRoot, 'pi-marker-docker-' + phase);
  await fs.mkdir(directory, { recursive: true, mode: 0o750 });
  await fs.writeFile(path.join(directory, 'value'), markerValue + '\n', { mode: 0o640, flag: 'wx' });
  return directory;
}

function filterCanaryMarker(options, environment, phase) {
  return marker(options, environment, phase,
    environment === 'host' ? 'non-agent-filter-canary' : 'unknown-filter-canary');
}

function filterCanaryContract(environment, phase) {
  assert.ok(['host', 'docker', 'k8s'].includes(environment), 'filter canary environment is invalid');
  assert.ok(ALLOWED_PHASES.has(phase), 'filter canary phase is invalid');
  const host = environment === 'host';
  const metrics = host
    ? { shadow: 'wouldFilterNonAgent', enforce: 'filteredNonAgent' }
    : { shadow: 'wouldFilterUnknown', enforce: 'filteredUnknown' };
  return {
    classification: host ? 'non_agent' : 'unknown',
    filterReason: host ? 'non_agent' : 'unknown',
    metricName: metrics[phase],
    // The API intentionally discards non-Agent events before L1 even when the node-local
    // Forwarder is in Shadow. Unknown container work remains visible in Shadow for comparison.
    shadowVisible: !host,
    shadowApiDisposition: host ? 'non_agent_discarded' : 'retained',
  };
}

function filterCanaryCommand() {
  return [
    'set -eu',
    // Poll once per second and stop on its own if the controller never arms the canary. The sleep
    // command carries no marker; only the final /usr/bin/true exec can satisfy marker correlation.
    'remaining=' + FILTER_CANARY_WAIT_SECONDS,
    'while [ ! -f /run/canary/go ]; do [ "$remaining" -gt 0 ] || exit 124; remaining=$((remaining - 1)); /bin/sleep 1; done',
    'marker="$(cat /run/canary/value)"',
    '/usr/bin/true "$marker"',
    // Docker daemon state queries can lag even after task-delete. Record the command result in the
    // private run-owned bind directory; the raw kernel witness and correlated filter receipt still
    // provide the independent proof that the exact marker-bearing exec occurred.
    'umask 077',
    'printf "0\\n" > /run/canary/.' + FILTER_CANARY_COMPLETION_FILE + '.tmp',
    'mv /run/canary/.' + FILTER_CANARY_COMPLETION_FILE + '.tmp /run/canary/' + FILTER_CANARY_COMPLETION_FILE,
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

function hostFilterCanaryRunnerPayload(directory, markerValue) {
  assert.match(markerValue, /^[a-z0-9-]{1,160}$/u, 'host filter canary marker must use the safe alphabet');
  return {
    schema: HOST_FILTER_CANARY_RUNNER_SCHEMA,
    agent: 'filter-canary',
    command: '/usr/bin/true',
    args: [expectedMarkerHash(markerValue)],
    cwd: directory,
    env: {},
  };
}

async function startHostFilterCanary(options, phase) {
  const environment = 'host';
  const markerValue = filterCanaryMarker(options, environment, phase);
  const files = await writeFilterCanaryFiles(options, environment, phase);
  const resolvedFiles = path.resolve(files);
  const resolvedRoot = path.resolve(ledger.tempRoot);
  if (!resolvedFiles.startsWith(resolvedRoot + path.sep)) {
    throw new Error('refused to launch host filter canary outside the run workspace');
  }
  const directoryIdentity = localPathIdentity(await fs.lstat(resolvedFiles));
  assert.equal(directoryIdentity.directory, true, 'host filter canary run path is not a directory');
  const payload = hostFilterCanaryRunnerPayload(resolvedFiles, markerValue);
  const unitName = hostFilterCanaryUnitName(options, phase);
  let service;
  try {
    service = await launchHostAgentService(options, phase, 'filter-canary', payload, {
      unitName,
      expectedEnvironment: {},
      proofValues: [markerValue],
    });
    const [clientArgv, runnerArgv] = await Promise.all([
      processArguments(service.record.child.pid),
      processArguments(service.state.execMainPid),
    ]);
    for (const argv of [clientArgv, runnerArgv]) {
      assert.equal(argv.includes(markerValue), false, 'host filter canary marker appeared in launcher argv');
    }
  } catch (error) {
    if (service && ledger.systemdUnits.has(unitName)) {
      try {
        await stopTrackedSystemdUnit(unitName, true);
      } catch (cleanupError) {
        error.message += '; host filter canary cleanup failed: ' + redact(cleanupError.message);
      }
    }
    throw error;
  }
  return {
    name: unitName,
    environment,
    phase,
    marker: markerValue,
    triggerFile: path.join(resolvedFiles, 'go'),
    directory: resolvedFiles,
    directoryIdentity,
    record: service.record,
    systemd: service,
  };
}

async function startDockerFilterCanary(options, environment, phase) {
  const name = k8sName(options, 'filter-canary', environment, phase);
  const ownership = { nonce: ownershipNonce() };
  const files = await writeFilterCanaryFiles(options, environment, phase);
  const filesState = await localPathState(files);
  if (!filesState.exists || !filesState.identity.directory) {
    throw new Error('Docker filter-canary directory is not a tracked local directory');
  }
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
    // Only this private run-owned directory is writable. It carries the trigger and an atomic
    // command-completion record; the image root remains read-only and all capabilities are dropped.
    '-v', files + ':/run/canary:rw',
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
    completionFile: path.join(files, FILTER_CANARY_COMPLETION_FILE),
    directory: files,
    directoryIdentity: filesState.identity,
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
  if (runRecord.environment === 'host') {
    const state = await localPathState(runRecord.directory);
    if (!state.exists || !state.identity.directory ||
        !sameLocalPathIdentity(state.identity, runRecord.directoryIdentity)) {
      throw new Error('refused to trigger host filter canary after its run directory changed');
    }
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

function filterReceiptMatchDetails(receipt, runRecord, rawWitness) {
  const contract = filterCanaryContract(runRecord.environment, runRecord.phase);
  const observedAt = Date.parse(rawWitness?.observedAt || '');
  const filteredAt = Date.parse(receipt?.filteredAt || '');
  const physical = String(receipt?.physicalWorkloadId || '');
  const containerId = String(runRecord.containerId || '');
  const physicalMatch = runRecord.environment === 'host' ||
    (containerId.length >= 12 &&
      (physical.includes(containerId) || physical.includes(containerId.slice(0, 12))));
  const details = {
    schemaMatch: receipt?.schema === 'anysentry.e2e_filter_receipt.v1',
    eventKindMatch: receipt?.eventKind === 'ToolExec',
    markerHashMatch: receipt?.markerSha256 === expectedMarkerHash(runRecord.marker),
    lineHashMatch: receipt?.lineSha256 === rawWitness?.lineSha256,
    classificationMatch: receipt?.classification === contract.classification,
    filterReasonMatch: receipt?.filterReason === contract.filterReason,
    filteredAfterWitness: Number.isFinite(observedAt) && Number.isFinite(filteredAt) &&
      filteredAt >= observedAt,
    physicalMatch,
  };
  return {
    ...details,
    matched: Object.values(details).every(Boolean),
  };
}

function matchingFilterReceipt(heartbeat, runRecord, rawWitness) {
  return heartbeat?.filterMetrics?.e2eFilterReceipts?.find((receipt) =>
    filterReceiptMatchDetails(receipt, runRecord, rawWitness).matched,
  );
}

function uniqueHeartbeatEvidence(samples, current) {
  const unique = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(samples) ? samples : []), ...(current ? [current] : [])]) {
    if (item?.filterMetricsReported !== true) continue;
    const fingerprint = heartbeatCursor(item).filterMetricsFingerprint;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push(item);
  }
  return unique;
}

function findCorrelatedFilterHeartbeat(
  samples,
  current,
  armedHeartbeat,
  metricName,
  runRecord,
  rawWitness,
) {
  const heartbeats = uniqueHeartbeatEvidence(samples, current);
  for (const heartbeat of heartbeats) {
    if (!heartbeatAdvanced(armedHeartbeat, heartbeat)) continue;
    if (!(Number(heartbeat?.filterMetrics?.[metricName]) > 0)) continue;
    const receipt = matchingFilterReceipt(heartbeat, runRecord, rawWitness);
    if (receipt) {
      return {
        heartbeat,
        receipt,
        examinedHeartbeatCount: heartbeats.length,
      };
    }
  }
  return undefined;
}

function filterReceiptCorrelationDiagnostic(
  samples,
  current,
  armedHeartbeat,
  metricName,
  runRecord,
  rawWitness,
) {
  const heartbeats = uniqueHeartbeatEvidence(samples, current);
  const candidates = [];
  let advancedHeartbeatCount = 0;
  let positiveMetricHeartbeatCount = 0;
  for (const heartbeat of heartbeats) {
    const advanced = heartbeatAdvanced(armedHeartbeat, heartbeat);
    const metricValue = Number(heartbeat?.filterMetrics?.[metricName]) || 0;
    if (advanced) advancedHeartbeatCount += 1;
    if (advanced && metricValue > 0) positiveMetricHeartbeatCount += 1;
    for (const receipt of heartbeat?.filterMetrics?.e2eFilterReceipts || []) {
      const details = filterReceiptMatchDetails(receipt, runRecord, rawWitness);
      candidates.push({
        heartbeatAdvanced: advanced,
        metricPositive: metricValue > 0,
        markerSha256: /^[a-f0-9]{64}$/u.test(receipt?.markerSha256 || '')
          ? receipt.markerSha256
          : '<invalid-hash>',
        lineSha256: /^[a-f0-9]{64}$/u.test(receipt?.lineSha256 || '')
          ? receipt.lineSha256
          : '<invalid-hash>',
        ...details,
      });
    }
  }
  return {
    heartbeatCount: heartbeats.length,
    advancedHeartbeatCount,
    positiveMetricHeartbeatCount,
    receiptCount: candidates.length,
    candidates: candidates.slice(-8),
  };
}

async function waitForCorrelatedFilterHeartbeat(
  apiBase,
  collectorId,
  sampler,
  armedHeartbeat,
  metricName,
  runRecord,
  rawWitness,
  label,
) {
  assert.equal(typeof sampler?.snapshot, 'function', 'filter receipt history sampler is unavailable');
  let current;
  try {
    return await eventually(label, async () => {
      current = await queryHeartbeat(apiBase, collectorId);
      return findCorrelatedFilterHeartbeat(
        sampler.snapshot(),
        current,
        armedHeartbeat,
        metricName,
        runRecord,
        rawWitness,
      );
    }, 30_000, 200);
  } catch (error) {
    const diagnostic = filterReceiptCorrelationDiagnostic(
      sampler.snapshot(),
      current,
      armedHeartbeat,
      metricName,
      runRecord,
      rawWitness,
    );
    throw new Error(
      (error instanceof Error ? error.message : String(error)) +
      '; safeReceiptDiagnostic=' + JSON.stringify(diagnostic),
    );
  }
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
    return { method: 'kubernetes-terminated-state', exitCode: 0 };
  }
  if (runRecord.environment === 'host') {
    let timer;
    try {
      const result = await Promise.race([
        runRecord.record.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Host filter canary did not complete in 30 seconds')), 30_000);
        }),
      ]);
      assert.equal(
        result.code,
        0,
        'Host filter canary exited unsuccessfully; stderr hash=' + hashText(result.stderr),
      );
    } finally {
      clearTimeout(timer);
    }
    return { method: 'systemd-process-result', exitCode: 0 };
  }
  return await eventually('Docker filter canary command completion', async () => {
    const directoryState = await localPathState(runRecord.directory);
    if (!directoryState.exists || !directoryState.identity.directory ||
        !sameLocalPathIdentity(directoryState.identity, runRecord.directoryIdentity)) {
      throw new Error('run-owned filter-canary directory identity changed');
    }
    assert.equal(
      runRecord.completionFile,
      path.join(runRecord.directory, FILTER_CANARY_COMPLETION_FILE),
      'Docker filter-canary completion path changed',
    );
    const proof = await readLocalProofTextFile(runRecord.directory, FILTER_CANARY_COMPLETION_FILE);
    if (!proof.exists) return undefined;
    if (proof.status !== 'ok') {
      throw new Error('Docker filter-canary completion record is ' + proof.status);
    }
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : 1000;
    const expectedGid = typeof process.getgid === 'function' ? process.getgid() : 1000;
    assert.equal(proof.mode, 0o600, 'Docker filter-canary completion record is not mode 0600');
    assert.equal(proof.uid, expectedUid, 'Docker filter-canary completion record has the wrong owner');
    assert.equal(proof.gid, expectedGid, 'Docker filter-canary completion record has the wrong group');
    assert.equal(proof.text, '0\n', 'Docker filter-canary command returned a non-zero result');
    return {
      method: 'run-owned-atomic-completion-record',
      exitCode: 0,
      bytes: proof.bytes,
      mode: proof.mode.toString(8).padStart(3, '0'),
    };
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
    return {
      exists: true,
      status: 'ok',
      bytes: content.length,
      text: content.toString('utf8'),
      mode: opened.mode & 0o777,
      uid: opened.uid,
      gid: opened.gid,
    };
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
    name !== 'KIMI_SHARE_DIR' &&
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
    controlGroupIdentity: undefined,
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
    ownership.controlGroupIdentity = await systemdControlGroupIdentity(state.controlGroup);
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
  let llmConfiguration;
  if (agent === 'host-codex') {
    command = resolvedExecutable.path;
    args = hostCodexArgs(options, workspace, prompt);
    assertHostCodexLaunchAuthorization(options, args);
  } else if (agent === 'host-kimi') {
    for (const name of [
      'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
      'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    ]) delete environment[name];
    const config = options.kimiConfig;
    assert.ok(config?.path && config?.identity, 'host-kimi has no run-owned configuration');
    assert.equal(path.dirname(config.path), ledger.tempRoot, 'Host Kimi config escaped the run temp root');
    const verifiedConfig = await readVerifiedRunOwnedFile(
      config.path,
      config.bytes,
      config.sha256,
      config.identity,
      'run-owned Host Kimi config before launch',
    );
    verifiedConfig.content.fill(0);
    const shareDirectory = path.join(ledger.tempRoot, 'kimi-state-' + phase);
    await fs.mkdir(shareDirectory, { mode: 0o700 });
    const shareStat = await fs.lstat(shareDirectory);
    const ownedByCaller = typeof process.getuid !== 'function' || shareStat.uid === process.getuid();
    assert.equal(
      shareStat.isDirectory() && !shareStat.isSymbolicLink() &&
        (shareStat.mode & 0o777) === 0o700 && ownedByCaller,
      true,
      'Host Kimi state directory is not a run-owned 0700 directory',
    );
    environment.KIMI_SHARE_DIR = shareDirectory;
    registerRuntimeEvidenceRedactionLiteral(shareDirectory);
    command = resolvedExecutable.path;
    args = [
      '--config-file', config.path, '--model', config.modelKey,
      '--work-dir', workspace, '--print', '--no-thinking', '--max-steps-per-turn', '8',
      '--mcp-config', '{}', '--skills-dir', path.join(workspace, 'empty-skills'),
      '--prompt', prompt,
    ];
    llmConfiguration = {
      provider: options.piProvider,
      model: options.piModel,
      source: 'run-owned-kimi-config',
      stateIsolation: true,
      proxyEnvironmentForwarded: false,
    };
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
    llmConfiguration,
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
    llm: runRecord.llmConfiguration,
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
  const markerDirectoryState = await localPathState(markerDirectory);
  if (!markerDirectoryState.exists || !markerDirectoryState.identity.directory) {
    throw new Error('Docker Pi marker directory is not a tracked local directory');
  }
  const runtimeImageId = resolvedDockerImage(options, options.agentImage);
  const gateCommand = piMarkerHelperGateCommand(options.piMarkerHelperSha256, true);
  const gatedCommand = [
    '-c', gateCommand, 'anysentry-pi-marker-helper-gate',
    '/usr/bin/timeout',
    '-s', 'TERM', '-k', String(CONTAINER_KILL_GRACE_SECONDS), String(AGENT_MAX_RUNTIME_SECONDS),
    '/opt/agent-lab/entrypoint.sh',
  ];
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
    ...(options.piModelsFile
      ? ['-v', options.piModelsFile + ':/home/node/.pi/agent/models.json:ro']
      : []),
    '-v', markerDirectory + ':/run/anysentry-e2e-marker:ro',
    ...dockerEnvArgs(piEnvironment(options, 'docker', phase)),
    '--entrypoint', '/bin/sh',
    runtimeImageId,
    ...gatedCommand,
  ];
  ledger.dockerContainers.set(name, ownership);
  const created = await trackMutation(() => run('docker', args, { timeoutMs: 60_000 }));
  const containerId = created.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) throw new Error('docker run returned an invalid workload ID');
  ownership.id = containerId;
  if (!(await dockerResourceOwned(name, ledger.runId, ownership))) {
    throw new Error('new Docker workload ownership could not be verified: ' + name);
  }
  await assertDockerContainerImage(name, runtimeImageId);
  const agentImageProof = await assertDockerPiImageAndMarkerHelper(
    name,
    options.agentImage,
    runtimeImageId,
    options.piMarkerHelperSha256,
    gatedCommand,
  );
  return {
    name,
    marker: markerValue,
    environment: 'docker',
    phase,
    markerDirectory,
    markerDirectoryIdentity: markerDirectoryState.identity,
    markerReleaseFile: path.join(markerDirectory, 'go'),
    agentImageProof,
  };
}

function assertPiResultFiles(result, expectedProofHash, label) {
  assert.equal(result.code, 0, label + ' Pi proof files were not readable after the successful exit');
  const toolHash = String(result.stdout).split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^([a-f0-9]{64})\s+\/workspace\/tool-events\.log$/u);
    return match ? [match[1]] : [];
  });
  assert.deepEqual(toolHash, [expectedProofHash], label + ' Pi tool marker changed across process exit');
  return redact(result.stdout.trim());
}

async function assertPiMarkerReleaseStillClosed(runRecord) {
  const result = runRecord.environment === 'docker'
    ? await run('docker', [
        'exec', runRecord.name, '/bin/sh', '-c',
        'test ! -e /run/anysentry-e2e-marker/go && test ! -e /workspace/tool-events.log',
      ], { allowFailure: true, timeoutMs: 10_000 })
    : await run('kubectl', [
        '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
        '/bin/sh', '-c',
        'test ! -e /run/anysentry-e2e-release/go && test ! -e /workspace/tool-events.log',
      ], { allowFailure: true, timeoutMs: 10_000 });
  assert.equal(
    result.code,
    0,
    (runRecord.environment === 'docker' ? 'Docker' : 'Kubernetes') +
      ' Pi marker helper was not still held immediately before release',
  );
  return {
    checkedAt: new Date().toISOString(),
    releaseFileAbsent: true,
    toolProofAbsent: true,
    verifiedHelperSha256: runRecord.agentImageProof?.markerHelper?.sourceSha256 ??
      runRecord.agentImageProof?.containers?.find((item) => item.container === 'workload')
        ?.markerHelper?.sourceSha256,
    pathReported: false,
  };
}

async function releasePiMarker(runRecord) {
  const releasedAt = new Date().toISOString();
  if (runRecord.environment === 'docker') {
    const directoryState = await localPathState(runRecord.markerDirectory);
    if (!directoryState.exists || !directoryState.identity.directory ||
        !sameLocalPathIdentity(directoryState.identity, runRecord.markerDirectoryIdentity)) {
      throw new Error('refused to release Docker Pi marker after its run directory changed');
    }
    assert.equal(
      runRecord.markerReleaseFile,
      path.join(runRecord.markerDirectory, 'go'),
      'Docker Pi marker release path changed',
    );
    const content = Buffer.from('go\n');
    const published = await atomicallyPublishRunOwnedFile(
      runRecord.markerDirectory,
      runRecord.markerDirectoryIdentity,
      path.basename(runRecord.markerReleaseFile),
      content,
      'Docker Pi marker release file',
    );
    return {
      method: 'host-fsynced-file-atomically-renamed-into-read-only-bind',
      releasedAt,
      bytes: 3,
      mode: (published.identity.mode & 0o777).toString(8),
      sha256: published.sha256,
      pathReported: false,
    };
  }
  assert.equal(runRecord.environment, 'k8s', 'Pi marker release environment is unsupported');
  await eventually('Kubernetes Pi marker release sidecar', async () => {
    const result = await run('kubectl', [
      '-n', runRecord.namespace, 'exec', runRecord.name,
      '-c', runRecord.markerReleaseContainer, '--',
      '/bin/sh', '-c',
      "set -eu; if [ -f /release/go ] && [ ! -L /release/go ] && [ \"$(cat /release/go)\" = go ]; then exit 0; fi; test ! -e /release/go; test ! -e /release/.go.tmp; printf 'go\\n' > /release/.go.tmp; chmod 600 /release/.go.tmp; mv /release/.go.tmp /release/go",
    ], { allowFailure: true, timeoutMs: 10_000 });
    return result.code === 0 ? true : false;
  }, 60_000, 500);
  const verified = await run('kubectl', [
    '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
    '/bin/sh', '-c',
    "test -f /run/anysentry-e2e-release/go && test ! -L /run/anysentry-e2e-release/go && [ \"$(cat /run/anysentry-e2e-release/go)\" = go ] && [ \"$(stat -c '%a %s' /run/anysentry-e2e-release/go)\" = '600 3' ]",
  ], { allowFailure: true, timeoutMs: 10_000 });
  assert.equal(verified.code, 0, 'Kubernetes workload could not verify the read-only Pi marker release');
  return {
    method: 'run-owned-sidecar-to-read-only-shared-memory-volume',
    releasedAt,
    bytes: 3,
    mode: '600',
    sha256: hashText('go\n'),
    pathReported: false,
  };
}

async function dockerPiProof(options, runRecord) {
  const expectedProofHash = hashText(runRecord.marker + '\n');
  await eventually('Docker Pi real LLM tool result', async () => {
    const result = await run('docker', [
      'exec', runRecord.name, '/bin/sh', '-c',
      'test -s /workspace/model-result.txt && sha256sum /workspace/tool-events.log',
    ], { allowFailure: true, timeoutMs: 10_000 });
    return result.code === 0 && result.stdout.trim().split(/\s+/u)[0] === expectedProofHash ? true : false;
  }, 180_000, 1_000);
  const runtimeProof = await waitForSuccessfulPiRuntimeLogs(
    () => run('docker', ['logs', runRecord.name], { allowFailure: true, timeoutMs: 15_000 }),
    options,
    runRecord.environment,
    runRecord.phase,
    'Docker',
  );
  const hashes = await run('docker', [
    'exec', runRecord.name, '/bin/sh', '-c',
    'test -s /workspace/model-result.txt && wc -c /workspace/tool-events.log /workspace/model-result.txt && sha256sum /workspace/tool-events.log /workspace/model-result.txt',
  ], { allowFailure: true, timeoutMs: 15_000 });
  const resultFiles = assertPiResultFiles(hashes, expectedProofHash, 'Docker');
  return {
    realLlm: true,
    llm: runtimeProof.llm,
    markerPresent: true,
    logs: {
      bytes: Buffer.byteLength(runtimeProof.logText),
      sha256: hashText(redactStructuredText(runtimeProof.logText)),
      structured: runtimeProof.diagnostic,
    },
    resultFiles,
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
      initContainers: [{
        name: 'marker-helper-gate',
        image: options.agentImage,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sh', '-c'],
        args: [piMarkerHelperGateCommand(options.piMarkerHelperSha256, false)],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        resources: {
          requests: { cpu: '5m', memory: '8Mi' },
          limits: { cpu: '50m', memory: '32Mi' },
        },
      }],
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
          ...(options.piModelsFile
            ? [{
                name: 'pi-config',
                mountPath: '/home/node/.pi/agent/models.json',
                subPath: 'models.json',
                readOnly: true,
              }]
            : []),
          { name: 'marker', mountPath: '/run/anysentry-e2e-marker', readOnly: true },
          { name: 'marker-release', mountPath: '/run/anysentry-e2e-release', readOnly: true },
          { name: 'tmp', mountPath: '/tmp' },
        ],
        resources: {
          requests: { cpu: '50m', memory: '128Mi' },
          limits: { cpu: '1', memory: '768Mi' },
        },
      }, {
        name: 'release-gate',
        image: options.agentImage,
        imagePullPolicy: 'IfNotPresent',
        command: ['/bin/sh', '-c'],
        args: ['umask 077; while :; do /bin/sleep 3600; done'],
        securityContext: {
          allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true,
          capabilities: { drop: ['ALL'] },
        },
        volumeMounts: [
          { name: 'marker-release', mountPath: '/release' },
          { name: 'release-tmp', mountPath: '/tmp' },
        ],
        resources: {
          requests: { cpu: '5m', memory: '8Mi' },
          limits: { cpu: '50m', memory: '32Mi' },
        },
      }],
      volumes: [
        { name: 'workspace', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'pi-state', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'credentials', secret: { secretName, defaultMode: 288 } },
        ...(options.piModelsFile
          ? [{
              name: 'pi-config',
              secret: {
                secretName,
                defaultMode: 288,
                items: [{ key: 'models.json', path: 'models.json' }],
              },
            }]
          : []),
        { name: 'marker', secret: { secretName: markerSecretName, defaultMode: 288 } },
        { name: 'marker-release', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
        { name: 'tmp', emptyDir: { medium: 'Memory', sizeLimit: '32Mi' } },
        { name: 'release-tmp', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } },
      ],
    },
  };
  await createK8sObject(namespace, 'pod', name, manifest, ledger.k8sPods);
  const agentImageProof = await assertK8sPiImageAndMarkerHelper(
    namespace,
    name,
    options.agentImage,
    options.piMarkerHelperSha256,
  );
  return {
    name,
    namespace,
    marker: markerValue,
    markerSecretName,
    markerReleaseContainer: 'release-gate',
    environment: 'k8s',
    phase,
    agentImageProof,
  };
}

async function k8sPiProof(options, runRecord) {
  const expectedProofHash = hashText(runRecord.marker + '\n');
  await eventually('Kubernetes Pi real LLM tool result', async () => {
    const result = await run('kubectl', [
      '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
      '/bin/sh', '-c',
      'test -s /workspace/model-result.txt && sha256sum /workspace/tool-events.log',
    ], { allowFailure: true, timeoutMs: 15_000 });
    return result.code === 0 && result.stdout.trim().split(/\s+/u)[0] === expectedProofHash ? true : false;
  }, 180_000, 1_000);
  const runtimeProof = await waitForSuccessfulPiRuntimeLogs(
    () => run('kubectl', [
      '-n', runRecord.namespace, 'logs', runRecord.name, '-c', 'workload',
    ], { allowFailure: true, timeoutMs: 15_000 }),
    options,
    runRecord.environment,
    runRecord.phase,
    'Kubernetes',
  );
  const hashes = await run('kubectl', [
    '-n', runRecord.namespace, 'exec', runRecord.name, '-c', 'workload', '--',
    '/bin/sh', '-c',
    'test -s /workspace/model-result.txt && wc -c /workspace/tool-events.log /workspace/model-result.txt && sha256sum /workspace/tool-events.log /workspace/model-result.txt',
  ], { allowFailure: true, timeoutMs: 15_000 });
  const resultFiles = assertPiResultFiles(hashes, expectedProofHash, 'Kubernetes');
  return {
    realLlm: true,
    llm: runtimeProof.llm,
    markerPresent: true,
    logs: {
      bytes: Buffer.byteLength(runtimeProof.logText),
      sha256: hashText(redactStructuredText(runtimeProof.logText)),
      structured: runtimeProof.diagnostic,
    },
    resultFiles,
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
    assertCompleteRuntimeInventory(runtime, collector + ' running-instance lookup');
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
  const currentControlGroupIdentity = await systemdControlGroupIdentity(state.controlGroup);
  if (!sameLocalPathIdentity(currentControlGroupIdentity, service.ownership.controlGroupIdentity)) {
    throw new Error('host Agent systemd control-group identity changed while matching runtime');
  }
  const ancestry = await processAncestry(candidate.rootPid);
  const identity = ancestry[0];
  if (!identity || identity.startTime !== String(candidate.rootStartTimeTicks)) return undefined;
  if (candidate.rootPid === service.state.execMainPid) return undefined;
  if (!ancestry.some((record) =>
    record.pid === service.state.execMainPid &&
    record.startTime === service.detached.execMainStartTimeTicks)) return undefined;
  let observedControlGroup;
  try {
    observedControlGroup = await processUnifiedControlGroup(candidate.rootPid);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
  if (!controlGroupContains(service.ownership.controlGroup, observedControlGroup)) return undefined;
  const confirmedAncestry = await processAncestry(candidate.rootPid);
  const confirmedIdentity = confirmedAncestry[0];
  if (!confirmedIdentity || confirmedIdentity.startTime !== String(candidate.rootStartTimeTicks)) return undefined;
  if (!confirmedAncestry.some((record) =>
    record.pid === service.state.execMainPid &&
    record.startTime === service.detached.execMainStartTimeTicks)) return undefined;
  if (!runtimeCandidateMatchesHostAgent(candidate, runRecord.agent, confirmedIdentity.comm)) return undefined;
  return {
    processKey: String(candidate.rootPid) + ':' + String(candidate.rootStartTimeTicks),
    controlGroup: observedControlGroup,
    cgroupId: service.ownership.controlGroupIdentity.ino,
    unit: service.unitName,
    invocationId: service.ownership.invocationId,
    launcherPid: service.state.execMainPid,
    launcherStartTimeTicks: service.detached.execMainStartTimeTicks,
  };
}

function hostRuntimePlacementEvidence(candidate, placement) {
  return {
    agentInstanceId: candidate.agentInstanceId,
    agentScopeId: candidate.agentScopeId,
    agentDisplayName: candidate.agentDisplayName,
    classification: candidate.classification,
    rootPid: candidate.rootPid,
    rootStartTimeTicks: String(candidate.rootStartTimeTicks),
    hostId: candidate.hostId,
    bootId: candidate.bootId,
    cgroupId: placement.cgroupId,
    unit: placement.unit,
    invocationId: placement.invocationId,
    launcherPid: placement.launcherPid,
    launcherStartTimeTicks: placement.launcherStartTimeTicks,
    observedAt: Date.now(),
  };
}

function startHostRuntimeOwnershipSampler(apiBase, collector, baselineIds, runRecord) {
  let stopping = false;
  let failure;
  const placements = new Map();
  const remember = (candidate, placement) => {
    if (!placement) return;
    const evidence = hostRuntimePlacementEvidence(candidate, placement);
    const existing = placements.get(evidence.agentInstanceId);
    if (existing) {
      for (const name of [
        'agentScopeId', 'agentDisplayName', 'classification', 'rootPid', 'rootStartTimeTicks',
        'hostId', 'bootId', 'cgroupId', 'unit', 'invocationId',
        'launcherPid', 'launcherStartTimeTicks',
      ]) {
        assert.equal(
          evidence[name],
          existing[name],
          'host owned runtime placement identity changed for ' + evidence.agentInstanceId,
        );
      }
      return;
    }
    placements.set(evidence.agentInstanceId, evidence);
  };
  const task = (async () => {
    while (!stopping) {
      try {
        const runtime = await queryRuntime(apiBase, { collectorId: collector });
        assertCompleteRuntimeInventory(runtime, collector + ' host ownership sampler');
        const candidates = runtime.items.filter((item) =>
          !baselineIds.has(item.agentInstanceId) &&
          item.runtimeState === 'running' &&
          item.agentScopeId === expectedScopeForAgent(runRecord.agent) &&
          runtimeIdentityIsComplete(item),
        );
        for (const candidate of candidates) {
          remember(candidate, await matchHostRuntimeToSystemdService(candidate, runRecord));
        }
      } catch (error) {
        failure = error;
        break;
      }
      if (!stopping) await delay(125);
    }
  })();
  return {
    remember,
    assertHealthy() {
      if (failure) throw failure;
    },
    async stop() {
      stopping = true;
      await task;
      if (failure) throw failure;
      return [...placements.values()];
    },
  };
}

async function waitForTerminalInstance(apiBase, collector, agentInstanceId) {
  return await eventually('terminal runtime instance ' + agentInstanceId, async () => {
    const runtime = await queryRuntime(apiBase, { collectorId: collector, agentInstanceId });
    const item = runtime.items.find((candidate) => candidate.agentInstanceId === agentInstanceId);
    return item && ['exited', 'lost'].includes(item.runtimeState) ? item : undefined;
  }, 90_000, 500);
}

function markerEventCandidateDiagnostic(result, markerValue, agentInstanceId, contract) {
  return {
    returnedItems: Array.isArray(result?.items) ? result.items.length : 0,
    candidates: (Array.isArray(result?.items) ? result.items : []).slice(0, 8).map((item) => ({
      eventKind: item?.eventKind,
      executable: path.posix.basename(String(item?.process?.exe || '')),
      exactShapeMatches: exactMarkerToolEvent(item, markerValue, agentInstanceId, contract),
      attributedAgentMatches: item?.attribution?.agentInstanceId === agentInstanceId,
      classification: item?.attribution?.classification,
      agentScopeId: item?.attribution?.agentScopeId,
      attributionReason: item?.attribution?.reason,
      attributionSource: item?.attribution?.source,
      execConfirmed: item?.attributes?.exec_confirmed,
      argvIncomplete: item?.attributes?.argv_incomplete,
      argvTruncated: item?.attributes?.argv_truncated,
      argvSource: item?.attributes?.argv_source,
      observedArgc: item?.attributes?.observed_argc,
    })),
  };
}

async function waitForMarkerEvent(
  context,
  collector,
  markerValue,
  agentInstanceId,
  contract = 'true',
) {
  return await eventually('attributed marker event ' + markerValue, async () => {
    const result = await queryCollectorEvents(
      context,
      collector,
      collector.environment + '/' + collector.phase + ' attributed marker event',
    );
    const matched = result.items.find((item) =>
      exactMarkerToolEvent(item, markerValue, agentInstanceId, contract));
    if (matched) return { item: matched, query: result.e2eQueryProof };
    throw new Error('safe candidate state=' + JSON.stringify(
      markerEventCandidateDiagnostic(result, markerValue, agentInstanceId, contract),
    ));
  }, 90_000, 500);
}

function eventContainsExactMarker(item, markerValue) {
  if (item?.eventKind !== 'ToolExec') return false;
  return String(item?.attributes?.argv || '').trim().split(/\s+/u).includes(markerValue);
}

function preReleaseMarkerViewProof(result, markerValue, view) {
  assert.equal(Number.isSafeInteger(result?.total) && result.total >= 0, true,
    'pre-release ' + view + ' marker query returned no valid total');
  assert.equal(result.items.length, result.total,
    'pre-release ' + view + ' marker query was truncated');
  assert.ok(result.items.length < E2E_EVENT_QUERY_LIMIT,
    'pre-release ' + view + ' marker query reached the page boundary');
  const matches = result.items.filter((item) => eventContainsExactMarker(item, markerValue));
  assert.equal(matches.length, 0,
    'Pi marker ToolExec was visible in the ' + view + ' view before its release gate opened');
  return {
    view,
    returnedItems: result.items.length,
    reportedTotal: result.total,
    totalApproximate: result.totalApproximate === true,
    storageFallback: result.storageFallback,
    matchingEvents: 0,
  };
}

async function preReleaseMarkerNegativeCheck(
  apiBase,
  collector,
  markerValue,
  phaseEventQueryStartTime,
  dependencies = {},
) {
  const query = dependencies.queryEvents ?? requestEventList;
  const wait = dependencies.eventually ?? eventually;
  const clock = typeof dependencies.now === 'function' ? dependencies.now : Date.now;
  const nowMs = clock();
  const startMs = Date.parse(String(phaseEventQueryStartTime || ''));
  assert.equal(Number.isFinite(startMs), true, 'pre-release marker query has no fixed phase start');
  const timeFilter = {
    timeType: 'custom',
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(nowMs + PRE_RELEASE_MARKER_FUTURE_SKEW_MS).toISOString(),
  };
  let durableAttempts = 0;
  // The durable endpoint pushes this fresh collector ID into ClickHouse's narrow locator query and
  // merges the hot ring before returning. Never pair it with agentEventsForWindow: that dashboard
  // path performs a global wide read before filtering by collector, can consume the shared read
  // slot, and can silently fall back to a partial hot-ring result.
  const durableResult = await wait('pre-release durable marker query', async () => {
    durableAttempts += 1;
    const result = await query(apiBase, collector, {
      ...timeFilter,
      durable: true,
    });
    if (result.storageFallback !== undefined) {
      throw new Error('durable marker query used storage fallback: ' + result.storageFallback);
    }
    return result;
  }, PRE_RELEASE_DURABLE_WAIT_MS, 1_000);
  validateCompleteE2eEventResult(
    durableResult,
    collector,
    'clickhouse-durable',
    Date.parse(timeFilter.startTime),
    Date.parse(timeFilter.endTime),
    'pre-release durable marker query',
  );
  // Do not pass q here. The API bounds durable candidates before text filtering; with q that
  // bound could hide an early marker and return a misleading zero. This run uses a fresh
  // collector ID plus marker-scoped forwarding, so fetch its entire small candidate set and apply
  // the exact marker predicate locally. items.length !== total remains a hard failure.
  const views = [
    preReleaseMarkerViewProof(durableResult, markerValue, 'durable-plus-hot-ring'),
  ];
  const checkedAtMs = clock();
  assert.ok(
    checkedAtMs <= Date.parse(timeFilter.endTime),
    'pre-release marker query exceeded its requested time window',
  );
  return {
    checkedAt: new Date(checkedAtMs).toISOString(),
    semantics: 'fresh-collector-durable-plus-hot-ring-negative-check',
    queryScope: 'fresh-collector-candidates-with-client-side-exact-marker-check',
    completeGlobalApiInventoryClaimed: false,
    completeFreshCollectorPageProved: true,
    queryWindow: timeFilter,
    durableAttempts,
    views,
  };
}

function apiEventAtMs(value) {
  const text = String(value || '').trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/u.test(text)
    ? text.replace(' ', 'T') + 'Z'
    : text;
  const parsed = Date.parse(normalized);
  assert.equal(Number.isFinite(parsed), true, 'marker event has no valid timestamp');
  return parsed;
}

function proveMarkerEventAfterRelease(event, absenceProof, markerRelease) {
  const checkedAtMs = Date.parse(absenceProof?.checkedAt || '');
  const releasedAtMs = Date.parse(markerRelease?.releasedAt || '');
  const eventAtValue = event?.at ?? event?.eventTime;
  const eventAtMs = apiEventAtMs(eventAtValue);
  assert.equal(Number.isFinite(checkedAtMs), true, 'pre-release marker absence proof has no timestamp');
  assert.equal(Number.isFinite(releasedAtMs), true, 'Pi marker release has no valid timestamp');
  assert.ok(releasedAtMs >= checkedAtMs, 'Pi marker release preceded its absence proof');
  // The API currently serializes event time to whole seconds. Compare against the release
  // lower-bound rounded down to the same precision, while retaining the pre-release absence gate.
  assert.ok(
    eventAtMs >= Math.floor(releasedAtMs / 1_000) * 1_000,
    'attributed Pi marker event predates its release gate',
  );
  return {
    preReleaseAbsenceCheckedAt: absenceProof.checkedAt,
    releasedAt: markerRelease.releasedAt,
    eventAt: eventAtValue,
    eventTimeResolutionMs: 1_000,
    observedAfterRelease: true,
  };
}

function exactMarkerToolEvent(item, markerValue, agentInstanceId, contract = 'true') {
  if (item?.eventKind !== 'ToolExec' || item.attribution?.agentInstanceId !== agentInstanceId) return false;
  const executable = path.posix.basename(String(item.process?.exe || ''));
  const argvText = String(item.attributes?.argv || '').trim();
  const common = item.attributes?.exec_confirmed === true &&
    item.attributes?.argv_incomplete === false &&
    item.attributes?.argv_truncated === false &&
    ['kernel_fragments', 'proc_cmdline'].includes(String(item.attributes?.argv_source || ''));
  if (!common) return false;
  if (contract === 'pi-held-shell') {
    return executable === 'dash' &&
      argvText === '/bin/sh -c ' + PI_MARKER_HOLD_COMMAND + ' ' + markerValue &&
      Number(item.attributes?.observed_argc) === 4;
  }
  assert.equal(contract, 'true', 'marker ToolExec contract is unsupported');
  const argv = argvText.split(/\s+/u).filter(Boolean);
  return executable === 'true' &&
    argv.length === 2 &&
    path.posix.basename(argv[0]) === 'true' &&
    argv[1] === markerValue &&
    Number(item.attributes?.observed_argc) === 2;
}

async function waitForVisibleFilterCanaryEvent(
  context,
  collector,
  markerValue,
  containerId,
  expectedClassification,
) {
  const environment = collector.environment;
  return await eventually('visible shadow filter canary ' + markerValue, async () => {
    const result = await queryCollectorEvents(
      context,
      collector,
      environment + '/' + collector.phase + ' visible filter canary',
    );
    const item = result.items.find((candidate) =>
      eventContainsExactMarker(candidate, markerValue) &&
      candidate.attribution?.classification === expectedClassification,
    );
    if (!item) return undefined;
    assert.equal(item.eventKind, 'ToolExec', 'shadow filter canary did not route a ToolExec event');
    assert.equal(
      item.attribution?.classification,
      expectedClassification,
      'shadow filter canary classification differs from its environment contract',
    );
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
    return { item, query: result.e2eQueryProof };
  }, 90_000, 500);
}

async function proveFilterCanaryApiAbsence(context, collector, runRecord, rawWitness, afterHeartbeat, label) {
  const { apiBase, collectorId } = collector;
  const drained = await waitForNextHeartbeat(
    apiBase,
    collectorId,
    afterHeartbeat,
    label + ' post-filter drain heartbeat',
    (item) => !matchingFilterReceipt(item, runRecord, rawWitness),
  );
  const first = await queryCollectorEvents(context, collector, label + ' first absence read');
  assert.equal(
    first.items.some((item) => eventContainsExactMarker(item, runRecord.marker)),
    false,
    label + ' unexpectedly reached L1',
  );
  const stable = await waitForNextHeartbeat(
    apiBase,
    collectorId,
    drained,
    label + ' stable API absence heartbeat',
    (item) => !matchingFilterReceipt(item, runRecord, rawWitness),
  );
  const second = await queryCollectorEvents(context, collector, label + ' second absence read');
  assert.equal(
    second.items.some((item) => eventContainsExactMarker(item, runRecord.marker)),
    false,
    label + ' appeared after the drain interval',
  );
  return {
    heartbeat: stable,
    eventQueries: [first.e2eQueryProof, second.e2eQueryProof],
  };
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
  const beforeRaw = execEvidenceQuality(previous);
  const afterRaw = execEvidenceQuality(current);
  const beforeRawAt = Date.parse(beforeRaw.lastReportedAt || '');
  const afterRawAt = Date.parse(afterRaw.lastReportedAt || '');
  return previous?.filterMetricsReported === true &&
    current?.filterMetricsReported === true &&
    previous?.filterMetrics?.shutdownFinal !== true &&
    current?.filterMetrics?.shutdownFinal === true &&
    Number.isFinite(beforePosts) && Number.isFinite(afterPosts) &&
    afterPosts > beforePosts &&
    Number.isSafeInteger(beforeEpoch) && beforeEpoch > 0 && afterEpoch === beforeEpoch &&
    Number.isFinite(beforeSnapshotAt) && Number.isFinite(afterSnapshotAt) &&
    afterSnapshotAt > beforeSnapshotAt &&
    beforeRaw.reported && beforeRaw.latest?.shutdownFinal === false &&
    afterRaw.reported && afterRaw.latest?.shutdownFinal === true &&
    afterRaw.window.shutdownFinalCount > beforeRaw.window.shutdownFinalCount &&
    afterRaw.window.heartbeatCount > beforeRaw.window.heartbeatCount &&
    afterRaw.window.intervalSecs > beforeRaw.window.intervalSecs &&
    Number.isFinite(beforeRawAt) && Number.isFinite(afterRawAt) && afterRawAt >= beforeRawAt &&
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

function runtimeSignatureMetric(metrics, name) {
  const value = metrics?.[name];
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    'runtime signature heartbeat metric ' + name + ' is missing or invalid',
  );
  return value;
}

function assertRuntimeSignatureStartupHeartbeat(item, config, label) {
  assert.equal(item?.filterMetricsReported, true, label + ' has no enriched heartbeat metrics');
  const metrics = item.filterMetrics;
  const expected = config.documents.version1;
  assert.equal(metrics.runtimeSignatureVersion, expected.version, label + ' did not start from signature v1');
  assert.equal(metrics.runtimeSignatureHash, expected.documentSha256, label + ' started with the wrong signature document');
  assert.equal(metrics.runtimeSignatureMatcherHash, expected.matcherSha256, label + ' started with the wrong matcher set');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureLoaded'), expected.runtimeCount, label + ' did not load every builtin runtime');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureInvalid'), 0, label + ' rejected its initial signature document');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureReloadErrors'), 0, label + ' reported a pre-update reload error');
  return {
    attempts: runtimeSignatureMetric(metrics, 'runtimeSignatureReloadAttempts'),
    successes: runtimeSignatureMetric(metrics, 'runtimeSignatureReloadSuccesses'),
    reconcileRequested: runtimeSignatureMetric(metrics, 'runtimeReconcileRequested'),
    reconcileRuns: runtimeSignatureMetric(metrics, 'runtimeReconcileRuns'),
    reconcileErrors: runtimeSignatureMetric(metrics, 'runtimeReconcileErrors'),
  };
}

function runtimeSignatureReloadProof(before, after, config, label) {
  const baseline = assertRuntimeSignatureStartupHeartbeat(before, config, label);
  assert.equal(after?.filterMetricsReported, true, label + ' has no post-update enriched heartbeat');
  const metrics = after.filterMetrics;
  const expected = config.documents.version2;
  const attempts = runtimeSignatureMetric(metrics, 'runtimeSignatureReloadAttempts');
  const successes = runtimeSignatureMetric(metrics, 'runtimeSignatureReloadSuccesses');
  assert.equal(metrics.runtimeSignatureVersion, expected.version, label + ' did not report signature v2');
  assert.equal(metrics.runtimeSignatureHash, expected.documentSha256, label + ' reported the wrong v2 document hash');
  assert.equal(metrics.runtimeSignatureMatcherHash, expected.matcherSha256, label + ' reported the wrong v2 registry matcher hash');
  assert.equal(metrics.runtimeSignatureLastGoodHash, expected.rawSha256, label + ' has no v2 last-good raw hash');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureLoaded'), expected.runtimeCount, label + ' lost builtin runtimes after reload');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureInvalid'), 0, label + ' rejected the v2 signature document');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureReloadErrors'), 0, label + ' reported a reload error');
  assert.ok(attempts > baseline.attempts, label + ' reload attempt counter did not advance');
  assert.ok(successes > baseline.successes, label + ' reload success counter did not advance');
  assert.ok(attempts >= successes, label + ' reload successes exceed attempts');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeReconcileErrors'), 0, label + ' reported a reconciliation error');
  assert.ok(
    runtimeSignatureMetric(metrics, 'runtimeReconcileRequested') > baseline.reconcileRequested,
    label + ' did not request reconciliation for the display-name update',
  );
  assert.ok(
    runtimeSignatureMetric(metrics, 'runtimeReconcileRuns') > baseline.reconcileRuns,
    label + ' did not complete reconciliation before Agent start',
  );
  assert.equal(
    config.documents.version1.matcherSha256,
    before.filterMetrics.runtimeSignatureMatcherHash,
    label + ' v1 matcher hash evidence is inconsistent',
  );
  assert.notEqual(
    config.documents.version1.matcherSha256,
    config.documents.version2.matcherSha256,
    label + ' observable v2 display-name update did not change the registry matcher hash',
  );
  assert.equal(
    config.documents.version1.matchPredicatesSha256,
    config.documents.version2.matchPredicatesSha256,
    label + ' changed runtime IDs, scopes, or match predicates',
  );
  return {
    exercised: true,
    scope: 'run-scoped',
    updateMechanism: config.kind === 'k8s-secret'
      ? 'mutable Kubernetes Secret directory projection'
      : 'atomic rename in a bind-mounted run-owned directory',
    before: {
      version: config.documents.version1.version,
      documentSha256: config.documents.version1.documentSha256,
      matcherSha256: config.documents.version1.matcherSha256,
      reloadAttempts: baseline.attempts,
      reloadSuccesses: baseline.successes,
      reconcileRequested: baseline.reconcileRequested,
      reconcileRuns: baseline.reconcileRuns,
    },
    after: {
      version: config.documents.version2.version,
      documentSha256: config.documents.version2.documentSha256,
      matcherSha256: config.documents.version2.matcherSha256,
      lastGoodRawSha256: config.documents.version2.rawSha256,
      reloadAttempts: attempts,
      reloadSuccesses: successes,
      reloadErrors: 0,
      reconcileErrors: 0,
      reconcileRequested: runtimeSignatureMetric(metrics, 'runtimeReconcileRequested'),
      reconcileRuns: runtimeSignatureMetric(metrics, 'runtimeReconcileRuns'),
    },
    builtinRuntimeCount: config.documents.version2.runtimeCount,
    runtimeIdsScopesAndMatchPredicatesPreserved: true,
    v2DisplayNamesChanged: true,
    completedBeforeAgentStart: true,
    observedAt: after.lastHeartbeatAt,
  };
}

function assertRuntimeSignatureV2Heartbeat(item, config, proof, label) {
  assert.equal(item?.filterMetricsReported, true, label + ' has no enriched heartbeat metrics');
  const metrics = item.filterMetrics;
  const expected = config.documents.version2;
  assert.equal(metrics.runtimeSignatureVersion, expected.version, label + ' regressed from signature v2');
  assert.equal(metrics.runtimeSignatureHash, expected.documentSha256, label + ' changed the v2 document hash');
  assert.equal(metrics.runtimeSignatureMatcherHash, expected.matcherSha256, label + ' changed the v2 matcher hash');
  assert.equal(metrics.runtimeSignatureLastGoodHash, expected.rawSha256, label + ' changed the last-good raw hash');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureLoaded'), expected.runtimeCount, label + ' lost builtin runtimes');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureInvalid'), 0, label + ' reported an invalid signature document');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeSignatureReloadErrors'), 0, label + ' reported a reload error');
  assert.equal(runtimeSignatureMetric(metrics, 'runtimeReconcileErrors'), 0, label + ' reported a reconciliation error');
  assert.ok(
    runtimeSignatureMetric(metrics, 'runtimeSignatureReloadSuccesses') >= proof.after.reloadSuccesses,
    label + ' reload success counter regressed',
  );
}

async function exerciseRuntimeSignatureReload(collector) {
  const config = collector.signatureReloadConfig;
  assert.ok(config, collector.environment + ' collector has no run-scoped signature configuration');
  const label = collector.environment + '/' + collector.phase + ' runtime signature reload';
  const before = await queryHeartbeat(collector.apiBase, collector.collectorId);
  assertRuntimeSignatureStartupHeartbeat(before, config, label);
  if (config.kind === 'k8s-secret') await updateK8sRuntimeSignatureSecret(config);
  else await atomicallyReplaceLocalRuntimeSignatures(config);
  return await eventually(label + ' heartbeat proof', async () => {
    const after = await queryHeartbeat(collector.apiBase, collector.collectorId);
    return runtimeSignatureReloadProof(before, after, config, label);
  }, config.kind === 'k8s-secret' ? 180_000 : 45_000, 500);
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

async function executeFilterCanaryScenario(context, collector, sampler) {
  const { environment, phase, apiBase, collectorId } = collector;
  const contract = filterCanaryContract(environment, phase);
  const before = await queryHeartbeat(apiBase, collectorId);
  let runRecord;
  if (environment === 'k8s') {
    runRecord = await startK8sFilterCanary(context.options, phase, context.k8sNode);
  } else if (environment === 'host') {
    runRecord = await startHostFilterCanary(context.options, phase);
  } else {
    runRecord = await startDockerFilterCanary(context.options, environment, phase);
  }
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
    } else if (environment === 'host') {
      placement = {
        unit: runRecord.systemd.unitName,
        invocationId: runRecord.systemd.ownership.invocationId,
        controlGroup: runRecord.systemd.ownership.controlGroup,
        detached: runRecord.systemd.detached.forbiddenSharedAncestorCount === 0,
      };
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
    const processCompletion = await waitForFilterCanaryProcess(runRecord);
    const rawWitness = await waitForFilterWitness(collector, runRecord);
    const metricName = contract.metricName;
    const correlated = await waitForCorrelatedFilterHeartbeat(
      apiBase,
      collectorId,
      sampler,
      armedHeartbeat,
      metricName,
      runRecord,
      rawWitness,
      environment + ' correlated filter counter ' + metricName,
    );
    const counterHeartbeat = correlated.heartbeat;
    const filterReceipt = correlated.receipt;
    assert.ok(filterReceipt, environment + ' filter heartbeat has no matching suppression receipt');
    let event;
    let eventQuery;
    if (phase === 'shadow') {
      if (contract.shadowVisible) {
        const visible = await waitForVisibleFilterCanaryEvent(
          context,
          collector,
          runRecord.marker,
          runRecord.containerId,
          contract.classification,
        );
        event = visible.item;
        eventQuery = visible.query;
      } else {
        const stable = await proveFilterCanaryApiAbsence(
          context,
          collector,
          runRecord,
          rawWitness,
          counterHeartbeat,
          environment + ' shadow non-Agent policy discard',
        );
        placement = {
          ...placement,
          apiAbsenceCheckedThrough: stable.heartbeat.lastHeartbeatAt,
          apiAbsenceEventQueries: stable.eventQueries,
        };
      }
    } else {
      const stable = await proveFilterCanaryApiAbsence(
        context,
        collector,
        runRecord,
        rawWitness,
        counterHeartbeat,
        environment + ' enforce filter canary',
      );
      placement = {
        ...placement,
        enforceAbsenceCheckedThrough: stable.heartbeat.lastHeartbeatAt,
        apiAbsenceEventQueries: stable.eventQueries,
      };
    }
    return {
      marker: runRecord.marker,
      classification: contract.classification,
      processExecuted: true,
      processCompletion,
      shadowVisible: Boolean(event),
      apiDisposition: phase === 'enforce'
        ? 'forwarder_filtered'
        : event
          ? 'retained'
          : 'non_agent_discarded',
      filterMetric: metricName,
      filterMetricValue: Number(counterHeartbeat.filterMetrics?.[metricName]) || 0,
      filterMetricEvidence: {
        source: 'run-scoped-enriched-heartbeat-history',
        heartbeatAt: counterHeartbeat.lastHeartbeatAt,
        examinedHeartbeatCount: correlated.examinedHeartbeatCount,
      },
      rawWitness: sanitized(rawWitness),
      filterReceipt: sanitized(filterReceipt),
      placement: sanitized(placement),
      event: event ? minimalEvent(event) : undefined,
      eventQuery,
    };
  } finally {
    if (environment === 'k8s') {
      if (ledger.k8sPods.get(runRecord.namespace)?.has(runRecord.name)) {
        await deleteOwnedK8s('pod', runRecord.namespace, runRecord.name, ledger.k8sPods);
      }
      if (ledger.k8sSecrets.get(runRecord.namespace)?.has(runRecord.secretName)) {
        await deleteOwnedK8s('secret', runRecord.namespace, runRecord.secretName, ledger.k8sSecrets);
      }
    } else if (environment === 'host') {
      if (ledger.systemdUnits.has(runRecord.name)) {
        await stopTrackedSystemdUnit(runRecord.name, true);
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

async function assertApiIsolation(context, collector) {
  const evidence = [];
  for (const plane of context.apiPlanes) {
    if (plane.name === collector.environment || !plane.available) continue;
    const runtime = await queryRuntime(plane.baseUrl, { collectorId: collector.collectorId });
    const heartbeat = await queryHeartbeat(plane.baseUrl, collector.collectorId);
    const events = await queryCollectorEvents(
      context,
      collector,
      collector.collectorId + ' isolation from ' + plane.name,
      plane,
    );
    assert.equal(runtime.total, 0, collector.collectorId + ' leaked into ' + plane.name + ' runtime API');
    assert.equal(heartbeat, undefined, collector.collectorId + ' leaked into ' + plane.name + ' collector API');
    assert.equal(events.total, 0, collector.collectorId + ' marker leaked into ' + plane.name + ' event API');
    evidence.push({
      plane: plane.name,
      runtimeInstances: runtime.total,
      collectorHeartbeat: false,
      markerEvents: events.total,
      eventQuery: events.e2eQueryProof,
    });
  }
  return evidence;
}

function expectedScopeForAgent(agent) {
  if (agent === 'host-codex') return 'codex';
  if (agent === 'host-kimi') return 'kimi-cli';
  return 'pi';
}

function proveReloadedSignatureInstanceRecognition(config, scenarios, environment) {
  return scenarios.map((scenario) => {
    const runtimeId = expectedScopeForAgent(scenario.agent);
    const expected = config.documents.version2.document.runtimes.find(
      (runtime) => runtime.id === runtimeId,
    );
    assert.ok(expected, 'signature v2 has no runtime for ' + scenario.agent);
    assert.equal(
      scenario.running?.agentScopeId,
      expected.agentScopeId,
      environment + ' running instance did not retain the v2 runtime scope for ' + scenario.agent,
    );
    assert.equal(
      scenario.running?.agentDisplayName,
      expected.displayName,
      environment + ' running instance did not use the hot-reloaded v2 display name for ' + scenario.agent,
    );
    assert.equal(
      scenario.terminal?.agentDisplayName,
      expected.displayName,
      environment + ' terminal instance did not retain the hot-reloaded v2 display name for ' + scenario.agent,
    );
    assert.ok(
      typeof scenario.running?.agentInstanceId === 'string' && scenario.running.agentInstanceId.length > 0,
      environment + ' has no instance ID for the v2 runtime signature proof',
    );
    return {
      agent: scenario.agent,
      runtimeId,
      agentScopeId: expected.agentScopeId,
      agentDisplayName: expected.displayName,
      agentInstanceId: scenario.running.agentInstanceId,
    };
  });
}

function hostAuxiliaryCandidateMatchesScenario(candidate, scenario) {
  const primaryStart = Number(scenario?.running?.discoveredAt);
  const primaryEnd = Number(
    scenario?.terminal?.endedAt ?? scenario?.terminal?.lastSeenAt ?? scenario?.running?.lastSeenAt,
  );
  const candidateStart = Number(candidate?.discoveredAt);
  const candidateEnd = Number(candidate?.endedAt ?? candidate?.lastSeenAt);
  return runtimeIdentityIsComplete(candidate) &&
    /^ari_[a-f0-9]{24}$/u.test(String(candidate.agentInstanceId || '')) &&
    ['exited', 'lost'].includes(candidate.runtimeState) &&
    candidate.agentInstanceId !== scenario?.running?.agentInstanceId &&
    candidate.agentScopeId === scenario?.running?.agentScopeId &&
    candidate.agentDisplayName === scenario?.running?.agentDisplayName &&
    candidate.classification === scenario?.running?.classification &&
    candidate.hostId === scenario?.running?.hostId &&
    candidate.bootId === scenario?.running?.bootId &&
    Number.isFinite(primaryStart) && Number.isFinite(primaryEnd) &&
    Number.isFinite(candidateStart) && Number.isFinite(candidateEnd) &&
    candidateEnd >= candidateStart &&
    candidateStart >= primaryStart - 5_000 &&
    candidateStart <= primaryEnd + 15_000 &&
    candidateEnd <= primaryEnd + 15_000;
}

function proveHostOwnedAuxiliaryRuntime(collector, candidate, scenarios) {
  if (candidate?.collectorId !== collector) return undefined;
  for (const scenario of scenarios) {
    if (!hostAuxiliaryCandidateMatchesScenario(candidate, scenario)) continue;
    const cgroupId = String(scenario.proof?.launcher?.runtimePlacement?.cgroupId || '');
    if (!/^\d+$/u.test(cgroupId) || String(scenario.markerEvent?.process?.cgroupId || '') !== cgroupId) {
      continue;
    }
    const placement = scenario.runtimeOwnership?.find((item) =>
      item.agentInstanceId === candidate.agentInstanceId &&
      item.agentScopeId === candidate.agentScopeId &&
      item.agentDisplayName === candidate.agentDisplayName &&
      item.classification === candidate.classification &&
      item.rootPid === candidate.rootPid &&
      String(item.rootStartTimeTicks) === String(candidate.rootStartTimeTicks) &&
      item.hostId === candidate.hostId &&
      item.bootId === candidate.bootId &&
      item.cgroupId === cgroupId &&
      item.unit === scenario.proof?.launcher?.unit &&
      item.invocationId === scenario.proof?.launcher?.invocationId &&
      item.launcherPid === scenario.proof?.launcher?.detached?.execMainPid &&
      item.launcherStartTimeTicks === scenario.proof?.launcher?.detached?.execMainStartTimeTicks,
    );
    if (!placement) continue;
    return {
      runtime: minimalRuntime(candidate),
      ownership: {
        relation: 'live_root_in_same_run_owned_systemd_cgroup',
        primaryAgentInstanceId: scenario.running.agentInstanceId,
        cgroupId,
        observedAt: placement.observedAt,
      },
    };
  }
  return undefined;
}

async function partitionNovelRuntimeRoots(collector, scenarioResults, runtimeItems) {
  const expectedIds = new Set(scenarioResults.map((result) => result.running.agentInstanceId));
  const novel = runtimeItems.filter((item) =>
    !collector.bootstrapInstanceIds.has(item.agentInstanceId) &&
    !expectedIds.has(item.agentInstanceId),
  );
  if (collector.environment !== 'host') return { ownedAuxiliary: [], unexpected: novel };
  const ownedAuxiliary = [];
  const unexpected = [];
  for (const candidate of novel) {
    const proof = proveHostOwnedAuxiliaryRuntime(
      collector.collectorId,
      candidate,
      scenarioResults,
    );
    if (proof) ownedAuxiliary.push(proof);
    else unexpected.push(candidate);
  }
  return { ownedAuxiliary, unexpected };
}

async function executeHostAgentScenario(context, collector, agent) {
  const { environment, phase, apiBase, collectorId: id } = collector;
  assert.equal(environment, 'host', 'host scenario received the wrong collector environment');
  const markerValue = marker(context.options, environment, phase, agent);
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  assertCompleteRuntimeInventory(baseline, environment + '/' + phase + ' Agent baseline');
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  let runRecord;
  let ownershipSampler;
  let runtimeOwnership;
  try {
    runRecord = await launchHostAgent(context.options, phase, agent, markerValue);
    ownershipSampler = startHostRuntimeOwnershipSampler(apiBase, id, baselineIds, runRecord);
    const running = await waitForNewRunningInstance(
      apiBase,
      id,
      baselineIds,
      expectedScopeForAgent(agent),
      async (candidate) => {
        ownershipSampler.assertHealthy();
        const placement = await matchHostRuntimeToSystemdService(candidate, runRecord);
        if (placement) {
          runRecord.runtimePlacement = placement;
          ownershipSampler.remember(candidate, placement);
        }
        return Boolean(placement);
      },
    );
    const proof = await finishHostAgent(runRecord);
    runtimeOwnership = await ownershipSampler.stop();
    ownershipSampler = undefined;
    assert.ok(
      runtimeOwnership.some((item) => item.agentInstanceId === running.agentInstanceId),
      environment + ' primary Agent was not retained in the live cgroup ownership sample',
    );
    const markerEventProof = await waitForMarkerEvent(
      context,
      collector,
      markerValue,
      running.agentInstanceId,
    );
    const event = markerEventProof.item;
    assert.match(
      String(runRecord.runtimePlacement?.cgroupId || ''),
      /^\d+$/u,
      environment + ' Agent has no pinned run-owned cgroup ID',
    );
    assert.equal(
      String(event.process?.cgroupId || ''),
      runRecord.runtimePlacement.cgroupId,
      environment + ' marker event escaped the pinned run-owned systemd cgroup',
    );
    const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
    validateLifecycleIdentity(running, terminal, environment);
    const isolation = await assertApiIsolation(context, collector);
    return {
      agent,
      marker: markerValue,
      proof,
      running: minimalRuntime(running),
      terminal: minimalRuntime(terminal),
      markerEvent: minimalEvent(event),
      markerEventQuery: markerEventProof.query,
      runtimeOwnership,
      isolation,
    };
  } catch (error) {
    if (!(error instanceof Error)) error = new Error(String(error));
    if (ownershipSampler) {
      try {
        runtimeOwnership = await ownershipSampler.stop();
      } catch (samplingError) {
        error.message += '; host runtime ownership sampler failed: ' + redact(samplingError.message);
      }
      ownershipSampler = undefined;
    }
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

async function executeDockerPiScenario(context, collector) {
  const { environment, phase, apiBase, collectorId: id } = collector;
  assert.equal(environment, 'docker', 'Docker scenario received the wrong collector environment');
  const markerValue = marker(context.options, environment, phase, 'pi');
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  assertCompleteRuntimeInventory(baseline, environment + '/' + phase + ' Agent baseline');
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  const runRecord = await startDockerPi(context.options, phase, markerValue);
  const running = await waitForNewRunningInstance(apiBase, id, baselineIds, 'pi');
  const markerGateClosedBeforeRelease = await assertPiMarkerReleaseStillClosed(runRecord);
  const markerNegativeCheckBeforeRelease = await preReleaseMarkerNegativeCheck(
    apiBase,
    id,
    markerValue,
    collector.eventQueryStartTime,
  );
  const markerRelease = await releasePiMarker(runRecord);
  const proof = await dockerPiProof(context.options, runRecord);
  const markerEventProof = await waitForMarkerEvent(
    context,
    collector,
    markerValue,
    running.agentInstanceId,
    'pi-held-shell',
  );
  const event = markerEventProof.item;
  const markerReleaseOrder = proveMarkerEventAfterRelease(
    event,
    markerNegativeCheckBeforeRelease,
    markerRelease,
  );
  await stopOwnedDockerContainer(runRecord.name, true);
  const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
  validateLifecycleIdentity(running, terminal, environment);
  const isolation = await assertApiIsolation(context, collector);
  return {
    agent: 'docker-pi',
    marker: markerValue,
    agentImageProof: runRecord.agentImageProof,
    markerGateClosedBeforeRelease,
    markerNegativeCheckBeforeRelease,
    markerRelease,
    markerReleaseOrder,
    proof,
    running: minimalRuntime(running),
    terminal: minimalRuntime(terminal),
    markerEvent: minimalEvent(event),
    markerEventQuery: markerEventProof.query,
    isolation,
  };
}

async function executeK8sPiScenario(context, collector) {
  const { environment, phase, apiBase, collectorId: id } = collector;
  assert.equal(environment, 'k8s', 'Kubernetes scenario received the wrong collector environment');
  const markerValue = marker(context.options, environment, phase, 'pi');
  const baseline = await queryRuntime(apiBase, { collectorId: id });
  assertCompleteRuntimeInventory(baseline, environment + '/' + phase + ' Agent baseline');
  const baselineIds = new Set(baseline.items.map((item) => item.agentInstanceId));
  const runRecord = await startK8sPi(
    context.options,
    phase,
    context.k8sNode,
    context.k8sSecret,
    markerValue,
  );
  const running = await waitForNewRunningInstance(apiBase, id, baselineIds, 'pi');
  const markerGateClosedBeforeRelease = await assertPiMarkerReleaseStillClosed(runRecord);
  const markerNegativeCheckBeforeRelease = await preReleaseMarkerNegativeCheck(
    apiBase,
    id,
    markerValue,
    collector.eventQueryStartTime,
  );
  const markerRelease = await releasePiMarker(runRecord);
  const proof = await k8sPiProof(context.options, runRecord);
  const markerEventProof = await waitForMarkerEvent(
    context,
    collector,
    markerValue,
    running.agentInstanceId,
    'pi-held-shell',
  );
  const event = markerEventProof.item;
  const markerReleaseOrder = proveMarkerEventAfterRelease(
    event,
    markerNegativeCheckBeforeRelease,
    markerRelease,
  );
  await deleteOwnedK8s('pod', runRecord.namespace, runRecord.name, ledger.k8sPods);
  await deleteOwnedK8s('secret', runRecord.namespace, runRecord.markerSecretName, ledger.k8sSecrets);
  const terminal = await waitForTerminalInstance(apiBase, id, running.agentInstanceId);
  validateLifecycleIdentity(running, terminal, environment);
  const isolation = await assertApiIsolation(context, collector);
  return {
    agent: 'k8s-pi',
    marker: markerValue,
    agentImageProof: runRecord.agentImageProof,
    markerGateClosedBeforeRelease,
    markerNegativeCheckBeforeRelease,
    markerRelease,
    markerReleaseOrder,
    proof,
    running: minimalRuntime(running),
    terminal: minimalRuntime(terminal),
    markerEvent: minimalEvent(event),
    markerEventQuery: markerEventProof.query,
    isolation,
  };
}

async function stopPhaseCollector(collector, requireTracked = false) {
  let stopped = false;
  if (collector.environment === 'host' || collector.environment === 'docker') {
    if (ledger.dockerContainers.has(collector.name)) {
      const ownership = ledger.dockerContainers.get(collector.name);
      const state = await dockerResourceState(
        ownership.id || collector.name, ledger.runId, ownership,
      );
      if (!state.exists) {
        // Creation may have failed after reserving the ledger entry but before Docker returned an
        // ID. Absence is safe to forget; a replacement with changed identity is still refused.
        ledger.dockerContainers.delete(collector.name);
      } else if (collector.shutdownRequested && await waitForOwnedDockerContainerStopped(collector.name)) {
        await removeTrackedDockerContainer(collector.name, true);
      } else {
        await stopOwnedDockerContainer(collector.name, true, COLLECTOR_OUTER_GRACE_SECONDS);
      }
      stopped = true;
    }
  } else if (ledger.k8sPods.get(collector.namespace)?.has(collector.name)) {
    const ownership = ledger.k8sPods.get(collector.namespace).get(collector.name);
    const state = await k8sResourceState(
      'pod', collector.namespace, collector.name, ledger.runId, ownership,
    );
    if (!state.exists) {
      forgetK8s(ledger.k8sPods, collector.namespace, collector.name);
    } else if (collector.shutdownRequested) {
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

async function finalizeCollectorPhase(
  context,
  collector,
  sampler,
  scenarioResults,
  filterCanary,
  runtimeSignatureReload,
) {
  await delay(2_500);
  const beforeStop = await queryHeartbeat(collector.apiBase, collector.collectorId);
  assert.ok(beforeStop?.lastHeartbeatAt, collector.environment + ' collector has no heartbeat before shutdown');
  assert.notEqual(
    beforeStop.filterMetrics?.shutdownFinal,
    true,
    collector.environment + ' collector reported a final heartbeat before shutdown',
  );
  const beforeRawEvidence = execEvidenceQuality(beforeStop);
  assert.equal(
    beforeRawEvidence.reported,
    true,
    collector.environment + ' collector has no complete raw heartbeat evidence before shutdown',
  );
  assert.equal(
    beforeRawEvidence.latest?.shutdownFinal,
    false,
    collector.environment + ' collector reported raw shutdown-final evidence before shutdown',
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
  if (runtimeSignatureReload) {
    assertRuntimeSignatureV2Heartbeat(
      finalHeartbeat,
      collector.signatureReloadConfig,
      runtimeSignatureReload,
      collector.environment + '/' + collector.phase + ' final runtime signature heartbeat',
    );
  }
  await stopPhaseCollector(collector, true);
  const samples = await sampler.stop();
  const metrics = aggregateHeartbeatSamples(samples, finalHeartbeat);
  // Preserve the fully aggregated Collector evidence even when an acceptance assertion below
  // fails, so the failure report retains the operational and evidence-quality root cause.
  collector.finalMetrics = metrics;
  assertPhaseMetrics(collector.phase, metrics, collector.environment);
  const events = await queryCollectorEvents(
    context,
    collector,
    collector.environment + '/' + collector.phase + ' final collector events',
  );
  const runtime = await queryRuntime(collector.apiBase, { collectorId: collector.collectorId });
  assertCompleteRuntimeInventory(runtime, collector.environment + '/' + collector.phase + ' final');
  const { ownedAuxiliary, unexpected } = await partitionNovelRuntimeRoots(
    collector,
    scenarioResults,
    runtime.items,
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
    runtimeSignatureReload,
    eventIngestScope: collector.eventIngestScope,
    metrics,
    l1: {
      routedEvents: events.total,
      sampledEvents: events.items.length,
      classifications,
      eventQuery: events.e2eQueryProof,
    },
    runtime: {
      total: runtime.total,
      summary: runtime.summary,
      ownedAuxiliary,
      unexpected: unexpected.map(minimalRuntime),
    },
  };
}

async function captureIncompletePhaseMetrics(collector, sampler) {
  const samples = typeof sampler?.snapshot === 'function' ? sampler.snapshot() : [];
  if (!collector) return { metrics: undefined, current: undefined, queryError: undefined };
  let current;
  let queryError;
  try {
    current = await queryHeartbeat(collector.apiBase, collector.collectorId);
  } catch (error) {
    queryError = error;
  }
  return {
    metrics: current || samples.length ? aggregateHeartbeatSamples(samples, current ?? samples.at(-1)) : undefined,
    current,
    queryError,
  };
}

async function captureCollectorLogDiagnostic(collector) {
  if (!collector?.name) return undefined;
  try {
    const result = collector.environment === 'k8s'
      ? await run('kubectl', [
        '-n', collector.namespace, 'logs', collector.name, '-c', 'collector',
      ], { allowFailure: true, timeoutMs: 15_000 })
      : await run('docker', ['logs', collector.name], { allowFailure: true, timeoutMs: 15_000 });
    const bounded = boundedRedactedText(result.stdout + result.stderr, DIAGNOSTIC_TEXT_LIMIT);
    return {
      exitCode: result.code,
      bytes: bounded.capturedBytes,
      truncated: bounded.truncated,
      sha256: bounded.sha256,
      tail: bounded.tail,
    };
  } catch (error) {
    return {
      captureError: boundedRedactedText(
        error instanceof Error ? error.message : String(error),
        1_024,
      ).tail,
    };
  }
}

async function executeEnvironmentPhase(context, environment, phase) {
  const apiBase = environment === 'host'
    ? context.options.hostApiBase
    : environment === 'docker'
      ? context.options.dockerApiBase
      : context.options.k8sApiBase;
  let collector = {
    name: k8sName(context.options, 'collector', environment, phase),
    collectorId: collectorId(context.options, environment, phase),
    environment,
    phase,
    apiBase,
    eventQueryStartTime: new Date(Date.now() - E2E_EVENT_QUERY_START_SKEW_MS).toISOString(),
    ...(environment === 'k8s' ? { namespace: context.options.k8sWorkloadNamespace } : {}),
  };
  let sampler;
  const scenarios = [];
  let filterCanary;
  let runtimeSignatureReload;
  let primaryError;
  let stage = 'collector-history-recheck';
  try {
    await assertCollectorHistoryAbsentBeforeStart(
      collector.apiBase, collector.collectorId, environment, phase,
    );
    // Start sampling before the resource mutation/readiness loop. Interval counters such as
    // queueDropped reset on each enriched heartbeat and must not disappear before bootstrap ends.
    sampler = startHeartbeatSampler(collector.apiBase, collector.collectorId);
    stage = 'collector-start';
    const started = environment === 'host'
      ? await startDockerCollector(context.options, environment, phase, context.options.hostApiBase)
      : environment === 'docker'
        ? await startDockerCollector(context.options, environment, phase, context.options.dockerApiBase)
        : await startK8sCollector(context.options, phase, context.k8sNode);
    collector = { ...collector, ...started };
    if (context.options.exerciseSignatureReload) {
      stage = 'runtime-signature-reload';
      runtimeSignatureReload = await exerciseRuntimeSignatureReload(collector);
    }
    stage = 'runtime-bootstrap';
    const bootstrap = await queryRuntime(collector.apiBase, { collectorId: collector.collectorId });
    assertCompleteRuntimeInventory(bootstrap, environment + '/' + phase + ' bootstrap');
    collector.bootstrapInstanceIds = new Set(bootstrap.items.map((item) => item.agentInstanceId));
    stage = 'filter-canary';
    filterCanary = await executeFilterCanaryScenario(context, collector, sampler);
    stage = 'agent-scenarios';
    if (environment === 'host') {
      for (const agent of context.options.agents.filter((name) => name.startsWith('host-'))) {
        scenarios.push(await executeHostAgentScenario(context, collector, agent));
      }
    } else if (environment === 'docker') {
      scenarios.push(await executeDockerPiScenario(context, collector));
    } else {
      scenarios.push(await executeK8sPiScenario(context, collector));
    }
    if (runtimeSignatureReload) {
      runtimeSignatureReload = {
        ...runtimeSignatureReload,
        recognizedInstances: proveReloadedSignatureInstanceRecognition(
          collector.signatureReloadConfig,
          scenarios,
          environment,
        ),
      };
    }
    stage = 'collector-finalize';
    return await finalizeCollectorPhase(
      context,
      collector,
      sampler,
      scenarios,
      filterCanary,
      runtimeSignatureReload,
    );
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
    const [diagnostic, collectorLogs] = await Promise.all([
      captureIncompletePhaseMetrics(collector, sampler),
      captureCollectorLogDiagnostic(collector),
    ]);
    collector.finalMetrics ??= diagnostic.metrics;
    primaryError.incompletePhase = diagnosticSanitized({
      environment,
      phase,
      stage,
      collectorId: collector.collectorId,
      eventIngestScope: collector.eventIngestScope,
      scenarios,
      filterCanary,
      runtimeSignatureReload,
      ...(primaryError.piRuntimeDiagnostic
        ? { piRuntimeDiagnostic: primaryError.piRuntimeDiagnostic }
        : {}),
      metrics: collector.finalMetrics,
      collectorLogs,
      ...(diagnostic.queryError ? {
        metricsCaptureError: diagnostic.queryError instanceof Error
          ? diagnostic.queryError.message
          : String(diagnostic.queryError),
      } : {}),
    });
    throw primaryError;
  } finally {
    const cleanupFailures = [];
    const stopSampler = async () => {
      if (!sampler) return;
      try {
        await sampler.stop();
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    const stopCollector = async () => {
      try {
        await stopPhaseCollector(collector);
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    const removeRuntimeSignatureResource = async () => {
      const config = collector.signatureReloadConfig;
      if (config?.kind !== 'k8s-secret') return;
      if (!ledger.k8sSecrets.get(config.namespace)?.has(config.name)) return;
      try {
        await deleteOwnedK8s('secret', config.namespace, config.name, ledger.k8sSecrets);
      } catch (error) {
        cleanupFailures.push(error);
      }
    };
    if (primaryError) {
      // Preserve terminal raw/enriched evidence by sampling throughout graceful shutdown.
      await stopCollector();
      await stopSampler();
      await removeRuntimeSignatureResource();
    } else {
      await stopSampler();
      await stopCollector();
      await removeRuntimeSignatureResource();
    }
    const finalDiagnostic = await captureIncompletePhaseMetrics(collector, sampler);
    if (primaryError && finalDiagnostic.current && finalDiagnostic.metrics) {
      // The post-cleanup snapshot contains terminal raw/enriched evidence that may not have
      // existed when the primary failure was first caught. Keep the primary error, but prefer
      // the later diagnostic metrics in the failure artifact.
      collector.finalMetrics = finalDiagnostic.metrics;
    } else {
      collector.finalMetrics ??= finalDiagnostic.metrics;
    }
    if (primaryError?.incompletePhase) {
      primaryError.incompletePhase.metrics = diagnosticSanitized(collector.finalMetrics);
      if (finalDiagnostic.queryError) {
        primaryError.incompletePhase.metricsCaptureError = redact(
          finalDiagnostic.queryError instanceof Error
            ? finalDiagnostic.queryError.message
            : String(finalDiagnostic.queryError),
        );
      }
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
        cleanupError.incompletePhase = diagnosticSanitized({
          environment,
          phase,
          stage,
          collectorId: collector.collectorId,
          eventIngestScope: collector.eventIngestScope,
          scenarios,
          filterCanary,
          runtimeSignatureReload,
          metrics: collector.finalMetrics,
        });
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
      actualDrops: phase.metrics.totals.filteredNonAgent + phase.metrics.totals.filteredUnknown + phase.metrics.totals.filteredNoise +
        phase.metrics.totals.discoveryBudgetDropped,
      wouldDrop: phase.metrics.totals.wouldFilterNonAgent + phase.metrics.totals.wouldFilterUnknown + phase.metrics.totals.wouldFilterNoise +
        phase.metrics.totals.wouldDiscoveryBudgetDrop,
      unexpectedAgentInstances: phase.runtime.unexpected.length,
      filterCanary: phase.filterCanary ? {
        processExecuted: phase.filterCanary.processExecuted,
        shadowVisible: phase.filterCanary.shadowVisible,
        apiDisposition: phase.filterCanary.apiDisposition,
        metric: phase.filterCanary.filterMetric,
        metricValue: phase.filterCanary.filterMetricValue,
        rawWitnessDigest: phase.filterCanary.rawWitness?.lineSha256,
      } : undefined,
      runtimeSignatureReload: phase.runtimeSignatureReload ? {
        exercised: phase.runtimeSignatureReload.exercised,
        beforeVersion: phase.runtimeSignatureReload.before.version,
        afterVersion: phase.runtimeSignatureReload.after.version,
        matchPredicatesPreserved:
          phase.runtimeSignatureReload.runtimeIdsScopesAndMatchPredicatesPreserved,
        reloadSuccesses: phase.runtimeSignatureReload.after.reloadSuccesses,
        reloadErrors: phase.runtimeSignatureReload.after.reloadErrors,
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
    if (options.exerciseSignatureReload) {
      assert.equal(
        result.runtimeSignatureReload?.exercised,
        true,
        result.environment + ' shadow did not complete the run-scoped runtime signature reload',
      );
      assert.equal(
        result.runtimeSignatureReload?.completedBeforeAgentStart,
        true,
        result.environment + ' shadow reloaded runtime signatures after Agent start',
      );
      assert.equal(
        result.runtimeSignatureReload?.runtimeIdsScopesAndMatchPredicatesPreserved,
        true,
        result.environment + ' shadow changed runtime signature IDs, scopes, or match predicates',
      );
      assert.equal(
        result.runtimeSignatureReload?.recognizedInstances?.length,
        result.scenarios.length,
        result.environment + ' shadow did not recognize every Agent instance with v2 display names',
      );
    }
    const filterContract = filterCanaryContract(result.environment, 'shadow');
    assert.equal(result.filterCanary?.processExecuted, true, result.environment + ' shadow filter canary did not execute');
    assert.equal(
      result.filterCanary?.shadowVisible,
      filterContract.shadowVisible,
      result.environment + ' shadow filter canary visibility differs from the API policy contract',
    );
    assert.equal(
      result.filterCanary?.apiDisposition,
      filterContract.shadowApiDisposition,
      result.environment + ' shadow filter canary disposition differs from the API policy contract',
    );
    assert.equal(result.filterCanary?.classification, filterContract.classification);
    assert.equal(result.filterCanary?.filterMetric, filterContract.metricName);
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
      runtimeSignatureReloadVersion: result.runtimeSignatureReload?.after.version,
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
      ...(options.exerciseSignatureReload
        ? ['run-scoped runtime signature v1 -> v2 reload completed before Agent start']
        : []),
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
  const needsAuthorizedLlmCredential = needsPiCredential || options.agents.includes('host-kimi');
  if (needsAuthorizedLlmCredential) {
    assert.ok(preflightResult.apiState.keyFile, 'DeepSeek key file fingerprint is unavailable');
    const piModelsFile = options.modelsFile
      ? await stagePiModelsFile(options, preflightResult.apiState.piModelsFile)
      : undefined;
    const keyFile = await stageCredentialFile(options, preflightResult.apiState.keyFile);
    if (piModelsFile) await assertModelsExcludeCredential(piModelsFile, keyFile);
    const piModelDescriptor = preflightResult.apiState.piModelsFile?.model;
    let kimiConfig;
    if (options.agents.includes('host-kimi')) {
      assert.ok(piModelsFile && piModelDescriptor, 'host-kimi requires a validated staged models file');
      registerRuntimeEvidenceRedactionLiteral(piModelDescriptor.baseUrl);
      registerRuntimeEvidenceRedactionLiteral(new URL(piModelDescriptor.baseUrl).origin);
      kimiConfig = await stageKimiConfigFile(
        piModelDescriptor,
        keyFile,
        preflightResult.apiState.keyFile,
      );
      registerRuntimeEvidenceRedactionLiteral(kimiConfig.path);
    }
    options = {
      ...options,
      keyFile,
      piModelsFile,
      piModelDescriptor,
      piModelsSha256: preflightResult.apiState.piModelsFile?.sha256,
      kimiConfig,
    };
  }
  options = {
    ...options,
    resolvedDockerImages: preflightResult.apiState.dockerImages,
    resolvedHostCommands: preflightResult.apiState.hostAgentCommands,
    resolvedHostKimiVersion: preflightResult.apiState.hostKimiVersion,
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
    {
      name: 'host',
      baseUrl: options.hostApiBase,
      storage: preflightResult.apiState.host?.storage,
      available: Boolean(
        preflightResult.apiState.host?.health && preflightResult.apiState.host?.runtime &&
        eventStorageContract(preflightResult.apiState.host?.storage, 'host') &&
        (preflightResult.apiState.host?.storage?.mode !== 'memory' ||
          memoryStorageIsAuditableBaseline(preflightResult.apiState.host.storage)),
      ),
    },
    {
      name: 'docker',
      baseUrl: options.dockerApiBase,
      storage: preflightResult.apiState.docker?.storage,
      available: Boolean(
        preflightResult.apiState.docker?.health && preflightResult.apiState.docker?.runtime &&
        eventStorageContract(preflightResult.apiState.docker?.storage, 'docker'),
      ),
    },
    {
      name: 'k8s',
      baseUrl: options.k8sApiBase,
      storage: preflightResult.apiState.k8s?.storage,
      available: Boolean(
        preflightResult.apiState.k8s?.health && preflightResult.apiState.k8s?.runtime &&
        eventStorageContract(preflightResult.apiState.k8s?.storage, 'k8s'),
      ),
    },
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
      exerciseSignatureReload: options.exerciseSignatureReload,
      eventIngestScope: {
        mode: 'collector-phase-tool-exec-marker-prefix',
        prefixDimensions: ['runId', 'environment', 'phase'],
        prefixSha256ReportedPerPhase: true,
        collectorHeartbeatsBypassScope: true,
        attributionAndRuntimeDiscoveryRunBeforeScope: true,
        testOnly: true,
        productionDefault: 'disabled-when-env-absent',
        markerPrefixReported: false,
      },
      eventEvidenceQueries: {
        timeWindow: 'fixed-phase-start-to-query-end-with-bounded-clock-skew',
        clickhousePlanes: 'collector-scoped-durable-plus-hot-ring-merge-without-fallback',
        hostMemoryPlane: 'explicit-hot-ring-fallback-with-boot-continuity-and-no-trim-proof',
        markerFiltering: 'client-side-exact-argv-token',
        serverTextSearchUsed: false,
        completeGlobalApiInventoryClaimed: false,
        completeFreshCollectorPageRequired: true,
      },
      pi: needsPiCredential ? {
        provider: options.piProvider,
        model: options.piModel,
        modelsFileReported: Boolean(options.piModelsFile),
        modelsFileSha256: options.piModelsSha256,
        transportSecurity: options.piModelDescriptor?.transportSecurity ?? 'built-in-provider',
        lifecycleProof: 'fresh-workload-round-1-runtime-visible-then-release-held-tool-result-and-successful-exit',
        retrySeconds: PI_RETRY_SECONDS,
        successfulExitWaitSeconds: PI_RUNTIME_EXIT_WAIT_MS / 1_000,
        markerHelperSourceSha256: options.piMarkerHelperSha256,
        markerHelperVerifiedBeforeAgentProcess: true,
        markerHelperRuntimeVerifiedPerScenario: true,
        markerHelperPathReported: false,
      } : undefined,
      hostKimi: options.agents.includes('host-kimi') ? {
        provider: options.piProvider,
        model: options.piModel,
        cliVersion: options.resolvedHostKimiVersion,
        configuration: 'run-owned-0600-openai-compatible',
        state: 'run-owned-0700',
        transportSecurity: options.piModelDescriptor?.transportSecurity,
      } : undefined,
    },
    apiPlanes: apiPlanes.map((plane) => ({
      name: plane.name,
      baseUrl: plane.baseUrl,
      available: plane.available,
      storage: storageCapabilitySummary(plane.storage, plane.name),
    })),
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
      const filterContract = filterCanaryContract(result.environment, 'enforce');
      assert.equal(result.filterCanary?.processExecuted, true, result.environment + ' enforce filter canary did not execute');
      assert.equal(result.filterCanary?.shadowVisible, false, result.environment + ' enforce filter canary reached L1');
      assert.equal(
        result.filterCanary?.apiDisposition,
        'forwarder_filtered',
        result.environment + ' enforce filter canary disposition is invalid',
      );
      assert.equal(result.filterCanary?.classification, filterContract.classification);
      assert.equal(result.filterCanary?.filterMetric, filterContract.metricName);
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
    report.comparison = phaseComparison(report.phaseResults);
    report.executionCompletedAt = new Date().toISOString();
    report.success = true;
    return { report, artifactDir: options.artifactDir };
  } catch (error) {
    report.comparison = phaseComparison(report.phaseResults);
    report.executionCompletedAt = new Date().toISOString();
    report.success = false;
    report.failure = {
      name: error instanceof Error ? error.name : 'Error',
      message: boundedRedactedText(error instanceof Error ? error.message : String(error), 4_096).tail,
      ...(error?.hostAgentDiagnostic ? { hostAgentDiagnostic: error.hostAgentDiagnostic } : {}),
      ...(error?.hostAgentDiagnosticError ? { hostAgentDiagnosticError: error.hostAgentDiagnosticError } : {}),
      ...(error?.piRuntimeDiagnostic
        ? { piRuntimeDiagnostic: diagnosticSanitized(error.piRuntimeDiagnostic) }
        : {}),
      ...(error?.phaseCleanupError ? { phaseCleanupError: error.phaseCleanupError } : {}),
    };
    if (error?.incompletePhase) report.incompletePhase = diagnosticSanitized(error.incompletePhase);
    if (error && typeof error === 'object') {
      error.e2eReport = report;
      error.e2eArtifactDir = options.artifactDir;
    }
    throw error;
  }
}

async function selfTestRuntimeSignatureReload() {
  const options = parseOptions([
    '--run-id', 'self-reload-001',
    '--agents', 'host-kimi,docker-pi,k8s-pi',
    '--exercise-signature-reload',
  ]);
  assert.equal(options.exerciseSignatureReload, true);
  const plan = executionPlan(options);
  assert.equal(plan.runtimeSignatureReload.enabled, true);
  assert.equal(plan.runtimeSignatureReload.runtimeIdsScopesAndMatchPredicatesChanged, false);
  assert.equal(plan.runtimeSignatureReload.displayNamesChanged, true);
  assert.equal(
    plan.resources.some((resource) =>
      resource.kind === 'Secret' && resource.name ===
        k8sName(options, 'runtime-signatures', 'k8s', 'shadow')),
    true,
  );
  const documents = runtimeSignatureReloadDocuments();
  const metrics = (document, values) => ({
    runtimeSignatureVersion: document.version,
    runtimeSignatureHash: document.documentSha256,
    runtimeSignatureMatcherHash: document.matcherSha256,
    runtimeSignatureLoaded: document.runtimeCount,
    runtimeSignatureInvalid: 0,
    runtimeSignatureReloadAttempts: values.attempts,
    runtimeSignatureReloadSuccesses: values.successes,
    runtimeSignatureReloadErrors: 0,
    runtimeSignatureLastGoodHash: values.lastGoodRawSha256,
    runtimeReconcileRequested: values.reconcileRequested,
    runtimeReconcileRuns: values.reconcileRuns,
    runtimeReconcileErrors: 0,
  });
  const before = {
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
    filterMetricsReported: true,
    filterMetrics: metrics(documents.version1, {
      attempts: 0,
      successes: 0,
      reconcileRequested: 0,
      reconcileRuns: 0,
    }),
  };
  const after = {
    lastHeartbeatAt: '2026-01-01T00:00:02.000Z',
    filterMetricsReported: true,
    filterMetrics: metrics(documents.version2, {
      attempts: 1,
      successes: 1,
      lastGoodRawSha256: documents.version2.rawSha256,
      reconcileRequested: 1,
      reconcileRuns: 1,
    }),
  };
  const proof = runtimeSignatureReloadProof(
    before,
    after,
    { kind: 'local-directory', documents },
    'self-test runtime signature reload',
  );
  assert.equal(proof.runtimeIdsScopesAndMatchPredicatesPreserved, true);
  assert.equal(proof.v2DisplayNamesChanged, true);
  assertRuntimeSignatureV2Heartbeat(
    after,
    { documents },
    proof,
    'self-test final runtime signature heartbeat',
  );
  const expectedPi = documents.version2.document.runtimes.find((runtime) => runtime.id === 'pi');
  assert.deepEqual(
    proveReloadedSignatureInstanceRecognition({ documents }, [{
      agent: 'docker-pi',
      running: {
        agentInstanceId: 'instance-v2',
        agentScopeId: expectedPi.agentScopeId,
        agentDisplayName: expectedPi.displayName,
      },
      terminal: { agentDisplayName: expectedPi.displayName },
    }], 'self-test'),
    [{
      agent: 'docker-pi',
      runtimeId: 'pi',
      agentScopeId: expectedPi.agentScopeId,
      agentDisplayName: expectedPi.displayName,
      agentInstanceId: 'instance-v2',
    }],
  );

  const previousRoot = ledger.tempRoot;
  const previousRootIdentity = ledger.tempRootIdentity;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-signature-reload-self-test-'));
  const rootIdentity = localPathIdentity(await fs.lstat(root));
  try {
    ledger.tempRoot = root;
    ledger.tempRootIdentity = rootIdentity;
    const config = await prepareLocalRuntimeSignatureReload(options, 'docker', 'shadow');
    assert.equal((await hashLocalFile(config.file)).sha256, documents.version1.rawSha256);
    await atomicallyReplaceLocalRuntimeSignatures(config);
    assert.equal((await hashLocalFile(config.file)).sha256, documents.version2.rawSha256);
  } finally {
    ledger.tempRoot = previousRoot;
    ledger.tempRootIdentity = previousRootIdentity;
    const state = await localPathState(root);
    if (state.exists && sameLocalPathIdentity(state.identity, rootIdentity)) {
      await fs.rm(root, { recursive: true });
    }
  }
}

async function selfTestKimiConfigStaging() {
  const previousRoot = ledger.tempRoot;
  const previousRootIdentity = ledger.tempRootIdentity;
  const previousCredential = ledger.tempCredential;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-kimi-config-self-test-'));
  const rootIdentity = localPathIdentity(await fs.lstat(root));
  let stagedContent;
  try {
    ledger.tempRoot = root;
    ledger.tempRootIdentity = rootIdentity;
    const credential = Buffer.from('opaque-self-test-credential');
    const credentialFile = path.join(root, 'credential');
    const credentialSha256 = createHash('sha256').update(credential).digest('hex');
    await fs.writeFile(credentialFile, credential, { mode: 0o600, flag: 'wx' });
    const credentialIdentity = await verifyRunOwnedFile(
      credentialFile,
      credential.length,
      credentialSha256,
      'self-test credential',
    );
    ledger.tempCredential = {
      path: credentialFile,
      identity: credentialIdentity,
      size: credential.length,
      sha256: credentialSha256,
    };
    credential.fill(0);
    const staged = await stageKimiConfigFile({
      providerId: 'self-test-provider',
      modelId: 'vendor/self-test-model',
      contextWindow: 16_384,
      maxTokens: 2_048,
      api: 'openai-completions',
      baseUrl: 'https://llm.invalid/v1',
      transportSecurity: 'tls',
    }, credentialFile, ledger.tempCredential);
    const verified = await readVerifiedRunOwnedFile(
      staged.path,
      staged.bytes,
      staged.sha256,
      staged.identity,
      'self-test Host Kimi config',
    );
    stagedContent = verified.content;
    const document = JSON.parse(stagedContent.toString('utf8'));
    assert.equal(document.providers[KIMI_CONFIG_PROVIDER_KEY].type, 'openai_legacy');
    assert.equal(document.providers[KIMI_CONFIG_PROVIDER_KEY].base_url, 'https://llm.invalid/v1');
    assert.equal(document.providers[KIMI_CONFIG_PROVIDER_KEY].api_key, 'opaque-self-test-credential');
    assert.equal(document.providers[KIMI_CONFIG_PROVIDER_KEY].reasoning_key, 'reasoning_content');
    assert.equal(document.models[KIMI_CONFIG_MODEL_KEY].model, 'vendor/self-test-model');
    assert.equal(document.telemetry, false);
    assert.equal(document.merge_all_available_skills, false);
  } finally {
    stagedContent?.fill(0);
    ledger.tempCredential = previousCredential;
    ledger.tempRoot = previousRoot;
    ledger.tempRootIdentity = previousRootIdentity;
    const rootState = await localPathState(root);
    if (rootState.exists && sameLocalPathIdentity(rootState.identity, rootIdentity)) {
      await fs.rm(root, { recursive: true });
    }
  }
}

async function selfTestAtomicRunOwnedPublication() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-atomic-publication-self-test-'));
  const rootIdentity = localPathIdentity(await fs.lstat(root));
  const content = Buffer.from('go\n');
  try {
    const published = await atomicallyPublishRunOwnedFile(
      root,
      rootIdentity,
      'go',
      content,
      'self-test atomic publication',
    );
    assert.equal(published.file, path.join(root, 'go'));
    assert.equal(published.sha256, hashText('go\n'));
    assert.equal((published.identity.mode & 0o777), 0o600);
    assert.deepEqual(await fs.readdir(root), ['go']);
    assert.equal(await fs.readFile(published.file, 'utf8'), 'go\n');
    await assert.rejects(
      () => atomicallyPublishRunOwnedFile(
        root,
        rootIdentity,
        'go',
        content,
        'self-test duplicate atomic publication',
      ),
      /target already exists/u,
    );
  } finally {
    content.fill(0);
    const rootState = await localPathState(root);
    if (rootState.exists && sameLocalPathIdentity(rootState.identity, rootIdentity)) {
      await fs.rm(root, { recursive: true });
    }
  }
}

async function selfTestSafetyIo() {
  await selfTestRuntimeSignatureReload();
  await selfTestKimiConfigStaging();
  await selfTestAtomicRunOwnedPublication();
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
    assert.match(service.detached.execMainStartTimeTicks || '', /^\d+$/u);
    assert.equal(
      sameLocalPathIdentity(
        await systemdControlGroupIdentity(controlGroup),
        service.ownership.controlGroupIdentity,
      ),
      true,
      'self-test systemd cgroup identity was not pinned',
    );
    assert.match(service.ownership.controlGroupIdentity.ino, /^\d+$/u);
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
  const eventQueryWindow = e2eEventQueryWindow(
    '2026-01-01T00:00:00.000Z',
    Date.parse('2026-01-01T00:20:00.000Z'),
  );
  assert.deepEqual(eventQueryWindow, {
    timeType: 'custom',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: '2026-01-01T00:22:00.000Z',
  });
  assert.equal(eventStorageContract({
    mode: 'clickhouse', clickhouseConfigured: true, clickhouseReady: true,
  }, 'k8s'), 'clickhouse-durable');
  assert.equal(eventStorageContract({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
  }, 'host'), 'authoritative-hot-ring');
  assert.equal(eventStorageContract({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
  }, 'docker'), undefined);
  assert.equal(eventStorageContract({
    mode: 'memory', clickhouseConfigured: true, clickhouseReady: false,
  }, 'host'), undefined);
  assert.equal(memoryNoTrimThreshold(10_000), 9_000);
  assert.equal(memoryStorageHasNoTrimEvidence({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
    hotRingSize: 9_000, hotRingCapacity: 10_000,
  }), true);
  assert.equal(memoryStorageHasNoTrimEvidence({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
    hotRingSize: 9_001, hotRingCapacity: 10_000,
  }), false);
  assert.equal(memoryStorageIsAuditableBaseline({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
    hotRingSize: 10, hotRingCapacity: 10_000,
    uptimeSeconds: MEMORY_API_MIN_BASELINE_UPTIME_SECONDS - 1,
    bootEpochEstimateMs: 900_000,
  }), false);
  assert.equal(memoryStorageIsAuditableBaseline({
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
    hotRingSize: 10, hotRingCapacity: 10_000,
    uptimeSeconds: MEMORY_API_MIN_BASELINE_UPTIME_SECONDS,
    bootEpochEstimateMs: 900_000,
  }), true);
  const strictWindow = e2eEventQueryWindow(
    '2026-01-01T00:00:00.000Z',
    Date.parse('2026-01-01T00:01:00.000Z'),
  );
  const strictCollector = 'asel-self-test-collector';
  const strictEvent = {
    collectorId: strictCollector,
    at: '2026-01-01T00:00:30.000Z',
    eventKind: 'ToolExec',
  };
  const strictPlane = {
    name: 'k8s',
    baseUrl: 'http://127.0.0.1:1/security-center',
    storage: {
      mode: 'clickhouse', clickhouseConfigured: true, clickhouseReady: true,
      hotRingSize: 10, hotRingCapacity: 10_000,
      uptimeSeconds: 100, observedAtMs: 1_000_000, bootEpochEstimateMs: 900_000,
    },
  };
  const strictRequests = [];
  let strictReadAttempts = 0;
  const strictResult = await queryEvents(
    strictPlane,
    strictCollector,
    strictWindow,
    'self-test strict durable query',
    {
      eventually: async (_label, check) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await check();
          } catch (error) {
            if (attempt === 1) throw error;
          }
        }
        throw new Error('strict durable self-test did not converge');
      },
      requestEventList: async (_baseUrl, collector, request) => {
        strictRequests.push({ collector, request: structuredClone(request) });
        strictReadAttempts += 1;
        return strictReadAttempts === 1
          ? { items: [], total: 0, totalApproximate: true, storageFallback: 'hot_ring' }
          : { items: [strictEvent], total: 1, totalApproximate: true };
      },
    },
  );
  assert.equal(strictResult.e2eQueryProof.attempts, 2);
  assert.equal(strictResult.e2eQueryProof.storageContract, 'clickhouse-durable');
  assert.equal(strictRequests.length, 2);
  assert.equal(strictRequests.every(({ collector }) => collector === strictCollector), true);
  assert.equal(strictRequests.every(({ request }) =>
    request.durable === true && request.q === undefined && request.timeType === 'custom' &&
    request.startTime === strictWindow.startTime && request.endTime === strictWindow.endTime &&
    request.scope === 'raw' && request.includeUnknown === true && request.noise === 'include' &&
    request.limit === E2E_EVENT_QUERY_LIMIT), true);
  assert.throws(
    () => validateCompleteE2eEventResult(
      { items: [{ ...strictEvent, collectorId: 'wrong-collector' }], total: 1 },
      strictCollector,
      'clickhouse-durable',
      Date.parse(strictWindow.startTime),
      Date.parse(strictWindow.endTime),
      'wrong collector self-test',
    ),
    /another collector/u,
  );
  assert.throws(
    () => validateCompleteE2eEventResult(
      { items: [{ ...strictEvent, at: '2025-12-31T23:59:59.000Z' }], total: 1 },
      strictCollector,
      'clickhouse-durable',
      Date.parse(strictWindow.startTime),
      Date.parse(strictWindow.endTime),
      'wrong time self-test',
    ),
    /outside its fixed phase window/u,
  );
  assert.throws(
    () => validateCompleteE2eEventResult(
      { items: [], total: 1 }, strictCollector, 'clickhouse-durable',
      Date.parse(strictWindow.startTime), Date.parse(strictWindow.endTime), 'truncated self-test',
    ),
    /truncated/u,
  );
  const memoryBaseline = {
    mode: 'memory', clickhouseConfigured: false, clickhouseReady: false,
    hotRingSize: 10, hotRingCapacity: 10_000,
    uptimeSeconds: 100, observedAtMs: 1_000_000, bootEpochEstimateMs: 900_000,
  };
  const memoryPlane = {
    name: 'host', baseUrl: 'http://127.0.0.1:1/security-center', storage: memoryBaseline,
  };
  const memoryResult = await queryEvents(
    memoryPlane,
    strictCollector,
    strictWindow,
    'self-test memory query',
    {
      requestEventList: async () => ({
        items: [strictEvent], total: 1, totalApproximate: true, storageFallback: 'hot_ring',
      }),
      readApiStorageCapability: async () => ({
        ...memoryBaseline,
        hotRingSize: 11,
        uptimeSeconds: 101,
        observedAtMs: 1_001_000,
        bootEpochEstimateMs: 900_000,
      }),
    },
  );
  assert.equal(memoryResult.e2eQueryProof.bootContinuityProved, true);
  assert.equal(memoryResult.e2eQueryProof.noRingTrimProved, true);
  await assert.rejects(
    () => queryEvents(memoryPlane, strictCollector, strictWindow, 'restarted memory self-test', {
      requestEventList: async () => ({ items: [], total: 0, storageFallback: 'hot_ring' }),
      readApiStorageCapability: async () => ({
        ...memoryBaseline,
        observedAtMs: 2_000_000,
        bootEpochEstimateMs: 1_900_000,
      }),
    }),
    /process changed/u,
  );
  await assert.rejects(
    () => queryEvents(memoryPlane, strictCollector, strictWindow, 'regressed uptime self-test', {
      requestEventList: async () => ({ items: [], total: 0, storageFallback: 'hot_ring' }),
      readApiStorageCapability: async () => ({
        ...memoryBaseline,
        uptimeSeconds: memoryBaseline.uptimeSeconds - 1,
        observedAtMs: memoryBaseline.observedAtMs - 1_000,
        bootEpochEstimateMs: memoryBaseline.bootEpochEstimateMs,
      }),
    }),
    /uptime regressed/u,
  );
  assert.throws(() => parseOptions(['--run-id', '../unsafe']), /run-id/u);
  assert.throws(() => parseOptions(['--api-key', 'sk-not-allowed']), /unknown option/u);
  assert.throws(() => parseOptions(['--pi-provider', 'Unsafe Provider']), /pi-provider/u);
  assert.throws(() => parseOptions(['--pi-model', 'model with spaces']), /pi-model/u);
  assert.throws(() => parseOptions(['--pi-model', 'model\u0000id']), /pi-model/u);
  assert.deepEqual(parseKimiVersion('kimi, version 1.49.0'), [1, 49, 0]);
  assert.equal(versionAtLeast([1, 49, 0], MIN_KIMI_VERSION), true);
  assert.equal(versionAtLeast([1, 48, 9], MIN_KIMI_VERSION), false);
  const customPiOptions = parseOptions([
    '--models-file', '/tmp/anysentry-self-test-models.json',
    '--pi-provider', 'self-test-provider',
    '--pi-model', 'vendor/self-test-model',
  ]);
  const customPiDocument = {
    providers: {
      'self-test-provider': {
        baseUrl: 'https://llm.invalid/v1',
        api: 'openai-completions',
        apiKey: '$DEEPSEEK_API_KEY',
        models: [{
          id: 'vendor/self-test-model',
          name: 'Self-test model',
          reasoning: false,
          input: ['text'],
          contextWindow: 16_384,
          maxTokens: 2_048,
        }],
      },
    },
  };
  assert.deepEqual(
    validatePiModelsDocument(customPiDocument, customPiOptions.piProvider, customPiOptions.piModel),
    {
      providerId: 'self-test-provider',
      modelId: 'vendor/self-test-model',
      contextWindow: 16_384,
      maxTokens: 2_048,
      api: 'openai-completions',
      baseUrl: 'https://llm.invalid/v1',
      transportSecurity: 'tls',
    },
  );
  const kimiDocument = kimiConfigDocument(
    validatePiModelsDocument(customPiDocument, customPiOptions.piProvider, customPiOptions.piModel),
    'opaque-self-test-credential',
  );
  assert.equal(kimiDocument.default_model, KIMI_CONFIG_MODEL_KEY);
  assert.deepEqual(kimiDocument.providers[KIMI_CONFIG_PROVIDER_KEY], {
    type: 'openai_legacy',
    base_url: 'https://llm.invalid/v1',
    api_key: 'opaque-self-test-credential',
    reasoning_key: 'reasoning_content',
  });
  assert.deepEqual(kimiDocument.models[KIMI_CONFIG_MODEL_KEY], {
    provider: KIMI_CONFIG_PROVIDER_KEY,
    model: 'vendor/self-test-model',
    max_context_size: 16_384,
    capabilities: [],
  });
  assert.equal(kimiDocument.loop_control.reserved_context_size, 2_048);
  assert.throws(
    () => validatePiModelsDocument({
      providers: {
        'self-test-provider': {
          ...customPiDocument.providers['self-test-provider'],
          apiKey: 'sk-not-allowed-inline',
        },
      },
    }, customPiOptions.piProvider, customPiOptions.piModel),
    /apiKey|literal credential/u,
  );
  assert.throws(
    () => validatePiModelsDocument({
      providers: {
        'self-test-provider': {
          ...customPiDocument.providers['self-test-provider'],
          headers: { Authorization: 'Bearer not-allowed' },
        },
      },
    }, customPiOptions.piProvider, customPiOptions.piModel),
    /unsupported fields/u,
  );
  for (const unsafeName of ['$UNAPPROVED_ENV', '!cat /run/secrets/credential']) {
    assert.throws(
      () => validatePiModelsDocument({
        providers: {
          'self-test-provider': {
            ...customPiDocument.providers['self-test-provider'],
            models: [{
              ...customPiDocument.providers['self-test-provider'].models[0],
              name: unsafeName,
            }],
          },
        },
      }, customPiOptions.piProvider, customPiOptions.piModel),
      /environment or command interpolation/u,
    );
  }
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
  const plannedHostCanaryUnit = hostFilterCanaryUnitName(options, 'shadow');
  assert.ok(plan.resources.some((resource) =>
    resource.plane === 'host' &&
    resource.kind === 'systemd user service' &&
    resource.name === plannedHostCanaryUnit));
  assert.equal(plan.resources.some((resource) =>
    resource.plane === 'host' &&
    resource.kind === 'Docker container' &&
    resource.name === k8sName(options, 'filter-canary', 'host', 'shadow')), false);
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
  const hostCanaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'anysentry-host-filter-canary-self-test-'));
  try {
    const hostCanaryDirectory = path.join(hostCanaryRoot, 'filter-canary-host-shadow');
    const hostCanaryMarker = filterCanaryMarker(options, 'host', 'shadow');
    await fs.mkdir(hostCanaryDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(hostCanaryDirectory, 'value'), hostCanaryMarker + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.writeFile(path.join(hostCanaryDirectory, 'go'), 'go\n', { mode: 0o600, flag: 'wx' });
    const hostCanaryPayload = hostFilterCanaryRunnerPayload(hostCanaryDirectory, hostCanaryMarker);
    assert.deepEqual(
      validateHostAgentRunnerPayload(hostCanaryPayload, {
        agent: 'filter-canary', command: '/usr/bin/true', env: {},
      }),
      hostCanaryPayload,
    );
    assert.throws(
      () => validateHostAgentRunnerPayload({ ...hostCanaryPayload, command: '/bin/sh' }),
      /filter canary runner contract/u,
    );
    assert.throws(
      () => validateHostAgentRunnerPayload({ ...hostCanaryPayload, env: { PATH: '/usr/bin:/bin' } }),
      /environment/u,
    );
    const hostCanarySystemdArgs = hostAgentSystemdRunArgs(
      plannedHostCanaryUnit,
      hostAgentUnitDescription(options.runId, ownershipNonce()),
    );
    assertHostAgentPayloadOutsideSystemdArgv(
      hostCanarySystemdArgs,
      hostCanaryPayload,
      [hostCanaryMarker],
    );
    assert.equal(hostCanarySystemdArgs.includes(hostCanaryMarker), false);
    assert.equal(await waitForHostFilterCanaryMarker(hostCanaryPayload), hostCanaryMarker);
    await fs.writeFile(path.join(hostCanaryDirectory, 'value'), 'different-marker\n');
    await assert.rejects(
      () => waitForHostFilterCanaryMarker(hostCanaryPayload),
      /differs from the launch contract/u,
    );
  } finally {
    await fs.rm(hostCanaryRoot, { recursive: true });
  }
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
  const rawBeforeEvidence = {
    reported: true,
    lastReportedAt: '2026-01-01T00:00:00.000Z',
    latest: {
      exec: 1, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      intervalSecs: 0, shutdownFinal: false,
    },
    window: {
      exec: 1, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      heartbeatCount: 1, intervalSecs: 0, shutdownFinalCount: 0,
    },
  };
  const rawPeriodicEvidence = {
    reported: true,
    lastReportedAt: '2026-01-01T00:00:00.500Z',
    latest: {
      exec: 2, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      intervalSecs: 60, shutdownFinal: false,
    },
    window: {
      exec: 3, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      heartbeatCount: 2, intervalSecs: 60, shutdownFinalCount: 0,
    },
  };
  const rawFinalEvidence = {
    reported: true,
    lastReportedAt: '2026-01-01T00:00:01.000Z',
    latest: {
      exec: 2, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      intervalSecs: 1, shutdownFinal: true,
    },
    window: {
      exec: 3, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
      heartbeatCount: 2, intervalSecs: 1, shutdownFinalCount: 1,
    },
  };
  const zeroOperationalErrorCounters = {
    queueDropped: 0,
    identityErrors: 0,
    dockerErrors: 0,
    runtimeSnapshotErrors: 0,
    runtimeSnapshotRejected: 0,
    runtimeLeaseErrors: 0,
    runtimeLeaseFenced: false,
  };
  const heartbeatBase = {
    lastHeartbeatAt: '2026-01-01 00:00:00',
    eventCount: 10,
    execEvidence: rawBeforeEvidence,
    filterMetricsReported: true,
    filterMetrics: {
      ...zeroOperationalErrorCounters,
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
    execEvidence: rawPeriodicEvidence,
  }), false, 'a newer raw heartbeat must not satisfy the shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    execEvidence: rawPeriodicEvidence,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), false, 'a periodic raw heartbeat plus an enriched final must not impersonate raw shutdown flush');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    execEvidence: rawFinalEvidence,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), true, 'a same-second final heartbeat after a new snapshot must satisfy the shutdown barrier');
  assert.equal(finalShutdownHeartbeatAdvanced(heartbeatBase, {
    ...heartbeatBase,
    execEvidence: rawFinalEvidence,
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
    execEvidence: rawFinalEvidence,
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
    execEvidence: rawFinalEvidence,
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 3,
      lastRuntimeSnapshotAt: '2026-01-01T00:00:01.000Z',
      shutdownFinal: true,
    },
  }), false, 'a collector that was already final cannot reuse the shutdown barrier');
  const zeroWindowErrors = {
    filterMetricsReported: true,
    windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
    execEvidence: {
      reported: true,
      lastReportedAt: '2026-01-01T00:00:01.000Z',
      latest: {
        exec: 1,
        execTruncated: 0,
        execIncomplete: 0,
        execReassemblyTimeout: 0,
        intervalSecs: 1,
        shutdownFinal: true,
      },
      window: {
        exec: 1,
        execTruncated: 0,
        execIncomplete: 0,
        execReassemblyTimeout: 0,
        heartbeatCount: 2,
        intervalSecs: 1,
        shutdownFinalCount: 1,
      },
    },
  };
  const shadow = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'shadow', observed: 1, forwarded: 1, wouldDiscoveryBudgetDrop: 1,
      },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'shadow', observed: 2, forwarded: 2, probableAgent: 1,
      },
    },
  ]);
  assertPhaseMetrics('shadow', shadow, 'self-test');
  assert.equal(shadow.totals.observed, 3);
  const shadowWithActualDrop = structuredClone(shadow);
  shadowWithActualDrop.totals.discoveryBudgetDropped = 1;
  assert.throws(
    () => assertPhaseMetrics('shadow', shadowWithActualDrop, 'self-test-shadow-actual-drop'),
    /shadow mode dropped unknown events/u,
  );
  const enforce = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'enforce', observed: 1, forwarded: 1, discoveryBudgetDropped: 1,
      },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      ...zeroWindowErrors,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'enforce', observed: 2, forwarded: 1, probableAgent: 1,
      },
    },
  ]);
  assertPhaseMetrics('enforce', enforce, 'self-test');
  assert.equal(enforce.totals.discoveryBudgetDropped, 1);
  const enforceWithWouldDrop = structuredClone(enforce);
  enforceWithWouldDrop.totals.wouldDiscoveryBudgetDrop = 1;
  assert.throws(
    () => assertPhaseMetrics('enforce', enforceWithWouldDrop, 'self-test-enforce-would-drop'),
    /enforce mode emitted shadow unknown counters/u,
  );
  const preFinalSample = {
    lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
    ...zeroWindowErrors,
    filterMetrics: {
      ...zeroOperationalErrorCounters,
      filterMode: 'shadow', observed: 1, forwarded: 1, runtimeSnapshotPosts: 1,
    },
  };
  const explicitFinalSample = {
    lastHeartbeatAt: '2026-01-01T00:00:01.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
    ...zeroWindowErrors,
    filterMetrics: {
      ...zeroOperationalErrorCounters,
      filterMode: 'shadow', observed: 4, forwarded: 3, runtimeSnapshotPosts: 2,
      runtimeSnapshotRetries: 1, runtimeSnapshotRecovered: 1,
      lastRuntimeSnapshotRetryAt: '2026-01-01T00:00:00.500Z',
      lastRuntimeSnapshotRetryReason: 'transient timeout',
      shutdownFinal: true,
    },
  };
  const finalInterval = aggregateHeartbeatSamples([preFinalSample], explicitFinalSample);
  assert.equal(finalInterval.count, 2, 'the explicit final heartbeat must be a sampled interval');
  assert.equal(finalInterval.totals.observed, 5, 'the final interval observed count must not be lost');
  assert.equal(finalInterval.totals.forwarded, 4, 'the final interval forwarded count must not be lost');
  assert.equal(finalInterval.diagnostics.runtimeSnapshotRetries, 1);
  assert.equal(finalInterval.diagnostics.runtimeSnapshotRecovered, 1);
  assert.equal(finalInterval.diagnostics.lastRuntimeSnapshotFailure, undefined);
  assert.equal(finalInterval.diagnostics.lastRuntimeSnapshotFailureVersion, undefined);
  assert.equal(finalInterval.diagnostics.lastRuntimeSnapshotRetryReason, 'transient timeout');
  const rawOnlyStartupIgnored = aggregateHeartbeatSamples([
    {
      ...zeroWindowErrors,
      filterMetricsReported: false,
      lastHeartbeatAt: '2025-12-31T23:59:59.000Z',
      droppedEvents: 0,
      outputDropped: 0,
      errorCount: 0,
      filterMetrics: { filterMode: 'shadow', observed: 0, forwarded: 0 },
    },
    preFinalSample,
  ], explicitFinalSample);
  assert.equal(rawOnlyStartupIgnored.count, 2, 'raw-only fallback health is not a Forwarder interval');
  assert.equal(rawOnlyStartupIgnored.operationalErrorEvidence, true);
  assert.equal(rawOnlyStartupIgnored.totals.observed, 5);
  const missingOperationalCounter = aggregateHeartbeatSamples([
    preFinalSample,
    {
      ...explicitFinalSample,
      filterMetrics: { ...explicitFinalSample.filterMetrics, identityErrors: undefined },
    },
  ]);
  assert.equal(missingOperationalCounter.operationalErrorEvidence, false);
  assert.throws(
    () => assertPhaseMetrics('shadow', missingOperationalCounter, 'self-test-missing-operational-counter'),
    /complete operational error counters/u,
  );
  const exhaustedSnapshot = aggregateHeartbeatSamples([
    preFinalSample,
    {
      ...explicitFinalSample,
      filterMetrics: {
        ...explicitFinalSample.filterMetrics,
        runtimeSnapshotErrors: 1,
        runtimeSnapshotRecovered: 0,
        lastRuntimeSnapshotFailureAt: '2026-01-01T00:00:00.750Z',
        lastRuntimeSnapshotFailure: 'snapshot transport timed out after retry',
        lastRuntimeSnapshotFailureVersion: 2,
      },
    },
  ]);
  assert.equal(exhaustedSnapshot.errors.runtimeSnapshotErrors, 1);
  assert.equal(exhaustedSnapshot.diagnostics.lastRuntimeSnapshotFailureAt, '2026-01-01T00:00:00.750Z');
  assert.equal(exhaustedSnapshot.diagnostics.lastRuntimeSnapshotFailure, 'snapshot transport timed out after retry');
  assert.equal(exhaustedSnapshot.diagnostics.lastRuntimeSnapshotFailureVersion, 2);
  const finalIntervalAlreadySampled = aggregateHeartbeatSamples(
    [preFinalSample, explicitFinalSample],
    explicitFinalSample,
  );
  assert.equal(finalIntervalAlreadySampled.count, 2, 'an already sampled final heartbeat must not be duplicated');
  assert.equal(finalIntervalAlreadySampled.totals.observed, 5);
  const maskedForwarderError = aggregateHeartbeatSamples([
    {
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z', droppedEvents: 0, outputDropped: 1, errorCount: 1,
      filterMetricsReported: true,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 1, errorCount: 1 },
      execEvidence: zeroWindowErrors.execEvidence,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'shadow', observed: 1, runtimeSnapshotPosts: 1,
      },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:01.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      filterMetricsReported: true,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 1, errorCount: 1 },
      execEvidence: zeroWindowErrors.execEvidence,
      filterMetrics: {
        ...zeroOperationalErrorCounters,
        filterMode: 'shadow', observed: 0, runtimeSnapshotPosts: 2,
      },
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
      filterMetricsReported: true,
      execEvidence: zeroWindowErrors.execEvidence,
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 1 },
    },
    {
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z', droppedEvents: 0, outputDropped: 0, errorCount: 0,
      filterMetricsReported: true,
      execEvidence: zeroWindowErrors.execEvidence,
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
    },
  ]);
  assert.throws(
    () => assertPhaseMetrics('shadow', missingWindowEvidence, 'self-test-missing-window-evidence'),
    /window-stable drop\/error evidence/u,
  );
  const incompleteEvidenceSample = {
    lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
    filterMetricsReported: true,
    droppedEvents: 0,
    outputDropped: 0,
    errorCount: 0,
    windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
    execEvidence: {
      reported: true,
      lastReportedAt: '2026-01-01T00:00:00.900Z',
      latest: {
        exec: 4029, execTruncated: 0, execIncomplete: 1899, execReassemblyTimeout: 4,
        intervalSecs: 1, shutdownFinal: true,
      },
      window: {
        exec: 4029, execTruncated: 0, execIncomplete: 1899, execReassemblyTimeout: 4,
        heartbeatCount: 2, intervalSecs: 1, shutdownFinalCount: 1,
      },
    },
    filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
  };
  const incompleteEvidenceQuality = aggregateHeartbeatSamples([
    {
      ...incompleteEvidenceSample,
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 1 },
    },
    incompleteEvidenceSample,
  ]);
  assert.equal(incompleteEvidenceQuality.errors.errorCount, 0);
  assert.equal(incompleteEvidenceQuality.evidenceQuality.window.execIncomplete, 1899);
  assert.equal(incompleteEvidenceQuality.evidenceQuality.ratios.incomplete, 1899 / 4029);
  assert.equal(incompleteEvidenceQuality.evidenceQuality.ratios.reassemblyTimeout, 4 / 4029);
  assert.equal(incompleteEvidenceQuality.evidenceQuality.ratios.truncated, 0);
  assertPhaseMetrics('shadow', incompleteEvidenceQuality, 'self-test-evidence-quality');
  const missingRawEvidenceSample = {
    lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
    filterMetricsReported: true,
    droppedEvents: 0,
    outputDropped: 0,
    errorCount: 0,
    windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
    filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
  };
  const missingRawEvidence = aggregateHeartbeatSamples([
    {
      ...missingRawEvidenceSample,
      lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 1 },
    },
    missingRawEvidenceSample,
  ]);
  assert.throws(
    () => assertPhaseMetrics('shadow', missingRawEvidence, 'self-test-missing-raw-evidence'),
    /complete raw Collector exec evidence/u,
  );
  const validExecEvidenceWindow = {
    exec: 4029,
    execTruncated: 0,
    execIncomplete: 1899,
    execReassemblyTimeout: 4,
    heartbeatCount: 2,
    intervalSecs: 1,
    shutdownFinalCount: 1,
  };
  for (const [label, window] of [
    ['string', { ...validExecEvidenceWindow, execIncomplete: '1899' }],
    ['null', { ...validExecEvidenceWindow, execIncomplete: null }],
    ['unsafe', { ...validExecEvidenceWindow, exec: Number.MAX_SAFE_INTEGER + 1 }],
    ['count-exceeds-exec', { ...validExecEvidenceWindow, execIncomplete: 4030 }],
    ['missing-window', undefined],
  ]) {
    const invalidSample = {
      lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
      filterMetricsReported: true,
      droppedEvents: 0,
      outputDropped: 0,
      errorCount: 0,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
      execEvidence: {
        reported: true,
        lastReportedAt: '2026-01-01T00:00:01.000Z',
        latest: {
          exec: 4029, execTruncated: 0, execIncomplete: 1899,
          execReassemblyTimeout: 4, intervalSecs: 1, shutdownFinal: true,
        },
        ...(window ? { window } : {}),
      },
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
    };
    const invalidEvidence = aggregateHeartbeatSamples([
      {
        ...invalidSample,
        lastHeartbeatAt: '2026-01-01T00:00:00.000Z',
        filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 1 },
      },
      invalidSample,
    ]);
    assert.equal(invalidEvidence.evidenceQuality.reported, false, label + ' exec evidence must fail closed');
    assert.throws(
      () => assertPhaseMetrics('shadow', invalidEvidence, 'self-test-invalid-exec-evidence-' + label),
      /complete raw Collector exec evidence/u,
    );
  }
  for (const [label, evidencePatch] of [
    ['missing-latest', { latest: undefined }],
    ['invalid-time', { lastReportedAt: 'not-a-time' }],
    ['non-final', {
      latest: {
        exec: 4029, execTruncated: 0, execIncomplete: 1899,
        execReassemblyTimeout: 4, intervalSecs: 1, shutdownFinal: false,
      },
    }],
  ]) {
    const sample = {
      lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
      filterMetricsReported: true,
      droppedEvents: 0,
      outputDropped: 0,
      errorCount: 0,
      windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
      execEvidence: {
        reported: true,
        lastReportedAt: '2026-01-01T00:00:01.000Z',
        latest: {
          exec: 4029, execTruncated: 0, execIncomplete: 1899,
          execReassemblyTimeout: 4, intervalSecs: 1, shutdownFinal: true,
        },
        window: validExecEvidenceWindow,
        ...evidencePatch,
      },
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
    };
    const invalid = aggregateHeartbeatSamples([sample, {
      ...sample,
      lastHeartbeatAt: '2026-01-01T00:00:02.000Z',
      filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 3 },
    }]);
    assert.throws(
      () => assertPhaseMetrics('shadow', invalid, 'self-test-exec-evidence-' + label),
      label === 'non-final' ? /final raw Collector heartbeat/u : /complete raw Collector exec evidence/u,
    );
  }
  const zeroExecSample = {
    lastHeartbeatAt: '2026-01-01T00:00:01.000Z',
    filterMetricsReported: true,
    droppedEvents: 0,
    outputDropped: 0,
    errorCount: 0,
    windowErrorMaxima: { droppedEvents: 0, outputDropped: 0, errorCount: 0 },
    execEvidence: {
      reported: true,
      lastReportedAt: '2026-01-01T00:00:01.000Z',
      latest: {
        exec: 0, execTruncated: 0, execIncomplete: 0,
        execReassemblyTimeout: 0, intervalSecs: 1, shutdownFinal: true,
      },
      window: {
        exec: 0, execTruncated: 0, execIncomplete: 0, execReassemblyTimeout: 0,
        heartbeatCount: 1, intervalSecs: 1, shutdownFinalCount: 1,
      },
    },
    filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 2 },
  };
  const zeroExec = aggregateHeartbeatSamples([zeroExecSample, {
    ...zeroExecSample,
    lastHeartbeatAt: '2026-01-01T00:00:02.000Z',
    filterMetrics: { ...zeroOperationalErrorCounters, filterMode: 'shadow', runtimeSnapshotPosts: 3 },
  }]);
  assert.equal(zeroExec.evidenceQuality.ratios.incomplete, undefined);
  assert.throws(
    () => assertPhaseMetrics('shadow', zeroExec, 'self-test-zero-exec-evidence'),
    /contains no ToolExec events/u,
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
  assert.equal(piEnv.PI_E2E_RELEASE_FILE, '/run/anysentry-e2e-marker/go');
  assert.equal(
    piEnvironment(customPiOptions, 'k8s', 'shadow').PI_E2E_RELEASE_FILE,
    PI_MARKER_RELEASE_FILE,
  );
  assert.equal(piEnv.PI_RETRY_SECONDS, String(PI_RETRY_SECONDS));
  assert.ok(PI_RUNTIME_EXIT_WAIT_MS < PI_RETRY_SECONDS * 1_000);
  const customPiEnv = piEnvironment({
    ...customPiOptions,
    piModelsFile: '/tmp/run-owned-models.json',
  }, 'docker', 'shadow');
  assert.equal(customPiEnv.PI_PROVIDER, 'self-test-provider');
  assert.equal(customPiEnv.PI_MODEL, 'vendor/self-test-model');
  assert.equal(customPiEnv.PI_CODING_AGENT_DIR, undefined);
  const selfTestPiAgentId = 'e2e-docker-shadow-' + customPiOptions.runId;
  const selfTestPiStart = JSON.stringify({
    runtime: 'pi',
    event: 'pi_process_starting',
    round: 1,
    mode: 'loop',
    provider: 'self-test-provider',
    model: 'vendor/self-test-model',
    agentId: selfTestPiAgentId,
    credentialSource: 'DEEPSEEK_API_KEY',
  });
  const selfTestPiExit = JSON.stringify({
    runtime: 'pi',
    agentId: selfTestPiAgentId,
    event: 'pi_process_exited',
    round: 1,
    code: 0,
    signal: null,
  });
  assert.deepEqual(
    assertPiRuntimeLogs([
      selfTestPiStart,
      selfTestPiExit,
    ].join('\n'), customPiOptions, 'docker', 'shadow', 'self-test'),
    {
      provider: 'self-test-provider',
      model: 'vendor/self-test-model',
      agentId: selfTestPiAgentId,
      credentialSource: 'DEEPSEEK_API_KEY',
      round: 1,
    },
  );
  let piLogPolls = 0;
  const delayedPiExit = await waitForSuccessfulPiRuntimeLogs(async () => {
    piLogPolls += 1;
    return {
      code: 0,
      signal: null,
      stdout: piLogPolls === 1 ? selfTestPiStart : selfTestPiStart + '\n' + selfTestPiExit,
      stderr: '',
    };
  }, customPiOptions, 'docker', 'shadow', 'self-test delayed', 100, 1);
  assert.equal(piLogPolls, 2, 'Pi proof must wait for the structured successful exit record');
  assert.equal(delayedPiExit.diagnostic.matchingSuccessfulExitRecords, 1);
  let failedPiDiagnostic;
  let failedPiPolls = 0;
  await assert.rejects(
    () => waitForSuccessfulPiRuntimeLogs(async () => {
      failedPiPolls += 1;
      return {
        code: 0,
        signal: null,
        stdout: selfTestPiStart + '\n' + JSON.stringify({
          runtime: 'pi',
          agentId: selfTestPiAgentId,
          event: 'pi_process_exited',
          round: 1,
          code: 1,
          signal: null,
        }),
        stderr: 'opaque diagnostic body',
      };
    }, customPiOptions, 'docker', 'shadow', 'self-test failed', 10, 1),
    (error) => {
      failedPiDiagnostic = error.piRuntimeDiagnostic;
      return /fresh-workload first turn terminated without success/u.test(error.message);
    },
  );
  assert.equal(failedPiPolls, 1, 'a failed first Pi turn must not wait for a retry round');
  assert.equal(failedPiDiagnostic.matchingSuccessfulExitRecords, 0);
  assert.equal(failedPiDiagnostic.lastLifecycleEvents.at(-1).code, 1);
  assert.equal(failedPiDiagnostic.logRead.stderrBytes, Buffer.byteLength('opaque diagnostic body'));
  assert.equal(JSON.stringify(failedPiDiagnostic).includes('opaque diagnostic body'), false);
  assert.throws(
    () => assertPiRuntimeLogs([
      selfTestPiStart,
      JSON.stringify({
        runtime: 'pi',
        agentId: selfTestPiAgentId,
        event: 'pi_process_exited',
        round: 2,
        code: 0,
        signal: null,
      }),
    ].join('\n'), customPiOptions, 'docker', 'shadow', 'self-test mismatched round'),
    /terminal record belongs to a different turn/u,
  );
  assert.throws(
    () => assertPiRuntimeLogs([
      selfTestPiStart,
      JSON.stringify({
        runtime: 'pi',
        agentId: selfTestPiAgentId,
        event: 'pi_process_exited',
        code: 0,
        signal: null,
      }),
    ].join('\n'), customPiOptions, 'docker', 'shadow', 'self-test missing round'),
    /terminal record belongs to a different turn/u,
  );
  assert.throws(
    () => assertPiRuntimeLogs([
      selfTestPiStart,
      JSON.stringify({
        runtime: 'pi',
        agentId: selfTestPiAgentId,
        event: 'pi_process_exited',
        round: 1,
        code: 0,
        signal: 'SIGTERM',
      }),
    ].join('\n'), customPiOptions, 'docker', 'shadow', 'self-test signaled exit'),
    /did not exit successfully/u,
  );
  assert.throws(
    () => assertPiRuntimeLogs([
      selfTestPiStart,
      JSON.stringify({
        runtime: 'pi',
        agentId: selfTestPiAgentId,
        event: 'pi_process_timeout',
        round: 1,
        timeoutSeconds: 90,
      }),
      selfTestPiExit,
    ].join('\n'), customPiOptions, 'docker', 'shadow', 'self-test timeout then exit'),
    /did not exit successfully/u,
  );
  const selfTestProofHash = hashText('self-test-marker\n');
  assert.match(assertPiResultFiles({
    code: 0,
    stdout: [
      '17 /workspace/tool-events.log',
      '12 /workspace/model-result.txt',
      selfTestProofHash + '  /workspace/tool-events.log',
      hashText('model result') + '  /workspace/model-result.txt',
    ].join('\n'),
  }, selfTestProofHash, 'self-test'), /tool-events\.log/u);
  assert.throws(
    () => assertPiResultFiles({
      code: 0,
      stdout: hashText('self-test-marker\nself-test-marker\n') + '  /workspace/tool-events.log',
    }, selfTestProofHash, 'self-test changed marker'),
    /tool marker changed across process exit/u,
  );
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
  assert.deepEqual(filterCanaryContract('host', 'shadow'), {
    classification: 'non_agent', filterReason: 'non_agent', metricName: 'wouldFilterNonAgent',
    shadowVisible: false, shadowApiDisposition: 'non_agent_discarded',
  });
  assert.deepEqual(filterCanaryContract('host', 'enforce'), {
    classification: 'non_agent', filterReason: 'non_agent', metricName: 'filteredNonAgent',
    shadowVisible: false, shadowApiDisposition: 'non_agent_discarded',
  });
  assert.deepEqual(filterCanaryContract('docker', 'shadow'), {
    classification: 'unknown', filterReason: 'unknown', metricName: 'wouldFilterUnknown',
    shadowVisible: true, shadowApiDisposition: 'retained',
  });
  assert.deepEqual(filterCanaryContract('k8s', 'enforce'), {
    classification: 'unknown', filterReason: 'unknown', metricName: 'filteredUnknown',
    shadowVisible: true, shadowApiDisposition: 'retained',
  });
  assert.ok(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'docker', phase: 'shadow', containerId: 'c'.repeat(64),
  }, witness));
  assert.equal(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'different-marker', environment: 'docker', phase: 'shadow', containerId: 'c'.repeat(64),
  }, witness), undefined);
  assert.equal(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'docker', phase: 'shadow', containerId: 'c'.repeat(64),
  }, { ...witness, lineSha256: 'd'.repeat(64) }), undefined);
  assert.equal(matchingFilterReceipt({
    filterMetrics: {
      e2eFilterReceipts: [{
        ...receiptHeartbeat.filterMetrics.e2eFilterReceipts[0],
        filteredAt: '2025-12-31T23:59:59.999Z',
      }],
    },
  }, {
    marker: 'e2e-marker-001', environment: 'docker', phase: 'shadow', containerId: 'c'.repeat(64),
  }, witness), undefined);
  const hostReceiptHeartbeat = structuredClone(receiptHeartbeat);
  Object.assign(hostReceiptHeartbeat.filterMetrics.e2eFilterReceipts[0], {
    classification: 'non_agent',
    filterReason: 'non_agent',
    physicalWorkloadId: undefined,
  });
  assert.ok(matchingFilterReceipt(hostReceiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'host', phase: 'shadow',
  }, witness));
  assert.equal(matchingFilterReceipt(receiptHeartbeat, {
    marker: 'e2e-marker-001', environment: 'host', phase: 'shadow',
  }, witness), undefined);
  const filterRunRecord = {
    marker: 'e2e-marker-001',
    environment: 'docker',
    phase: 'shadow',
    containerId: 'c'.repeat(64),
  };
  const armedFilterHeartbeat = {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:00',
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 10,
      wouldDiscoveryBudgetDrop: 0,
      e2eFilterReceipts: [],
    },
  };
  const historicalReceiptHeartbeat = {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:00',
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 11,
      wouldDiscoveryBudgetDrop: 1,
      e2eFilterReceipts: structuredClone(receiptHeartbeat.filterMetrics.e2eFilterReceipts),
    },
  };
  const supersedingFilterHeartbeat = {
    ...heartbeatBase,
    lastHeartbeatAt: '2026-01-01 00:00:01',
    filterMetrics: {
      ...heartbeatBase.filterMetrics,
      runtimeSnapshotPosts: 12,
      wouldDiscoveryBudgetDrop: 2,
      e2eFilterReceipts: [],
    },
  };
  const historicalCorrelation = findCorrelatedFilterHeartbeat(
    [historicalReceiptHeartbeat, supersedingFilterHeartbeat],
    supersedingFilterHeartbeat,
    armedFilterHeartbeat,
    'wouldDiscoveryBudgetDrop',
    filterRunRecord,
    witness,
  );
  assert.equal(
    historicalCorrelation?.heartbeat,
    historicalReceiptHeartbeat,
    'a superseding latest heartbeat must not hide the sampled correlated receipt',
  );
  assert.equal(
    historicalCorrelation?.examinedHeartbeatCount,
    2,
    'snapshot/current duplicate heartbeats must be considered once',
  );
  assert.equal(
    findCorrelatedFilterHeartbeat(
      [supersedingFilterHeartbeat],
      supersedingFilterHeartbeat,
      armedFilterHeartbeat,
      'wouldDiscoveryBudgetDrop',
      filterRunRecord,
      witness,
    ),
    undefined,
    'a positive background counter without a receipt must not satisfy correlation',
  );
  assert.equal(
    findCorrelatedFilterHeartbeat(
      [{
        ...historicalReceiptHeartbeat,
        lastHeartbeatAt: '2025-12-31 23:59:59',
      }],
      undefined,
      armedFilterHeartbeat,
      'wouldDiscoveryBudgetDrop',
      filterRunRecord,
      witness,
    ),
    undefined,
    'a matching receipt from before the armed heartbeat must not satisfy correlation',
  );
  const mismatchedReceiptHeartbeat = (overrides, metricValue = 1) => ({
    ...historicalReceiptHeartbeat,
    filterMetrics: {
      ...historicalReceiptHeartbeat.filterMetrics,
      wouldDiscoveryBudgetDrop: metricValue,
      e2eFilterReceipts: [{
        ...receiptHeartbeat.filterMetrics.e2eFilterReceipts[0],
        ...overrides,
      }],
    },
  });
  for (const candidate of [
    mismatchedReceiptHeartbeat({ schema: 'wrong-schema' }),
    mismatchedReceiptHeartbeat({ eventKind: 'FileAccess' }),
    mismatchedReceiptHeartbeat({ markerSha256: 'd'.repeat(64) }),
    mismatchedReceiptHeartbeat({ lineSha256: 'd'.repeat(64) }),
    mismatchedReceiptHeartbeat({ classification: 'probable_agent' }),
    mismatchedReceiptHeartbeat({ filterReason: 'noise' }),
    mismatchedReceiptHeartbeat({ physicalWorkloadId: 'docker:test:' + 'd'.repeat(64) }),
    mismatchedReceiptHeartbeat({ filteredAt: '2025-12-31T23:59:59.999Z' }),
    mismatchedReceiptHeartbeat({}, 0),
  ]) {
    assert.equal(
      findCorrelatedFilterHeartbeat(
        [candidate],
        undefined,
        armedFilterHeartbeat,
        'wouldDiscoveryBudgetDrop',
        filterRunRecord,
        witness,
      ),
      undefined,
      'a partial or counter-free receipt match must fail closed',
    );
  }
  const correlationDiagnostic = filterReceiptCorrelationDiagnostic(
    [historicalReceiptHeartbeat, supersedingFilterHeartbeat],
    supersedingFilterHeartbeat,
    armedFilterHeartbeat,
    'wouldDiscoveryBudgetDrop',
    filterRunRecord,
    witness,
  );
  assert.equal(correlationDiagnostic.heartbeatCount, 2);
  assert.equal(correlationDiagnostic.receiptCount, 1);
  assert.equal(correlationDiagnostic.candidates[0].matched, true);
  assert.equal(
    JSON.stringify(correlationDiagnostic).includes(filterRunRecord.containerId),
    false,
    'filter receipt diagnostics must not expose the workload ID',
  );
  assert.equal(
    JSON.stringify(correlationDiagnostic).includes(filterRunRecord.marker),
    false,
    'filter receipt diagnostics must not expose the raw marker',
  );
  const preReleaseQueryCalls = [];
  const preReleaseSelfTestStart = '2026-01-01T00:00:00.000Z';
  let durableSelfTestAttempts = 0;
  const immediateRetry = async (_label, check) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await check();
        if (result) return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('self-test retry did not converge');
  };
  const preReleaseProof = await preReleaseMarkerNegativeCheck(
    'http://127.0.0.1:1/security-center',
    'self-test-collector',
    'e2e-marker-001',
    preReleaseSelfTestStart,
    {
      now: () => Date.parse('2026-01-01T00:10:00.000Z'),
      eventually: immediateRetry,
      queryEvents: async (_base, _collector, extra) => {
        preReleaseQueryCalls.push(structuredClone(extra));
        if (extra.durable === true && durableSelfTestAttempts++ === 0) {
          return { items: [], total: 0, totalApproximate: true, storageFallback: 'hot_ring' };
        }
        return { items: [], total: 0, totalApproximate: true };
      },
    },
  );
  assert.deepEqual(
    preReleaseQueryCalls.map((extra) => extra.durable === true),
    [true, true],
    'the gate must use only the collector-scoped durable merged view',
  );
  assert.equal(
    preReleaseQueryCalls.every((extra) => extra.timeType === 'custom'),
    true,
  );
  assert.equal(preReleaseProof.durableAttempts, 2);
  assert.equal(preReleaseProof.completeGlobalApiInventoryClaimed, false);
  assert.equal(preReleaseProof.completeFreshCollectorPageProved, true);
  assert.equal(
    preReleaseProof.queryScope,
    'fresh-collector-candidates-with-client-side-exact-marker-check',
  );
  assert.equal(preReleaseProof.views.length, 1);
  assert.equal(preReleaseProof.views[0].view, 'durable-plus-hot-ring');
  assert.equal(preReleaseProof.views[0].storageFallback, undefined);
  assert.equal(
    preReleaseQueryCalls.every((extra) =>
      extra.startTime === preReleaseSelfTestStart &&
      extra.endTime === '2026-01-01T00:12:00.000Z'),
    true,
    'pre-release queries must use the bounded run-local time window',
  );
  let persistentFallbackCalls = 0;
  await assert.rejects(
    () => preReleaseMarkerNegativeCheck(
      'http://127.0.0.1:1/security-center',
      'self-test-collector',
      'e2e-marker-001',
      preReleaseSelfTestStart,
      {
        now: () => Date.parse('2026-01-01T00:10:00.000Z'),
        eventually: immediateRetry,
        queryEvents: async (_base, _collector, extra) => {
          persistentFallbackCalls += 1;
          if (extra.durable === true) {
            return { items: [], total: 0, totalApproximate: true, storageFallback: 'hot_ring' };
          }
          throw new Error('pre-release gate issued a non-durable query');
        },
      },
    ),
    /storage fallback/u,
  );
  assert.equal(
    persistentFallbackCalls,
    3,
    'persistent fallback must exhaust only the bounded durable retries',
  );
  const preReleaseMarkerEvent = {
    collectorId: 'self-test-collector',
    at: '2026-01-01T00:05:00.000Z',
    eventKind: 'ToolExec',
    attributes: { argv: '/usr/bin/true e2e-marker-001' },
  };
  await assert.rejects(
    () => preReleaseMarkerNegativeCheck(
      'http://127.0.0.1:1/security-center',
      'self-test-collector',
      'e2e-marker-001',
      preReleaseSelfTestStart,
      {
        now: () => Date.parse('2026-01-01T00:10:00.000Z'),
        eventually: immediateRetry,
        queryEvents: async (_base, _collector, extra) => {
          assert.equal(extra.q, undefined, 'pre-release marker filtering must remain client-side');
          assert.equal(extra.durable, true, 'pre-release marker query must remain durable');
          return { items: [preReleaseMarkerEvent], total: 1, totalApproximate: true };
        },
      },
    ),
    /visible/u,
    'the durable merged view must fail closed when it contains the marker',
  );
  await assert.rejects(
    () => preReleaseMarkerNegativeCheck(
      'http://127.0.0.1:1/security-center',
      'self-test-collector',
      'e2e-marker-001',
      preReleaseSelfTestStart,
      {
        now: () => Date.parse('2026-01-01T00:10:00.000Z'),
        eventually: immediateRetry,
        queryEvents: async () => ({ items: [], total: 1, totalApproximate: true }),
      },
    ),
    /truncated/u,
  );
  await assert.rejects(
    () => preReleaseMarkerNegativeCheck(
      'http://127.0.0.1:1/security-center',
      'self-test-collector',
      'e2e-marker-001',
      preReleaseSelfTestStart,
      {
        now: () => Date.parse('2026-01-01T00:10:00.000Z'),
        eventually: immediateRetry,
        queryEvents: async () => ({
          items: Array.from({ length: E2E_EVENT_QUERY_LIMIT }, () => ({ eventKind: 'FileAccess' })),
          total: E2E_EVENT_QUERY_LIMIT,
          totalApproximate: true,
        }),
      },
    ),
    /page boundary/u,
  );
  let overrunClockReads = 0;
  const overrunStart = Date.parse('2026-01-01T00:10:00.000Z');
  await assert.rejects(
    () => preReleaseMarkerNegativeCheck(
      'http://127.0.0.1:1/security-center',
      'self-test-collector',
      'e2e-marker-001',
      preReleaseSelfTestStart,
      {
        now: () => overrunStart +
          (overrunClockReads++ === 0 ? 0 : PRE_RELEASE_MARKER_FUTURE_SKEW_MS + 1),
        eventually: immediateRetry,
        queryEvents: async () => ({ items: [], total: 0, totalApproximate: true }),
      },
    ),
    /exceeded its requested time window/u,
  );
  let releaseSlowDurable;
  let slowQueryCalls = 0;
  const slowPreReleaseCheck = preReleaseMarkerNegativeCheck(
    'http://127.0.0.1:1/security-center',
    'self-test-collector',
    'e2e-marker-001',
    preReleaseSelfTestStart,
    {
      now: () => Date.parse('2026-01-01T00:10:00.000Z'),
      eventually: async (_label, check) => await check(),
      queryEvents: async (_base, _collector, extra) => {
        assert.equal(extra.durable, true);
        slowQueryCalls += 1;
        return await new Promise((resolve) => { releaseSlowDurable = resolve; });
      },
    },
  );
  await delay(0);
  assert.equal(typeof releaseSlowDurable, 'function');
  assert.equal(slowQueryCalls, 1, 'the pre-release gate must issue only one durable query at a time');
  releaseSlowDurable({ items: [], total: 0, totalApproximate: true });
  await slowPreReleaseCheck;
  assert.equal(slowQueryCalls, 1);
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
  const exactHeldPiEvent = {
    ...exactEvent,
    process: { exe: '/usr/bin/dash' },
    attributes: {
      ...exactEvent.attributes,
      argv: '/bin/sh -c ' + PI_MARKER_HOLD_COMMAND + ' e2e-marker-001',
      observed_argc: 4,
    },
  };
  assert.equal(
    exactMarkerToolEvent(exactHeldPiEvent, 'e2e-marker-001', 'instance-a', 'pi-held-shell'),
    true,
  );
  assert.equal(
    exactMarkerToolEvent(exactEvent, 'e2e-marker-001', 'instance-a', 'pi-held-shell'),
    false,
  );
  assert.equal(
    exactMarkerToolEvent({
      ...exactHeldPiEvent,
      attributes: { ...exactHeldPiEvent.attributes, observed_argc: 3 },
    }, 'e2e-marker-001', 'instance-a', 'pi-held-shell'),
    false,
  );
  const completeRuntimeInventory = { total: 1, items: [{ agentInstanceId: 'instance-a' }] };
  assert.equal(
    assertCompleteRuntimeInventory(completeRuntimeInventory, 'self-test'),
    completeRuntimeInventory,
  );
  assert.throws(
    () => assertCompleteRuntimeInventory({ total: 2, items: [{ agentInstanceId: 'instance-a' }] }, 'self-test'),
    /runtime inventory is truncated/u,
  );
  const ownedHostScenario = {
    running: {
      agentInstanceId: 'ari_' + 'a'.repeat(24),
      agentScopeId: 'kimi-cli',
      agentDisplayName: 'Kimi Code CLI [AnySentry E2E v2]',
      classification: 'probable_agent',
      hostId: 'self-test-host',
      bootId: 'self-test-boot',
      discoveredAt: 10_000,
      lastSeenAt: 20_000,
    },
    terminal: { endedAt: 30_000, lastSeenAt: 30_000 },
    markerEvent: { process: { cgroupId: '108021' } },
    proof: {
      launcher: {
        unit: 'self-test.service',
        invocationId: 'c'.repeat(32),
        detached: { execMainPid: 40, execMainStartTimeTicks: '1234' },
        runtimePlacement: { cgroupId: '108021' },
      },
    },
  };
  const ownedHostAuxiliary = {
    collectorId: 'self-test-collector',
    agentInstanceId: 'ari_' + 'b'.repeat(24),
    agentScopeId: 'kimi-cli',
    agentDisplayName: 'Kimi Code CLI [AnySentry E2E v2]',
    classification: 'probable_agent',
    runtimeState: 'lost',
    rootPid: 43,
    rootStartTimeTicks: '1235',
    rootGeneration: 2,
    hostId: 'self-test-host',
    bootId: 'self-test-boot',
    discoveredAt: 11_000,
    lastSeenAt: 31_000,
    endedAt: 31_000,
  };
  ownedHostScenario.runtimeOwnership = [{
    agentInstanceId: ownedHostAuxiliary.agentInstanceId,
    agentScopeId: ownedHostAuxiliary.agentScopeId,
    agentDisplayName: ownedHostAuxiliary.agentDisplayName,
    classification: ownedHostAuxiliary.classification,
    rootPid: ownedHostAuxiliary.rootPid,
    rootStartTimeTicks: ownedHostAuxiliary.rootStartTimeTicks,
    hostId: ownedHostAuxiliary.hostId,
    bootId: ownedHostAuxiliary.bootId,
    cgroupId: '108021',
    unit: 'self-test.service',
    invocationId: 'c'.repeat(32),
    launcherPid: 40,
    launcherStartTimeTicks: '1234',
    observedAt: 12_000,
  }];
  const ownedAuxiliaryProof = proveHostOwnedAuxiliaryRuntime(
    'self-test-collector',
    ownedHostAuxiliary,
    [ownedHostScenario],
  );
  assert.equal(ownedAuxiliaryProof.ownership.relation, 'live_root_in_same_run_owned_systemd_cgroup');
  assert.equal(ownedAuxiliaryProof.ownership.primaryAgentInstanceId, ownedHostScenario.running.agentInstanceId);
  assert.equal(
    proveHostOwnedAuxiliaryRuntime(
      'self-test-collector',
      { ...ownedHostAuxiliary, runtimeState: 'running' },
      [ownedHostScenario],
    ),
    undefined,
  );
  const wrongPlacementScenario = structuredClone(ownedHostScenario);
  wrongPlacementScenario.runtimeOwnership[0].cgroupId = '108022';
  assert.equal(
    proveHostOwnedAuxiliaryRuntime(
      'self-test-collector',
      ownedHostAuxiliary,
      [wrongPlacementScenario],
    ),
    undefined,
  );
  const unrelatedNovelRoot = {
    ...ownedHostAuxiliary,
    agentInstanceId: 'ari_' + 'd'.repeat(24),
    rootPid: 45,
    rootStartTimeTicks: '1236',
  };
  const partitionedRoots = await partitionNovelRuntimeRoots({
    environment: 'host',
    collectorId: 'self-test-collector',
    bootstrapInstanceIds: new Set(),
  }, [ownedHostScenario], [ownedHostAuxiliary, unrelatedNovelRoot]);
  assert.equal(partitionedRoots.ownedAuxiliary.length, 1);
  assert.equal(partitionedRoots.unexpected.length, 1);
  assert.equal(partitionedRoots.unexpected[0].agentInstanceId, unrelatedNovelRoot.agentInstanceId);
  const boundedCanary = filterCanaryCommand();
  assert.match(boundedCanary, new RegExp('remaining=' + FILTER_CANARY_WAIT_SECONDS, 'u'));
  assert.match(boundedCanary, /\/bin\/sleep 1/u);
  assert.doesNotMatch(boundedCanary, /do\s+:;/u);
  assert.match(boundedCanary, /\/usr\/bin\/true "\$marker"/u);
  assert.match(boundedCanary, /printf "0\\n" > \/run\/canary\/\.exit-code\.tmp/u);
  assert.match(boundedCanary, /mv \/run\/canary\/\.exit-code\.tmp \/run\/canary\/exit-code/u);
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
  assert.deepEqual(collectorEventTransportEnvironment(), {
    FORWARD_BATCH_SIZE: '8',
    FORWARD_HTTP_TIMEOUT_MS: '60000',
  });
  const markerHelperSelfTestHash = 'a'.repeat(64);
  const markerHelperExecGate = piMarkerHelperGateCommand(markerHelperSelfTestHash, true);
  const markerHelperInitGate = piMarkerHelperGateCommand(markerHelperSelfTestHash, false);
  assert.match(markerHelperExecGate, /exec "\$@"/u);
  assert.doesNotMatch(markerHelperInitGate, /exec "\$@"/u);
  assert.match(markerHelperExecGate, new RegExp(markerHelperSelfTestHash, 'u'));
  const postReleaseEvent = {
    eventKind: 'ToolExec',
    at: '2026-08-15 10:46:21',
    attributes: { argv: '/bin/sh -c /bin/sleep 3;: asel-marker-self-test' },
  };
  assert.equal(eventContainsExactMarker(postReleaseEvent, 'asel-marker-self-test'), true);
  assert.equal(eventContainsExactMarker({ ...postReleaseEvent, eventKind: 'FileAccess' }, 'asel-marker-self-test'), false);
  assert.equal(apiEventAtMs('2026-08-15 10:46:21'), Date.parse('2026-08-15T10:46:21Z'));
  assert.equal(
    proveMarkerEventAfterRelease(
      postReleaseEvent,
      { checkedAt: '2026-08-15T10:46:12.900Z' },
      { releasedAt: '2026-08-15T10:46:13.127Z' },
    ).observedAfterRelease,
    true,
  );
  assert.throws(
    () => proveMarkerEventAfterRelease(
      { ...postReleaseEvent, at: '2026-08-15 10:46:11' },
      { checkedAt: '2026-08-15T10:46:12.900Z' },
      { releasedAt: '2026-08-15T10:46:13.127Z' },
    ),
    /predates its release gate/u,
  );
  assert.equal(boundedRedactedText('diagnostic').capturedBytes, 10);
  const cleanedReport = finalizeE2eReportAfterCleanup(
    { success: true },
    undefined,
    '2026-08-15T10:47:00.000Z',
  );
  assert.deepEqual(cleanedReport.cleanup, {
    completed: true,
    completedAt: '2026-08-15T10:47:00.000Z',
  });
  assert.equal(cleanedReport.success, true);
  const cleanupFailedReport = finalizeE2eReportAfterCleanup(
    { success: true, failure: { message: 'primary failure' } },
    new Error('cleanup self-test failure'),
    '2026-08-15T10:48:00.000Z',
  );
  assert.equal(cleanupFailedReport.success, false);
  assert.equal(cleanupFailedReport.cleanup.completed, false);
  assert.equal(cleanupFailedReport.failure.message, 'primary failure');
  assert.equal(cleanupFailedReport.failure.globalCleanupError.message, 'cleanup self-test failure');
  const selfTestIngestScope = collectorEventIngestScopeEnvironment(
    { runId: 'self-test-run' },
    'docker',
    'shadow',
  );
  assert.deepEqual(selfTestIngestScope, {
    ANYSENTRY_E2E_INGEST_MARKER_PREFIX: 'asel-marker-self-test-run-docker-shadow-',
  });
  assert.ok(marker({ runId: 'self-test-run' }, 'docker', 'shadow', 'pi').startsWith(
    selfTestIngestScope.ANYSENTRY_E2E_INGEST_MARKER_PREFIX,
  ));
  assert.equal(
    marker({ runId: 'self-test-run' }, 'docker', 'enforce', 'pi').startsWith(
      selfTestIngestScope.ANYSENTRY_E2E_INGEST_MARKER_PREFIX,
    ),
    false,
  );
  assert.deepEqual(collectorEventIngestScopeProof(
    { runId: 'self-test-run' },
    'docker',
    'shadow',
  ), {
    mode: 'collector-phase-tool-exec-marker-prefix',
    environment: 'docker',
    phase: 'shadow',
    prefixSha256: createHash('sha256')
      .update(selfTestIngestScope.ANYSENTRY_E2E_INGEST_MARKER_PREFIX)
      .digest('hex'),
    collectorHeartbeatsBypassScope: true,
    attributionAndRuntimeDiscoveryRunBeforeScope: true,
  });
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
      'run-owned 0600 Host Kimi config and isolated 0700 state derived from the validated model',
      'bounded credential-redacted diagnostics',
      'host process quiesced before failure evidence capture',
      'no-follow exclusive evidence writes with artifact directory identity pinning',
      'tracked transient sandbox-probe directory cleanup',
      'nonce and InvocationID fenced transient host service cleanup',
      'host non-Agent filter canary runs in an owned transient systemd unit with stdin-only launch payload',
      'host runtime ProcessKey, cgroup identity, and owned auxiliary-instance correlation',
      'run-scoped runtime signature v1 -> v2 atomic reload and instance display-name contract',
      'run-scoped ToolExec marker ingest boundary with full attribution/runtime processing',
      'Pi runtime identity visible before releasing a held marker-bearing tool process',
      'fsynced 0600 Pi release file atomically published through a pinned run-owned directory',
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

function finalizeE2eReportAfterCleanup(report, cleanupFailure, completedAt = new Date().toISOString()) {
  assert.ok(plainObject(report), 'final E2E report is unavailable');
  if (cleanupFailure) {
    const error = diagnosticSanitized({
      name: cleanupFailure.name || 'Error',
      message: redact(cleanupFailure.message || String(cleanupFailure)),
    });
    report.cleanup = { completed: false, failedAt: completedAt, error };
    report.success = false;
    report.failure = { ...(report.failure || {}), globalCleanupError: error };
  } else {
    report.cleanup = { completed: true, completedAt };
  }
  report.completedAt = completedAt;
  return report;
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
  if (options.agents.some((agent) => agent.endsWith('-pi'))) {
    options.piMarkerHelperSha256 = (await hashLocalFile(PI_MARKER_HELPER_SOURCE_FILE)).sha256;
  }
  const needsK8s = options.agents.includes('k8s-pi');
  const apiState = {};
  let outcome;
  let dryRunCompleted = false;
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
      dryRunCompleted = true;
    } else {
      if (result.blockers.length) {
        throw new Error('execute refused because preflight has ' + result.blockers.length + ' blocker(s)');
      }
      outcome = await executeE2e(options, result);
    }
  } catch (error) {
    primaryError = error instanceof Error ? error : new Error(String(error));
  }
  let cleanupFailure;
  try {
    await cleanup();
  } catch (cleanupError) {
    cleanupFailure = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
    const cleanupMessage = redact(cleanupFailure.message);
    if (!primaryError) primaryError = cleanupFailure;
    else primaryError.message += '; global cleanup failed: ' + cleanupMessage;
    primaryError.globalCleanupError = diagnosticSanitized({
      name: cleanupFailure.name,
      message: cleanupMessage,
    });
  }
  if (dryRunCompleted && !primaryError) return;

  const finalReport = outcome?.report ?? primaryError?.e2eReport;
  const artifactDir = outcome?.artifactDir ?? primaryError?.e2eArtifactDir;
  if (finalReport && artifactDir) {
    finalizeE2eReportAfterCleanup(finalReport, cleanupFailure);
    try {
      const evidence = await writeJsonEvidence(artifactDir, 'report.json', finalReport);
      if (primaryError) primaryError.message += '; failure evidence=' + evidence.file;
      else {
        successOutput = {
          status: 'passed',
          runId: options.runId,
          report: evidence.file,
          reportSha256: evidence.sha256,
          comparison: finalReport.comparison,
        };
      }
    } catch (evidenceError) {
      if (primaryError) {
        primaryError.message += '; final evidence write failed: ' + redact(evidenceError?.message || evidenceError);
      } else {
        primaryError = evidenceError instanceof Error ? evidenceError : new Error(String(evidenceError));
      }
    }
  }
  if (primaryError) throw primaryError;
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
