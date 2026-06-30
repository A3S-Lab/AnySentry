#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const apiEntry = fileURLToPath(new URL('../apps/api/dist/main.js', import.meta.url));
const verifierEntries = (process.argv.slice(2).length ? process.argv.slice(2) : ['scripts/verify-deep-links.mjs'])
  .map((entry) => path.resolve(repoRoot, entry));
const defaultPort = 29654;
const readyTimeoutMs = Number(process.env.ANYSENTRY_API_READY_TIMEOUT_MS ?? 30000);

let apiChild;
let apiExited = false;
let apiExitStatus;
let cleanupPromise;

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}". Expected an integer from 1 to 65535.`);
  }
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function choosePort() {
  if (process.env.PORT) {
    const requestedPort = parsePort(process.env.PORT);
    if (!(await isPortAvailable(requestedPort))) {
      throw new Error(`PORT ${requestedPort} is already in use. Choose another PORT or unset it to auto-select one.`);
    }
    return requestedPort;
  }

  for (let port = defaultPort; port < defaultPort + 100; port += 1) {
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`Could not find an available port in ${defaultPort}-${defaultPort + 99}.`);
}

function pipeWithPrefix(stream, prefix) {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      process.stderr.write(`${prefix}${line}\n`);
    }
  });
  stream.on('end', () => {
    if (buffered) process.stderr.write(`${prefix}${buffered}\n`);
  });
}

async function waitForReady(url) {
  const deadline = Date.now() + readyTimeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    if (apiExited) {
      const status = apiExitStatus?.signal ?? apiExitStatus?.code ?? 'unknown';
      throw new Error(`AnySentry API exited before becoming ready (${status}).`);
    }

    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
      lastError = new Error(`GET ${url} -> ${res.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  const cause = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out after ${readyTimeoutMs}ms waiting for AnySentry API at ${url}.${cause}`);
}

function startApi(port) {
  const displayEntry = path.relative(repoRoot, apiEntry);
  console.log(`Starting AnySentry API from ${displayEntry} on port ${port}`);

  apiChild = spawn(process.execPath, [apiEntry], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipeWithPrefix(apiChild.stdout, '[api] ');
  pipeWithPrefix(apiChild.stderr, '[api] ');

  apiChild.once('exit', (code, signal) => {
    apiExited = true;
    apiExitStatus = { code, signal };
  });

  return apiChild;
}

function runVerifier(verifierEntry, baseUrl, port) {
  return new Promise((resolve, reject) => {
    const displayEntry = path.relative(repoRoot, verifierEntry);
    console.log(`Running ${displayEntry} against ${baseUrl}`);
    const child = spawn(process.execPath, [verifierEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ANYSENTRY_API_BASE: baseUrl,
        PORT: String(port),
      },
      stdio: 'inherit',
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const status = signal ?? code ?? 'unknown';
      reject(new Error(`Deep-link verifier exited with ${status}.`));
    });
  });
}

function stopApi() {
  if (!apiChild || apiExited) return Promise.resolve();
  if (cleanupPromise) return cleanupPromise;

  cleanupPromise = new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      if (!apiExited) apiChild.kill('SIGKILL');
    }, 5000);
    killTimer.unref();

    apiChild.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });

    apiChild.kill('SIGTERM');
  });

  return cleanupPromise;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.error(`Received ${signal}; stopping temporary AnySentry API.`);
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    void stopApi().finally(() => process.exit(exitCode));
  });
}

process.once('exit', () => {
  if (apiChild && !apiExited) apiChild.kill('SIGTERM');
});

async function main() {
  await access(apiEntry).catch(() => {
    throw new Error(`Missing ${path.relative(repoRoot, apiEntry)}. Run pnpm build:api before this script.`);
  });
  for (const verifierEntry of verifierEntries) {
    await access(verifierEntry).catch(() => {
      throw new Error(`Missing verifier script ${path.relative(repoRoot, verifierEntry)}.`);
    });
  }

  const port = await choosePort();
  const baseUrl = `http://127.0.0.1:${port}/security-center`;
  startApi(port);
  await waitForReady(`${baseUrl}/stats`);
  console.log(`AnySentry API is ready at ${baseUrl}`);
  for (const verifierEntry of verifierEntries) {
    await runVerifier(verifierEntry, baseUrl, port);
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await stopApi();
}
