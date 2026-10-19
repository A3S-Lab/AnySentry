#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const OBSERVER_SCRIPT = path.join(SCRIPT_DIRECTORY, 'codex-conversation-observer.mjs');
const DEFAULT_PID_FILE = path.join(
  REPOSITORY_ROOT,
  '.local/codex-conversation-observer.pid.json',
);
const DEFAULT_LOG_FILE = path.join(
  REPOSITORY_ROOT,
  '.local/codex-conversation-observer.log',
);

function value(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positiveInteger(input, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(input ?? ''), 10);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(maximum, parsed))
    : fallback;
}

function atomicPrivateWrite(filename, payload) {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
}

function readPidFile(filename) {
  if (!fs.existsSync(filename)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      parsed?.schemaVersion !== 'anysentry.codex-conversation-observer-daemon.v1'
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid < 2
      || typeof parsed.threadId !== 'string'
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function processCommandLine(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\u0000').filter(Boolean);
  } catch {
    return [];
  }
}

function matchingObserver(record) {
  if (!record) return false;
  try {
    process.kill(record.pid, 0);
  } catch {
    return false;
  }
  const command = processCommandLine(record.pid);
  return (
    command.some((entry) => path.resolve(entry) === OBSERVER_SCRIPT)
    && command.includes('--watch')
    && command.includes(record.threadId)
  );
}

function cleanStalePidFile(filename, record) {
  if (!record || matchingObserver(record)) return;
  try {
    fs.unlinkSync(filename);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function status(pidFile) {
  const record = readPidFile(pidFile);
  const running = matchingObserver(record);
  if (!running) cleanStalePidFile(pidFile, record);
  return {
    status: running ? 'running' : 'stopped',
    ...(running
      ? {
          pid: record.pid,
          threadId: record.threadId,
          startedAt: record.startedAt,
          logFile: record.logFile,
        }
      : {}),
  };
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function start(argv, { pidFile, logFile }) {
  const existing = readPidFile(pidFile);
  if (matchingObserver(existing)) {
    return {
      status: 'already_running',
      pid: existing.pid,
      threadId: existing.threadId,
      startedAt: existing.startedAt,
      logFile: existing.logFile,
    };
  }
  cleanStalePidFile(pidFile, existing);

  const threadId =
    value(argv, '--thread')
    || process.env.ANYSENTRY_CODEX_THREAD_ID?.trim()
    || process.env.CODEX_THREAD_ID?.trim();
  if (!threadId) {
    throw new Error(
      'select one exact conversation with --thread, ANYSENTRY_CODEX_THREAD_ID, or CODEX_THREAD_ID',
    );
  }
  const pollMs = positiveInteger(
    value(argv, '--poll-ms') || process.env.ANYSENTRY_CODEX_CONVERSATION_POLL_MS,
    10_000,
    1_000,
    60_000,
  );
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(logFile), 0o700);
  const logDescriptor = fs.openSync(logFile, 'a', 0o600);
  fs.chmodSync(logFile, 0o600);
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        OBSERVER_SCRIPT,
        '--watch',
        '--thread',
        threadId,
        '--poll-ms',
        String(pollMs),
      ],
      {
        cwd: REPOSITORY_ROOT,
        detached: true,
        stdio: ['ignore', logDescriptor, logDescriptor],
        env: process.env,
      },
    );
  } finally {
    fs.closeSync(logDescriptor);
  }
  child.unref();
  const record = {
    schemaVersion: 'anysentry.codex-conversation-observer-daemon.v1',
    pid: child.pid,
    threadId,
    pollMs,
    startedAt: new Date().toISOString(),
    logFile,
  };
  atomicPrivateWrite(pidFile, record);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (!matchingObserver(record)) {
    cleanStalePidFile(pidFile, record);
    throw new Error(`Codex conversation observer exited during startup; inspect ${logFile}`);
  }
  return {
    status: 'started',
    pid: record.pid,
    threadId,
    startedAt: record.startedAt,
    logFile,
  };
}

async function stop(pidFile) {
  const record = readPidFile(pidFile);
  if (!matchingObserver(record)) {
    cleanStalePidFile(pidFile, record);
    return { status: 'already_stopped' };
  }
  process.kill(record.pid, 'SIGTERM');
  const exited = await waitForExit(record.pid, 5_000);
  if (exited) cleanStalePidFile(pidFile, record);
  return {
    status: exited ? 'stopped' : 'stopping',
    pid: record.pid,
    threadId: record.threadId,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] || 'status';
  const pidFile = path.resolve(
    value(argv, '--pid-file')
      || process.env.ANYSENTRY_CODEX_CONVERSATION_PID_FILE
      || DEFAULT_PID_FILE,
  );
  const logFile = path.resolve(
    value(argv, '--log-file')
      || process.env.ANYSENTRY_CODEX_CONVERSATION_LOG_FILE
      || DEFAULT_LOG_FILE,
  );
  let result;
  if (command === 'start') {
    result = await start(argv.slice(1), { pidFile, logFile });
  } else if (command === 'stop') {
    result = await stop(pidFile);
  } else if (command === 'status') {
    result = status(pidFile);
  } else {
    throw new Error('usage: codex-conversation-observer-daemon.mjs start|stop|status [options]');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `[codex-conversation-observer-daemon] ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exitCode = 1;
});
