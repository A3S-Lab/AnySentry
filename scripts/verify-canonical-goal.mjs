#!/usr/bin/env node

/**
 * Read-only QA gate for the canonical AnySentry/Observer observability goal.
 *
 * This verifier deliberately separates:
 *   - local contract evidence (source and deterministic tests);
 *   - runtime availability (Docker/Kubernetes/host probes); and
 *   - real Agent evidence (which is never inferred from a fixture or a process name).
 *
 * No command in this file mutates a remote repository, creates a Kubernetes object, starts a
 * container, or sends a model request. `--run-tests` only executes existing local test commands;
 * those commands may rebuild ignored `dist/`/`target/` outputs. SSH is inspected locally only; a
 * remote target is never contacted by this script.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const observerRoot = path.resolve(repoRoot, '..', 'Observer');

const STATUS = Object.freeze({
  PASS: 'pass',
  PARTIAL: 'partial',
  BLOCKED: 'blocked',
  UNEXECUTED: 'unexecuted',
  FAIL: 'fail',
});

const DEFAULT_TIMEOUT_MS = 8_000;
const TEST_TIMEOUT_MS = 180_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_FILES = 8_000;
const SAFE_PLACEHOLDERS = new Set([
  'change-me',
  'changeme',
  'replace-me',
  'your-key',
  'your-token',
  'token',
  'password',
  'secret',
  'example',
  'example-key',
  'local-verifier-key',
  'verify-admin-token',
  'verify-s2-admin-token',
  'verify-s3-admin-token',
  'verify-s6-admin-token',
  'verify-s7-admin-token',
  'verify-s8-admin-token',
  'proxy-managed',
]);

const FORBIDDEN_PRODUCT_CORE_FILES = [
  'apps/api/src/security-monitoring/security-monitoring.controller.ts',
  'apps/api/src/security-monitoring/sentry-judge.service.ts',
  'apps/api/src/security-monitoring/tool-evidence-linker.ts',
  'apps/api/src/security-monitoring/agent-semantic-kernel-relation.ts',
  'apps/api/src/security-monitoring/agent-conversation-resolution-v2.ts',
  'scripts/observer-forward.js',
];

const REPRESENTATIVE_OBJECTS = [
  {
    id: 'codex',
    label: 'Codex',
    fixturePaths: [
      'examples/cli-tls-observability-lab',
      'scripts/verify-real-agent-lifecycle-e2e.mjs',
    ],
    evidenceEnv: 'ANYSENTRY_CODEX_EVIDENCE',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    fixturePaths: [
      'examples/cli-tls-observability-lab',
      'deploy/agent-runtime-signatures.example.json',
    ],
    evidenceEnv: 'ANYSENTRY_CLAUDE_EVIDENCE',
  },
  {
    id: 'dify',
    label: 'Dify Workflow/Chatflow',
    fixturePaths: [
      'deploy/manual-test/agent-llm-observability/dify',
      'docs/anysentry-agent-llm-interaction-observability-prd.md',
    ],
    evidenceEnv: 'ANYSENTRY_DIFY_EVIDENCE',
  },
  {
    id: 'langchain-langgraph',
    label: 'LangChain/LangGraph',
    fixturePaths: [
      'examples/langchain-tls-observability-lab',
      'apps/api/src/security-monitoring',
    ],
    evidenceEnv: 'ANYSENTRY_LANGCHAIN_EVIDENCE',
  },
];

function usage() {
  return [
    'Usage: node scripts/verify-canonical-goal.mjs [options]',
    '',
    'Options:',
    '  --run-tests              Run bounded local build/type/contract tests (no real Agent calls).',
    '  --strict                 Exit non-zero when any required check is blocked/unexecuted/failed.',
    '  --json                   Emit the complete sanitized JSON report after the human summary.',
    '  --json-out PATH          Write a sanitized report to PATH (explicit opt-in).',
    '  --api-base URL           AnySentry /security-center base to probe (default localhost:29653).',
    '  --evidence-dir PATH      Read-only directory containing trusted, sanitized runtime evidence.',
    '  --help                   Show this text.',
  ].join('\n');
}

function parseOptions(argv) {
  const options = {
    runTests: false,
    strict: false,
    json: false,
    jsonOut: undefined,
    apiBase: 'http://127.0.0.1:29653/security-center',
    evidenceDir: process.env.ANYSENTRY_CANONICAL_EVIDENCE_DIR || undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-tests') options.runTests = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--json-out') options.jsonOut = argv[++index];
    else if (arg === '--api-base') options.apiBase = argv[++index];
    else if (arg === '--evidence-dir') options.evidenceDir = argv[++index];
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.apiBase) throw new Error('--api-base requires a URL');
  return options;
}

function trimCapture(value) {
  const text = redactText(String(value ?? ''));
  if (Buffer.byteLength(text, 'utf8') <= MAX_CAPTURE_BYTES) return text;
  return text.slice(0, MAX_CAPTURE_BYTES) + '\n...[truncated]';
}

function redactText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, 'Bearer <redacted>')
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/gu, '<redacted-key>')
    .replace(/([?&](?:token|key|secret|password|authorization|cookie)=)[^&#\s]+/giu, '$1<redacted>')
    .replace(/((?:api[_-]?key|token|secret|password|authorization|cookie)\s*[:=]\s*["']?)[^\s"'`,;]{12,}/giu, '$1<redacted>');
}

function safeUrl(value) {
  try {
    const parsed = new URL(String(value));
    return {
      origin: parsed.origin,
      path: parsed.pathname || '/',
      // Never retain userinfo, query, or fragment: they are common credential locations.
    };
  } catch {
    return { origin: 'invalid-url', path: '/' };
  }
}

function safeHost(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return String(value).replace(/[^A-Za-z0-9_.:-]/gu, '').slice(0, 120) || 'unknown';
  }
}

function result(status, message, details = {}) {
  return { status, message, ...details };
}

function command(command, args = [], options = {}) {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd ?? repoRoot;
  const startedAt = Date.now();
  const child = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: options.maxBuffer ?? MAX_CAPTURE_BYTES * 2,
    env: options.env ?? process.env,
    windowsHide: true,
  });
  const timedOut = child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGTERM';
  return {
    command,
    args,
    cwd,
    code: typeof child.status === 'number' ? child.status : undefined,
    signal: child.signal,
    timedOut,
    elapsedMs: Date.now() - startedAt,
    stdout: options.preserveOutput ? String(child.stdout || '') : trimCapture(child.stdout),
    stderr: trimCapture(child.stderr || child.error?.message),
  };
}

function commandStatus(run, successMessage, failureMessage) {
  if (run.code === 0 && !run.timedOut) return result(STATUS.PASS, successMessage, { elapsedMs: run.elapsedMs });
  if (run.timedOut) return result(STATUS.BLOCKED, failureMessage, { elapsedMs: run.elapsedMs, timeout: true });
  return result(STATUS.FAIL, failureMessage, { elapsedMs: run.elapsedMs, exitCode: run.code, stderr: run.stderr });
}

function localPath(relativePath, root = repoRoot) {
  return path.isAbsolute(relativePath) ? relativePath : path.join(root, relativePath);
}

function exists(relativePath, root = repoRoot) {
  try {
    fs.accessSync(localPath(relativePath, root), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function readText(relativePath, root = repoRoot) {
  try {
    return fs.readFileSync(localPath(relativePath, root), 'utf8');
  } catch {
    return '';
  }
}

function gitStatus(root) {
  const branch = command('git', ['branch', '--show-current'], { cwd: root });
  const head = command('git', ['rev-parse', 'HEAD'], { cwd: root });
  const upstream = command('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { cwd: root });
  const porcelain = command('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root });
  const remotes = command('git', ['remote', '-v'], { cwd: root });
  const divergence = command('git', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], { cwd: root });
  const statusEntries = porcelain.stdout
    .split(/\r?\n/u)
    .map((line) => ({ code: line.slice(0, 2), path: line.slice(3).trim() }))
    .filter((entry) => entry.path)
    .map((entry) => ({ ...entry, path: entry.path.replace(/^"|"$/gu, '') }));
  const changedPaths = statusEntries.map((entry) => entry.path);
  const trackedChangedPaths = statusEntries.filter((entry) => !entry.code.includes('?')).map((entry) => entry.path);
  const untrackedPaths = statusEntries.filter((entry) => entry.code.includes('?')).map((entry) => entry.path);
  const remoteHosts = [...new Set(remotes.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[1])
    .filter(Boolean)
    .map((url) => {
      if (url.startsWith('git@')) return url.split('@')[1]?.split(':')[0] || 'unknown';
      return safeHost(url);
    }))];
  let ahead;
  let behind;
  const divergenceParts = divergence.stdout.trim().split(/\s+/u);
  if (divergence.code === 0 && divergenceParts.length === 2) {
    ahead = Number(divergenceParts[0]);
    behind = Number(divergenceParts[1]);
  }
  return {
    path: root,
    branch: branch.stdout.trim() || 'detached',
    head: head.stdout.trim().slice(0, 40),
    upstream: upstream.code === 0 ? upstream.stdout.trim() : undefined,
    dirty: changedPaths.length > 0,
    changedPathCount: changedPaths.length,
    changedPaths: changedPaths.slice(0, 120),
    trackedChangedPaths: trackedChangedPaths.slice(0, 120),
    untrackedPaths: untrackedPaths.slice(0, 120),
    remoteHosts,
    ahead,
    behind,
  };
}

function snapshotGitStates() {
  return {
    anysentry: gitStatus(repoRoot),
    observer: exists('.', observerRoot) ? gitStatus(observerRoot) : undefined,
  };
}

function diffTrackedState(before, after) {
  if (!before || !after) return { comparable: false };
  const beforeTracked = before.trackedChangedPaths || [];
  const afterTracked = after.trackedChangedPaths || [];
  const added = afterTracked.filter((item) => !beforeTracked.includes(item));
  const removed = beforeTracked.filter((item) => !afterTracked.includes(item));
  return { comparable: true, added, removed, changed: added.length > 0 || removed.length > 0 };
}

async function probeHttp(baseUrl, route = '/healthz') {
  const safe = safeUrl(baseUrl);
  let parsed;
  try {
    parsed = new URL(baseUrl.replace(/\/$/u, '') + route);
  } catch {
    return result(STATUS.FAIL, 'invalid HTTP probe URL', { endpoint: safe });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(parsed, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'manual',
    });
    let health;
    try {
      const body = (await response.text()).slice(0, 32 * 1024);
      const parsedBody = JSON.parse(body);
      const data = parsedBody?.data && typeof parsedBody.data === 'object' ? parsedBody.data : parsedBody;
      health = {
        serviceStatus: typeof data?.status === 'string' ? data.status : undefined,
        service: typeof data?.service === 'string' ? data.service : undefined,
        storageMode: typeof data?.storage?.mode === 'string' ? data.storage.mode : undefined,
        clickhouseReady: typeof data?.storage?.clickhouseReady === 'boolean' ? data.storage.clickhouseReady : undefined,
        postgresqlReady: typeof data?.businessState?.postgresqlReady === 'boolean' ? data.businessState.postgresqlReady : undefined,
      };
    } catch {
      health = undefined;
    }
    return result(
      response.ok ? STATUS.PASS : STATUS.PARTIAL,
      response.ok ? 'health endpoint returned 2xx' : 'health endpoint responded non-2xx',
      { endpoint: safe, statusCode: response.status, health },
    );
  } catch (error) {
    const cause = error?.name === 'AbortError' ? 'timeout' : error?.cause?.code || error?.code || error?.name || 'fetch_failed';
    return result(STATUS.BLOCKED, 'health endpoint unavailable', { endpoint: safe, reason: cause });
  } finally {
    clearTimeout(timer);
  }
}

function binaryProbe(binary, args = ['--version']) {
  const located = command('bash', ['-lc', `command -v -- ${JSON.stringify(binary)}`]);
  if (located.code !== 0) return result(STATUS.UNEXECUTED, `${binary} is not installed`);
  const version = command(binary, args, { timeout: 6_000 });
  if (version.code !== 0 && !version.stdout && !version.stderr) {
    return result(STATUS.BLOCKED, `${binary} exists but version probe failed`);
  }
  const line = (version.stdout || version.stderr).split(/\r?\n/u).find(Boolean)?.slice(0, 160) || 'version unavailable';
  return result(version.code === 0 ? STATUS.PASS : STATUS.PARTIAL, `${binary} is available`, { version: line });
}

function processCount(patterns) {
  const counts = {};
  for (const pattern of patterns) {
    const run = command('pgrep', ['-af', pattern], { timeout: 3_000 });
    counts[pattern] = run.code === 0
      ? run.stdout.split(/\r?\n/u).filter(Boolean).length
      : 0;
  }
  return counts;
}

function inspectHost() {
  const binaries = {
    node: binaryProbe('node'),
    pnpm: binaryProbe('pnpm', ['--version']),
    codex: binaryProbe('codex'),
    claude: binaryProbe('claude'),
    pi: binaryProbe('pi'),
    ssh: binaryProbe('ssh', ['-V']),
    kubectl: binaryProbe('kubectl', ['version', '--client=true', '--short']),
    docker: binaryProbe('docker', ['--version']),
  };
  const kernel = command('uname', ['-srvm']);
  const identity = command('id', ['-u']);
  const bpfDisabled = readText('/proc/sys/kernel/unprivileged_bpf_disabled', '/').trim();
  const collectorBinary = exists('dist/a3s-observer-collector', observerRoot) || exists('target/release/a3s-observer-collector', observerRoot);
  const collectorProcess = processCount(['a3s-observer-collector', 'observer-supervisor.js']);
  const apiHealthPromise = probeHttp(process.env.ANYSENTRY_API_BASE || 'http://127.0.0.1:29653/security-center');
  return apiHealthPromise.then((apiHealth) => ({
    status: apiHealth.status !== STATUS.PASS
      ? apiHealth.status
      : (apiHealth.health?.storageMode === 'memory' ? STATUS.PARTIAL : STATUS.PASS),
    checks: {
      apiHealth,
      storage: apiHealth.status !== STATUS.PASS
        ? result(STATUS.BLOCKED, 'storage readiness cannot be determined while API is unavailable')
        : (apiHealth.health?.storageMode === 'memory'
          ? result(STATUS.PARTIAL, 'API is responsive with memory fallback; durable stores are not ready', { storageMode: apiHealth.health.storageMode, clickhouseReady: apiHealth.health.clickhouseReady, postgresqlReady: apiHealth.health.postgresqlReady })
          : result(STATUS.PASS, 'API reports a durable storage mode', { storageMode: apiHealth.health?.storageMode })),
      binaries,
      kernel: kernel.code === 0 ? result(STATUS.PASS, 'host kernel metadata readable', { kernel: kernel.stdout.trim().slice(0, 180) }) : result(STATUS.BLOCKED, 'host kernel metadata unavailable'),
      observerBinary: collectorBinary
        ? result(STATUS.PASS, 'Observer collector release artifact exists')
        : result(STATUS.UNEXECUTED, 'Observer collector release artifact not found'),
      observerProcess: Object.values(collectorProcess).some((count) => count > 0)
        ? result(STATUS.PASS, 'an Observer/supervisor process is running', { processCounts: collectorProcess })
        : result(STATUS.UNEXECUTED, 'no Observer process detected', { processCounts: collectorProcess }),
      bpfPrivilege: identity.code === 0 && identity.stdout.trim() === '0'
        ? result(STATUS.PASS, 'running as root for eBPF attach')
        : result(STATUS.BLOCKED, 'current shell is not root; eBPF attach requires delegated capabilities', { uid: identity.stdout.trim() || 'unknown', unprivilegedBpfDisabled: bpfDisabled || 'unknown' }),
    },
  }));
}

function inspectSsh() {
  const sshVersion = binaryProbe('ssh', ['-V']);
  const config = command('ssh', ['-G', 'localhost'], { timeout: 5_000 });
  const localPorts = {};
  for (const port of [22, 2222]) {
    const probe = command('bash', ['-lc', `timeout 2 bash -c '</dev/tcp/127.0.0.1/${port}'`], { timeout: 4_000 });
    localPorts[port] = probe.code === 0;
  }
  const configuredTarget = Boolean(process.env.ANYSENTRY_SSH_TARGET);
  return {
    status: STATUS.UNEXECUTED,
    checks: {
      client: sshVersion,
      localConfig: config.code === 0
        ? result(STATUS.PASS, 'local SSH client configuration resolves', { host: 'localhost' })
        : result(STATUS.PARTIAL, 'SSH client exists but local config resolution failed'),
      localTransport: Object.values(localPorts).some(Boolean)
        ? result(STATUS.PASS, 'a local SSH TCP listener is reachable (no login attempted)', { ports: Object.entries(localPorts).filter(([, open]) => open).map(([port]) => Number(port)) })
        : result(STATUS.UNEXECUTED, 'no local SSH TCP listener detected', { ports: Object.keys(localPorts).map(Number) }),
      runtime: result(
        STATUS.UNEXECUTED,
        configuredTarget
          ? 'SSH target is configured but remote probing is intentionally disabled'
          : 'no SSH Agent target supplied; remote runtime not executed',
        { targetConfigured: configuredTarget },
      ),
    },
  };
}

function parseDockerPs(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/u).filter(Boolean)) {
    const [name, image, status, health] = line.split('\t');
    if (name) rows.push({ name: name.slice(0, 160), image: image?.slice(0, 160), status: status?.slice(0, 160), health: health?.slice(0, 80) });
  }
  return rows;
}

function inspectDocker() {
  const info = command('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 12_000 });
  if (info.code !== 0) {
    return {
      status: STATUS.BLOCKED,
      checks: { daemon: result(STATUS.BLOCKED, 'Docker daemon unavailable') },
      containers: [],
    };
  }
  const composeBase = command('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--quiet'], { timeout: 30_000 });
  const composeModules = command('docker', ['compose', '-f', 'docker-compose.yml', '-f', 'deploy/docker-compose.modules.yml', '--profile', 'observer', '--profile', 'streaming', 'config', '--quiet'], { timeout: 30_000 });
  const ps = command('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Label "com.docker.compose.project"}}'], { timeout: 12_000 });
  const containers = parseDockerPs(ps.stdout).map((row) => ({ ...row, composeProject: row.health }));
  // The fourth field above is intentionally not called health: Docker's format only exposes the
  // project label in this query. Keep the value under a neutral name in the report.
  for (const row of containers) {
    row.composeProject = row.composeProject?.slice(0, 120);
    delete row.health;
  }
  const dify = containers.filter((row) => /dify|langgenius/iu.test(`${row.name} ${row.image}`));
  // Dify's Compose project is named `anysentry-dify-*`; do not mistake those containers (or
  // unrelated infrastructure with an `anysentry` label) for a running AnySentry API deployment.
  const anysentry = containers.filter((row) =>
    !/dify|langgenius/iu.test(`${row.name} ${row.image}`) &&
    /(?:ghcr\.io\/[^\s/]+\/anysentry(?::|@)|127\.0\.0\.1:\d+\/anysentry(?::|@)|(?:^|[-_])anysentry-api(?:[-_:]|$)|(?:^|[-_])anysentry-anysentry(?:[-_:]|$))/iu.test(`${row.name} ${row.image}`));
  const apiHealthPromise = probeHttp(process.env.ANYSENTRY_DOCKER_API_BASE || 'http://127.0.0.1:29653/security-center');
  return apiHealthPromise.then((apiHealth) => ({
    status: anysentry.length > 0 && apiHealth.status === STATUS.PASS
      ? STATUS.PASS
      : (dify.length > 0 ? STATUS.PARTIAL : (apiHealth.status === STATUS.PASS ? STATUS.BLOCKED : apiHealth.status)),
    checks: {
      daemon: result(STATUS.PASS, 'Docker daemon is reachable', { serverVersion: info.stdout.trim().slice(0, 64) }),
      composeBase: commandStatus(composeBase, 'canonical Compose parses', 'canonical Compose config failed'),
      composeModules: commandStatus(composeModules, 'module Compose overlay parses', 'module Compose overlay config failed'),
      apiHealth: anysentry.length > 0
        ? apiHealth
        : { ...apiHealth, status: apiHealth.status === STATUS.PASS ? STATUS.BLOCKED : apiHealth.status, message: 'Docker AnySentry container not detected; localhost health may belong to another process' },
      difyStack: dify.length > 0
        ? result(STATUS.PASS, 'Dify containers are running', { count: dify.length, images: [...new Set(dify.map((row) => row.image))] })
        : result(STATUS.UNEXECUTED, 'no running Dify container detected'),
      anysentryStack: anysentry.length > 0
        ? result(STATUS.PASS, 'AnySentry-labelled containers are running', { count: anysentry.length })
        : result(STATUS.BLOCKED, 'no running AnySentry container detected'),
    },
    containers: containers.slice(0, 200),
  }));
}

function jsonCommand(commandName, args, cwd = repoRoot, timeout = 12_000) {
  // Pod/event inventories routinely exceed the human-output cap. Keep the raw JSON in memory
  // only long enough to parse the bounded fields below; never print it or persist it.
  const run = command(commandName, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, preserveOutput: true });
  if (run.code !== 0) return { run, value: undefined };
  try {
    return { run, value: JSON.parse(run.stdout) };
  } catch {
    return { run, value: undefined };
  }
}

function readyPod(pod) {
  const statuses = pod?.status?.containerStatuses || [];
  return pod?.status?.phase === 'Running' && statuses.length > 0 && statuses.every((item) => item.ready === true);
}

function summarizeKubePods(pods) {
  return pods.map((pod) => ({
    name: pod.metadata?.name,
    phase: pod.status?.phase,
    ready: readyPod(pod),
    restarts: (pod.status?.containerStatuses || []).reduce((sum, item) => sum + Number(item.restartCount || 0), 0),
    containers: (pod.status?.containerStatuses || []).map((item) => ({ name: item.name, ready: Boolean(item.ready), state: Object.keys(item.state || {})[0] || 'unknown' })),
  }));
}

function inspectKubernetesManifests() {
  const manifests = ['deploy/anysentry.yaml', 'deploy/observer.yaml', 'deploy/streaming.yaml'];
  const checks = manifests.map((manifest) => {
    const run = command('kubectl', ['apply', '--dry-run=client', '--validate=false', '-f', manifest], { timeout: 20_000 });
    return { manifest, ...commandStatus(run, 'manifest parses in client dry-run', 'manifest client dry-run failed'), exitCode: run.code };
  });
  const failed = checks.filter((check) => check.status === STATUS.FAIL || check.status === STATUS.BLOCKED);
  return failed.length === 0
    ? result(STATUS.PASS, 'canonical Kubernetes manifests pass client dry-run', { manifests: checks })
    : result(STATUS.FAIL, 'one or more Kubernetes manifests failed client dry-run', { manifests: checks });
}

async function inspectKubernetes() {
  const client = command('kubectl', ['version', '--client=true', '-o', 'json'], { timeout: 8_000 });
  if (client.code !== 0) {
    return { status: STATUS.BLOCKED, checks: { client: result(STATUS.BLOCKED, 'kubectl client unavailable'), manifests: inspectKubernetesManifests() }, pods: [] };
  }
  const context = command('kubectl', ['config', 'current-context'], { timeout: 5_000 });
  const nodes = jsonCommand('kubectl', ['get', 'nodes', '-o', 'json']);
  const pods = jsonCommand('kubectl', ['-n', 'anysentry', 'get', 'pods', '-o', 'json']);
  const service = jsonCommand('kubectl', ['-n', 'anysentry', 'get', 'service', 'anysentry', '-o', 'json']);
  const kind = command('kind', ['get', 'clusters'], { timeout: 8_000 });
  if (!nodes.value || !pods.value) {
    return {
      status: STATUS.BLOCKED,
      checks: {
        client: result(STATUS.PASS, 'kubectl client is available'),
        manifests: inspectKubernetesManifests(),
        context: result(context.code === 0 ? STATUS.PASS : STATUS.PARTIAL, 'kubectl context inspected', { context: context.stdout.trim() || 'unknown' }),
        api: result(STATUS.BLOCKED, 'Kubernetes API did not return node/pod data', { nodeExitCode: nodes.run.code, podExitCode: pods.run.code }),
        kind: kind.code === 0 ? result(STATUS.PARTIAL, 'kind cluster inventory exists but was not selected/probed', { clusterCount: kind.stdout.split(/\r?\n/u).filter(Boolean).length }) : result(STATUS.UNEXECUTED, 'kind inventory unavailable'),
      },
      pods: [],
    };
  }
  const podSummary = summarizeKubePods(pods.value.items || []);
  const coreNames = new Set(['anysentry', 'clickhouse', 'redis', 'postgres', 'a3s-observer']);
  const corePods = podSummary.filter((pod) => [...coreNames].some((name) => pod.name?.startsWith(name)));
  const requiredCorePrefixes = ['anysentry-', 'clickhouse-', 'redis-', 'a3s-observer-'];
  const missingCore = requiredCorePrefixes.filter((prefix) => !podSummary.some((pod) => pod.name?.startsWith(prefix)));
  const requiredCorePods = podSummary.filter((pod) => requiredCorePrefixes.some((prefix) => pod.name?.startsWith(prefix)));
  const unhealthy = podSummary.filter((pod) => !pod.ready);
  const anySentryPod = podSummary.find((pod) => pod.name?.startsWith('anysentry-'));
  const nodeAddresses = (nodes.value.items || []).flatMap((node) => node.status?.addresses || []).filter((item) => item.type === 'InternalIP').map((item) => item.address);
  const nodePort = (service.value?.spec?.ports || []).find((port) => port.name === 'http' || port.port === 29653)?.nodePort;
  let nodePortHealth = result(STATUS.UNEXECUTED, 'AnySentry NodePort could not be derived');
  if (nodePort && nodeAddresses[0]) {
    nodePortHealth = await probeHttp(`http://${nodeAddresses[0]}:${nodePort}/security-center`, '/healthz');
    // Do not retain the node address in the report; it is enough to identify the probe class.
    nodePortHealth = { ...nodePortHealth, endpoint: { origin: 'kubernetes-nodeport', path: '/security-center/healthz' } };
  }
  return {
    status: nodePortHealth.status === STATUS.PASS && unhealthy.length === 0
      ? STATUS.PASS
      : (anySentryPod && readyPod((pods.value.items || []).find((pod) => pod.metadata?.name === anySentryPod.name)) ? STATUS.PARTIAL : nodePortHealth.status),
    checks: {
      client: result(STATUS.PASS, 'kubectl client is available'),
      manifests: inspectKubernetesManifests(),
      context: result(context.code === 0 ? STATUS.PASS : STATUS.PARTIAL, 'kubectl context inspected', { context: context.stdout.trim() || 'unknown' }),
      api: result(STATUS.PASS, 'Kubernetes API returned nodes and AnySentry namespace pods', { nodeCount: nodes.value.items?.length || 0, podCount: podSummary.length }),
      nodePortHealth,
      coreWorkloads: missingCore.length === 0 && requiredCorePods.every((pod) => pod.ready)
        ? result(STATUS.PASS, 'required AnySentry/Observer workloads are ready', { count: requiredCorePods.length })
        : result(STATUS.PARTIAL, 'one or more required/optional workloads are not ready', { missing: missingCore, unhealthy: unhealthy.slice(0, 40).map((pod) => ({ name: pod.name, phase: pod.phase, ready: pod.ready, restarts: pod.restarts })) }),
      kind: kind.code === 0
        ? result(STATUS.PARTIAL, 'kind cluster inventory exists; current kubectl context was used for evidence', { clusters: kind.stdout.split(/\r?\n/u).filter(Boolean).slice(0, 20) })
        : result(STATUS.UNEXECUTED, 'kind inventory unavailable'),
    },
    pods: podSummary.slice(0, 300),
    service: service.value ? { type: service.value.spec?.type, ports: (service.value.spec?.ports || []).map((port) => ({ name: port.name, port: port.port, nodePort: port.nodePort })) } : undefined,
  };
}

async function walkFiles(root, relative = '', output = []) {
  if (output.length >= MAX_SCAN_FILES) return output;
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = await fsp.readdir(absolute, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    if (output.length >= MAX_SCAN_FILES) break;
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (new Set(['.git', 'node_modules', 'target', 'dist', '.cache', '.pnpm']).has(entry.name)) continue;
      await walkFiles(root, childRelative, output);
    } else if (entry.isFile()) {
      output.push(childRelative);
    }
  }
  return output;
}

function highConfidenceCredentialMatches(text, sensitivePath = false) {
  const matches = [];
  const patterns = [
    { kind: 'provider_key_prefix', re: /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/gu },
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/gu },
    { kind: 'bearer_value', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gu },
  ];
  for (const { kind, re } of patterns) {
    for (const match of text.matchAll(re)) {
      const value = (match[1] || match[0] || '').replace(/^Bearer\s+/iu, '').replace(/^['"]|['"]$/gu, '').toLowerCase();
      if (!value || SAFE_PLACEHOLDERS.has(value) || value.startsWith('$') || value.startsWith('<') || value.includes('example')) continue;
      matches.push(kind);
    }
  }
  // Generic assignments are useful in dotenv/secret files but produce many false positives in
  // source and Markdown (e.g. `api_key: process.env...`). Only run this detector for a file that
  // is plausibly secret-bearing, and require a literal quoted/unquoted token value.
  if (sensitivePath) {
    const assignment = /\b(?:api[_-]?key|token|secret|password|authorization|cookie)\b\s*[:=]\s*(?:"([A-Za-z0-9._~+/=-]{16,})"|'([A-Za-z0-9._~+/=-]{16,})'|([A-Za-z0-9._~+/=-]{16,}))(?:\s|,|;|$)/giu;
    for (const match of text.matchAll(assignment)) {
      const value = (match[1] || match[2] || match[3] || '').toLowerCase();
      if (!value || SAFE_PLACEHOLDERS.has(value) || value.startsWith('process.') || value.startsWith('env.') || value.startsWith('$') || value.includes('example')) continue;
      matches.push('secret_assignment');
    }
  }
  return [...new Set(matches)];
}

async function scanCredentials() {
  const roots = [repoRoot, observerRoot].filter((root, index, all) => root && all.indexOf(root) === index && fs.existsSync(root));
  const findings = [];
  let scanned = 0;
  for (const root of roots) {
    const files = await walkFiles(root);
    for (const relative of files) {
      if (scanned >= MAX_SCAN_FILES) break;
      const absolute = path.join(root, relative);
      let stat;
      try {
        stat = await fsp.stat(absolute);
        if (stat.size > MAX_SCAN_FILE_BYTES) continue;
        const buffer = await fsp.readFile(absolute);
        if (buffer.includes(0)) continue;
        const text = buffer.toString('utf8');
        scanned += 1;
        const lowerPath = relative.toLowerCase();
        const sensitivePath = /(?:^|\/)(?:\.env(?:\.|$)|secrets?|credentials?|auth(?:entication)?)(?:\/|$)|(?:\.pem|\.key|\.p12|\.pfx)$/u.test(lowerPath) || /auth\.json$/u.test(lowerPath);
        // npm caches and generated runtime overlays are not source-of-truth evidence. Prefix/JWT
        // detectors still run on them, but generic assignment matching is disabled.
        const kinds = highConfidenceCredentialMatches(text, sensitivePath && !lowerPath.includes('/.npm/'));
        if (kinds.length > 0) {
          const tracked = command('git', ['ls-files', '--error-unmatch', '--', relative], { cwd: root, timeout: 3_000 }).code === 0;
          let mode;
          try { mode = (await fsp.stat(absolute)).mode.toString(8).slice(-3); } catch { mode = undefined; }
          findings.push({ repo: root === repoRoot ? 'AnySentry' : 'Observer', path: relative, kinds, tracked, mode });
        }
      } catch {
        // A concurrently removed/unreadable file is not a credential finding.
      }
    }
  }
  if (findings.length === 0) {
    return result(STATUS.PASS, 'no high-confidence credential literals detected', { scannedFiles: scanned, findingCount: 0 });
  }
  const trackedFindings = findings.filter((finding) => finding.tracked);
  if (trackedFindings.length > 0) {
    return result(STATUS.FAIL, 'credential-like literals detected in tracked files; values intentionally omitted', { scannedFiles: scanned, findingCount: findings.length, trackedFindingCount: trackedFindings.length, findings: findings.slice(0, 80) });
  }
  return result(STATUS.BLOCKED, 'protected/untracked credential-like files exist; clean them after authorized tests', { scannedFiles: scanned, findingCount: findings.length, trackedFindingCount: 0, findings: findings.slice(0, 80) });
}

async function inspectFixtureCapabilities(fixturePaths) {
  const patterns = {
    raw: /RawObservation|raw[_-]observation|sourceRefs|derivedFrom/iu,
    kernel: /KernelFact|ToolExec|ProcessExec|FileAccess|NetworkConnect|SecurityAction/iu,
    semantic: /LlmInteraction|SemanticRecord|ToolCall|ToolResult|messages|workflow_run_id|thread_id/iu,
    correlation: /EvidenceLink|semantic[_-]kernel|relation|correlat/iu,
    coverage: /CoverageGap|coverage[_-]gap|unsupported|partial|truncat|unparsed/iu,
  };
  const chunks = [];
  for (const fixturePath of fixturePaths) {
    const absolute = localPath(fixturePath);
    let stat;
    try { stat = await fsp.stat(absolute); } catch { continue; }
    const files = stat.isDirectory() ? (await walkFiles(absolute)).map((item) => path.join(absolute, item)) : [absolute];
    for (const file of files.slice(0, 240)) {
      try {
        const buffer = await fsp.readFile(file);
        if (!buffer.includes(0)) chunks.push(buffer.subarray(0, 256 * 1024).toString('utf8'));
      } catch {
        // Fixtures can include optional generated files that disappear between scans.
      }
    }
  }
  const text = chunks.join('\n');
  return Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => [
    name,
    pattern.test(text) ? STATUS.PASS : STATUS.UNEXECUTED,
  ]));
}

function sourceFilesForContract() {
  return [
    ...['apps/api/src', 'apps/web/src'].filter((item) => exists(item)).map((item) => localPath(item)),
    ...['src', 'a3s-observer-common/src', 'a3s-observer-collector/src', 'a3s-observer-ebpf/src'].filter((item) => exists(item, observerRoot)).map((item) => localPath(item, observerRoot)),
  ];
}

async function grepSourceTerms(terms) {
  const matches = {};
  const roots = sourceFilesForContract();
  const files = [];
  for (const root of roots) {
    const rootStat = fs.statSync(root);
    if (rootStat.isDirectory()) {
      const walked = await walkFiles(root);
      files.push(...walked.map((relative) => path.join(root, relative)));
    } else files.push(root);
  }
  for (const term of terms) matches[term] = [];
  for (const file of files) {
    let text;
    try {
      const buffer = await fsp.readFile(file);
      if (buffer.includes(0)) continue;
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    for (const term of terms) {
      if (text.includes(term)) {
        matches[term].push(path.relative(repoRoot, file).slice(0, 240));
      }
    }
  }
  return matches;
}

async function inspectCanonicalContracts() {
  const terms = [
    'RawObservation',
    'raw_observation',
    'KernelFact',
    'ProcessGeneration',
    'process_generation',
    'ConnectionIdentity',
    'SemanticRecord',
    'LlmCall',
    'LogicalAgent',
    'AgentInstance',
    'RuntimeInstance',
    'SessionMembership',
    'EvidenceLink',
    'RelationRevision',
    'CoverageGap',
    'coverage_gap',
  ];
  const matches = await grepSourceTerms(terms);
  const groups = {
    raw: ['RawObservation', 'raw_observation'],
    kernel: ['KernelFact', 'ProcessGeneration', 'process_generation', 'ConnectionIdentity'],
    semantic: ['SemanticRecord', 'LlmCall'],
    identity: ['LogicalAgent', 'AgentInstance', 'RuntimeInstance', 'SessionMembership'],
    correlation: ['EvidenceLink', 'RelationRevision'],
    coverage: ['CoverageGap', 'coverage_gap'],
  };
  const checks = {};
  for (const [group, groupTerms] of Object.entries(groups)) {
    const hitFiles = [...new Set(groupTerms.flatMap((term) => matches[term] || []))];
    checks[group] = hitFiles.length > 0
      ? result(STATUS.PASS, `${group} contract markers found in source`, { files: hitFiles.slice(0, 30), terms: groupTerms.filter((term) => (matches[term] || []).length > 0) })
      : result(STATUS.UNEXECUTED, `${group} canonical contract markers not found in current source`, { terms: groupTerms });
  }
  const forbiddenHits = [];
  for (const relative of FORBIDDEN_PRODUCT_CORE_FILES) {
    const text = readText(relative);
    if (!text) continue;
    const regex = /(?:agent(?:Id|Product|Family)?\s*===?|\bif\s*\([^)]*)\s*["'](?:codex|claude|dify|langchain|langgraph)["']/giu;
    if (regex.test(text)) forbiddenHits.push(relative);
  }
  checks.productBranchGuard = forbiddenHits.length === 0
    ? result(STATUS.PASS, 'no obvious product-name branch found in forbidden core modules')
    : result(STATUS.FAIL, 'product-name branch found in a forbidden core module', { files: forbiddenHits });
  checks.observerAbiAlignment = inspectObserverAbiAlignment();
  checks.streamingBoundary = inspectStreamingBoundary();
  return { checks, markers: matches };
}

function inspectObserverAbiAlignment() {
  const model = readText('src/model.rs', observerRoot);
  const collector = readText('a3s-observer-collector/src/main.rs', observerRoot);
  if (!model || !collector) return result(STATUS.UNEXECUTED, 'Observer common/collector sources are unavailable');
  const issues = [];
  // SourceRef was historically a tuple string. A collector initializer using named fields is a
  // hard compile error; catch it before spending minutes in cargo test and report the ABI boundary
  // explicitly. If common evolves to a named struct this guard naturally stops firing.
  if (/pub\s+struct\s+SourceRef\s*\(\s*String\s*\)/u.test(model) && /\bSourceRef\s*\{/u.test(collector)) {
    issues.push('collector constructs SourceRef with named fields while common defines tuple SourceRef(String)');
  }
  const coverageBlock = /pub\s+struct\s+CoverageGap\s*\{([\s\S]*?)\n\}/u.exec(model)?.[1] || '';
  const coverageFields = new Set([...coverageBlock.matchAll(/^\s*pub\s+(\w+)\s*:/gmu)].map((match) => match[1]));
  if (coverageFields.size > 0) {
    for (const init of collector.matchAll(/\bCoverageGap\s*\{([\s\S]*?)\n\s*\}/gu)) {
      for (const field of init[1].matchAll(/^\s*(\w+)\s*:/gmu)) {
        if (!coverageFields.has(field[1])) issues.push(`collector uses unknown CoverageGap field: ${field[1]}`);
      }
    }
  }
  return issues.length === 0
    ? result(STATUS.PASS, 'Observer collector initializers align with common ABI')
    : result(STATUS.FAIL, 'Observer collector/common ABI mismatch detected', { issues: [...new Set(issues)].slice(0, 40) });
}

function inspectStreamingBoundary() {
  const compose = readText('docker-compose.yml');
  const manifest = readText('deploy/anysentry.yaml');
  const apiService = compose.split(/^  anysentry:\s*$/mu)[1]?.split(/^  [A-Za-z0-9_-]+:\s*$/mu)[0] || '';
  const streamingProfile = /^  kafka:\s*\n\s+profiles:\s*\["streaming"\]/mu.test(compose);
  const dependsOnBlock = /^    depends_on:\s*\n((?:^      .*(?:\n|$))*)/mu.exec(apiService)?.[1] || '';
  const apiDependsOnStreaming = /\b(?:kafka|flink[-_])/iu.test(dependsOnBlock);
  const streamingDefaultOff = /ANYSENTRY_STREAMING:\s*"off"/u.test(manifest)
    && /ANYSENTRY_STREAMING:\s*\$\{ANYSENTRY_STREAMING:-off\}/u.test(compose);
  if (streamingProfile && !apiDependsOnStreaming && streamingDefaultOff) {
    return result(STATUS.PASS, 'Kafka/Flink remain optional profile dependencies, not a core API prerequisite');
  }
  return result(STATUS.FAIL, 'Kafka/Flink appear to be required by the current main chain', {
    streamingProfile,
    apiDependsOnStreaming,
    streamingDefaultOff,
  });
}

function fixtureEvidenceStatus(object, evidenceDir) {
  const fixturePresent = object.fixturePaths.some((item) => exists(item));
  const envEvidence = object.evidenceEnv && process.env[object.evidenceEnv];
  let evidencePath = envEvidence || evidenceDir;
  let evidence = undefined;
  if (evidencePath) {
    try {
      const stat = fs.statSync(evidencePath);
      if (stat.isDirectory()) {
        const candidate = path.join(evidencePath, `${object.id}.json`);
        if (fs.existsSync(candidate)) evidencePath = candidate;
      }
      if (fs.statSync(evidencePath).isFile() && fs.statSync(evidencePath).size <= MAX_SCAN_FILE_BYTES) {
        const raw = fs.readFileSync(evidencePath, 'utf8');
        // Evidence files are accepted only as a boolean/status envelope. Do not echo payloads.
        const parsed = JSON.parse(raw);
        evidence = {
          path: path.basename(evidencePath),
          schemaVersion: typeof parsed.schemaVersion === 'string' ? parsed.schemaVersion : undefined,
          status: typeof parsed.status === 'string' ? parsed.status : undefined,
          dimensions: parsed.dimensions && typeof parsed.dimensions === 'object'
            ? Object.fromEntries(['raw', 'kernel', 'semantic', 'correlation', 'coverage', 'session', 'tool'].map((key) => [key, parsed.dimensions[key]]).filter(([, value]) => value !== undefined))
            : undefined,
        };
      }
    } catch {
      evidence = { path: path.basename(String(evidencePath)), status: 'invalid_or_unreadable' };
    }
  }
  const runtime = evidence?.status === STATUS.PASS
    ? result(STATUS.PASS, 'sanitized runtime evidence envelope reports pass', { evidence: { path: evidence.path, schemaVersion: evidence.schemaVersion, dimensions: evidence.dimensions } })
    : result(STATUS.UNEXECUTED, 'real runtime evidence was not supplied; fixture presence is not runtime proof', { evidenceSupplied: Boolean(evidencePath), evidence: evidence ? { path: evidence.path, status: evidence.status } : undefined });
  return inspectFixtureCapabilities(object.fixturePaths).then((fixtureDimensions) => ({
    fixture: fixturePresent ? result(STATUS.PASS, 'fixture/adapter source exists', { paths: object.fixturePaths.filter((item) => exists(item)) }) : result(STATUS.UNEXECUTED, 'fixture/adapter source not found'),
    fixtureDimensions,
    runtime,
  }));
}

function buildPipelineDimensions(contractChecks) {
  const dimensions = {};
  for (const [name, check] of Object.entries(contractChecks)) {
    if (['productBranchGuard'].includes(name)) continue;
    dimensions[name] = check.status;
  }
  return dimensions;
}

function buildCapabilityMatrix(objects, environments) {
  const matrix = [];
  for (const object of objects) {
    for (const environment of ['host', 'ssh', 'docker', 'kubernetes']) {
      const envStatus = environments[environment]?.status || STATUS.UNEXECUTED;
      const runtimeStatus = object.runtime.status;
      const evidenceDimensions = object.runtime.evidence?.dimensions || {};
      let status = runtimeStatus;
      let reason = 'real runtime evidence not supplied';
      if (runtimeStatus === STATUS.PASS) {
        status = envStatus === STATUS.PASS ? STATUS.PASS : envStatus;
        reason = envStatus === STATUS.PASS ? 'sanitized runtime evidence and environment probe passed' : 'runtime evidence exists but environment is not healthy';
      } else if (envStatus === STATUS.BLOCKED || envStatus === STATUS.FAIL) {
        status = envStatus;
        reason = 'environment probe is unavailable or failed';
      } else if (!object.fixture.status || object.fixture.status === STATUS.UNEXECUTED) {
        status = STATUS.UNEXECUTED;
        reason = 'fixture/adapter source is absent';
      }
      matrix.push({
        object: object.id,
        environment,
        fixture: object.fixture.status,
        startup: status,
        rounds: evidenceDimensions.rounds || STATUS.UNEXECUTED,
        llm: evidenceDimensions.llm || STATUS.UNEXECUTED,
        tool: evidenceDimensions.tool || STATUS.UNEXECUTED,
        raw: evidenceDimensions.raw || STATUS.UNEXECUTED,
        semantic: evidenceDimensions.semantic || STATUS.UNEXECUTED,
        kernel: evidenceDimensions.kernel || STATUS.UNEXECUTED,
        correlation: evidenceDimensions.correlation || STATUS.UNEXECUTED,
        coverage: evidenceDimensions.coverage || STATUS.UNEXECUTED,
        fixtureDimensions: object.fixtureDimensions,
        reason,
      });
    }
  }
  return matrix;
}

async function runLocalTests() {
  const definitions = [
    { id: 'anysentry-build', cwd: repoRoot, command: 'pnpm', args: ['build'], timeout: TEST_TIMEOUT_MS },
    { id: 'api-typescript', cwd: repoRoot, command: 'pnpm', args: ['--filter', '@anysentry/api', 'exec', 'tsc', '--noEmit'], timeout: TEST_TIMEOUT_MS },
    { id: 'web-typescript', cwd: repoRoot, command: 'pnpm', args: ['--filter', '@anysentry/web', 'exec', 'tsc', '--noEmit'], timeout: TEST_TIMEOUT_MS },
    { id: 'deployment-manifests', cwd: repoRoot, command: 'node', args: ['scripts/verify-deployment-manifests.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'canonical-contract', cwd: repoRoot, command: 'node', args: ['scripts/verify-canonical-contract.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'canonical-observability', cwd: repoRoot, command: 'node', args: ['scripts/verify-canonical-observability.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'conversation-resolution', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-conversation-resolution-v2.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'conversation-directory', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-conversation-directory.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'conversation-binding', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-conversation-binding.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'agent-asset-model', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-asset-model.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'semantic-kernel-relation', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-semantic-kernel-relation.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'runtime-state', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-runtime-state.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'agent-templates', cwd: repoRoot, command: 'node', args: ['scripts/verify-agent-templates.mjs'], timeout: TEST_TIMEOUT_MS },
    { id: 'observer-cargo', cwd: observerRoot, command: 'cargo', args: ['test', '--locked', '--offline', '-p', 'a3s-observer', '-p', 'a3s-observer-common', '-p', 'a3s-observer-collector', '--release'], timeout: TEST_TIMEOUT_MS },
  ];
  const tests = [];
  for (const definition of definitions) {
    const run = command(definition.command, definition.args, { cwd: definition.cwd, timeout: definition.timeout });
    const check = commandStatus(run, `${definition.id} passed`, `${definition.id} failed or was blocked`);
    tests.push({ id: definition.id, ...check, exitCode: run.code, outputTail: trimCapture(`${run.stdout}\n${run.stderr}`).slice(-8_000) });
  }
  return tests;
}

function summarizeStatuses(report) {
  const statuses = [];
  const collect = (value) => {
    if (!value) return;
    if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object') {
      if (Object.values(STATUS).includes(value.status)) statuses.push(value.status);
      for (const [key, child] of Object.entries(value)) {
        if (key === 'markers' || key === 'containers' || key === 'pods' || key === 'changedPaths' || key === 'remoteHosts') continue;
        collect(child);
      }
    }
  };
  collect(report.environments);
  collect(report.contracts?.checks);
  collect(report.objects);
  collect(report.tests);
  collect(report.hygiene);
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, statuses.filter((item) => item === status).length]));
  return { ...counts, total: statuses.length };
}

function printHumanSummary(report) {
  console.log(`Canonical goal verifier · ${report.generatedAt}`);
  console.log(`Repositories: AnySentry ${report.repositories.anysentry.head} (${report.repositories.anysentry.branch}), Observer ${report.repositories.observer?.head || 'missing'} (${report.repositories.observer?.branch || 'missing'})`);
  console.log('\nEnvironment matrix:');
  for (const [name, environment] of Object.entries(report.environments)) {
    console.log(`  ${name.padEnd(12)} ${environment.status.padEnd(10)} ${environment.summary || ''}`);
  }
  console.log('\nRepresentative object matrix (runtime evidence is never inferred):');
  console.log('  object                 fixture    host       ssh        docker     kubernetes');
  for (const object of report.objects) {
    const rows = report.capabilityMatrix.filter((row) => row.object === object.id);
    const byEnv = Object.fromEntries(rows.map((row) => [row.environment, row.startup]));
    console.log(`  ${object.label.padEnd(22)} ${object.fixture.status.padEnd(10)} ${String(byEnv.host).padEnd(10)} ${String(byEnv.ssh).padEnd(10)} ${String(byEnv.docker).padEnd(10)} ${String(byEnv.kubernetes).padEnd(10)}`);
    for (const row of rows) {
      console.log(`    ${row.environment.padEnd(12)} dimensions raw=${row.raw}, semantic=${row.semantic}, kernel=${row.kernel}, correlation=${row.correlation}, coverage=${row.coverage}`);
    }
    console.log(`    fixture      dimensions raw=${object.fixtureDimensions.raw}, semantic=${object.fixtureDimensions.semantic}, kernel=${object.fixtureDimensions.kernel}, correlation=${object.fixtureDimensions.correlation}, coverage=${object.fixtureDimensions.coverage}`);
  }
  console.log('\nPipeline dimensions:');
  for (const [name, check] of Object.entries(report.contracts.checks)) console.log(`  ${name.padEnd(18)} ${check.status.padEnd(10)} ${check.message}`);
  console.log('\nLocal tests:');
  if (report.tests.length === 0) console.log('  (not run; use --run-tests)');
  for (const test of report.tests) console.log(`  ${test.id.padEnd(28)} ${test.status.padEnd(10)} ${test.message}`);
  console.log('\nHygiene:');
  console.log(`  credential scan       ${report.hygiene.credentials.status.padEnd(10)} ${report.hygiene.credentials.message}`);
  console.log(`  remote write guard    ${report.hygiene.remoteWrite.status.padEnd(10)} ${report.hygiene.remoteWrite.message}`);
  console.log(`\nSummary: ${JSON.stringify(report.summary)}`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const beforeGit = snapshotGitStates();
  const [host, docker, kubernetes] = await Promise.all([
    inspectHost(),
    inspectDocker(),
    inspectKubernetes(),
  ]);
  const ssh = inspectSsh();
  const environments = {
    host: { ...host, summary: host.checks.storage?.status === STATUS.PARTIAL ? host.checks.storage.message : host.checks.apiHealth.message },
    ssh: { ...ssh, summary: ssh.checks.runtime.message },
    docker: { ...docker, summary: docker.checks.apiHealth?.message || docker.checks.daemon.message },
    kubernetes: { ...kubernetes, summary: kubernetes.checks.nodePortHealth?.message || kubernetes.checks.api?.message },
  };
  const contracts = await inspectCanonicalContracts();
  const objectEvidence = await Promise.all(REPRESENTATIVE_OBJECTS.map(async (object) => ({ object, evidence: await fixtureEvidenceStatus(object, options.evidenceDir) })));
  const objects = objectEvidence.map(({ object, evidence }) => ({ id: object.id, label: object.label, fixture: evidence.fixture, fixtureDimensions: evidence.fixtureDimensions, runtime: evidence.runtime }));
  const tests = options.runTests ? await runLocalTests() : [];
  const credentials = await scanCredentials();
  const afterPreTest = snapshotGitStates();
  const trackedDiff = {
    anysentry: diffTrackedState(beforeGit.anysentry, afterPreTest.anysentry),
    observer: diffTrackedState(beforeGit.observer, afterPreTest.observer),
  };
  const remoteWrite = (trackedDiff.anysentry.changed || trackedDiff.observer.changed)
    ? result(STATUS.BLOCKED, 'tracked worktree paths changed during the probe; this may be a concurrent agent edit, so no remote-write claim is made', { trackedDiff })
    : result(STATUS.PASS, 'verifier invokes no git push/remote mutation command; tracked worktree unchanged', {
      trackedDiff,
      remoteWriteAttempted: false,
      remoteHosts: { anysentry: beforeGit.anysentry.remoteHosts, observer: beforeGit.observer?.remoteHosts || [] },
    });
  const report = {
    schemaVersion: 'anysentry.canonical_goal_verification.v1',
    generatedAt: new Date().toISOString(),
    mode: { runTests: options.runTests, strict: options.strict },
    repositories: beforeGit,
    environments,
    contracts,
    objects,
    pipelineDimensions: buildPipelineDimensions(contracts.checks),
    capabilityMatrix: buildCapabilityMatrix(objects, environments),
    tests,
    hygiene: { credentials, remoteWrite },
    summary: undefined,
  };
  report.summary = summarizeStatuses(report);
  printHumanSummary(report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  if (options.jsonOut) {
    const target = path.resolve(options.jsonOut);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`Sanitized JSON report written to ${target}`);
  }
  const hardFailures = report.summary.fail > 0;
  const strictMissing = options.strict && (report.summary.blocked > 0 || report.summary.unexecuted > 0 || report.summary.partial > 0);
  if (hardFailures || strictMissing) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FAIL canonical-goal verifier: ${error?.stack || error}`);
  process.exitCode = 1;
});
