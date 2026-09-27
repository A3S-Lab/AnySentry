#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, '..');
const piLoopPath = path.join(repositoryRoot, 'examples/agent-runtime-lab/app/pi-loop.mjs');
const piMarkerHelperPath = path.join(repositoryRoot, 'examples/agent-runtime-lab/app/pi-e2e-marker.sh');
const entrypointPath = path.join(repositoryRoot, 'examples/agent-runtime-lab/entrypoint.sh');
const activeProcessGroups = new Set();

let assertionCount = 0;

function expect(condition, message) {
  assertionCount += 1;
  if (!condition) throw new Error(message);
}

function expectEqual(actual, expected, message) {
  expect(Object.is(actual, expected), message);
}

function commandSucceeded(result, description) {
  expect(result.error === undefined, `${description}: command could not be started`);
  expectEqual(result.status, 0, `${description}: command failed`);
}

function extractNamedFunction(source, functionName) {
  const marker = `function ${functionName}(`;
  const start = source.indexOf(marker);
  expect(start >= 0, `${functionName} must remain a named function`);

  const openingBrace = source.indexOf('{', start);
  expect(openingBrace >= 0, `${functionName} must have a function body`);

  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${functionName} function body is incomplete`);
}

function cleanRuntimeEnvironment(overrides = {}) {
  return {
    HOME: process.env.HOME || os.tmpdir(),
    LANG: 'C.UTF-8',
    PATH: process.env.PATH || '/usr/bin:/bin',
    ...overrides,
  };
}

function spawnRuntime(piFixturePath, workspace, overrides = {}) {
  const child = spawn(process.execPath, [piFixturePath], {
    detached: true,
    env: cleanRuntimeEnvironment({
      AGENT_ID: 'runtime-contract-agent',
      AGENT_WORKSPACE: workspace,
      PI_EXECUTION_MODE: 'loop',
      ...overrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeProcessGroups.add(child.pid);

  let stdout = '';
  let stderr = '';
  const outputLimit = 1024 * 1024;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout = `${stdout}${chunk}`.slice(-outputLimit);
  });
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-outputLimit);
  });
  child.once('exit', () => activeProcessGroups.delete(child.pid));

  return {
    child,
    output: () => ({ stdout, stderr }),
  };
}

function parseRuntimeEvents(stdout) {
  return stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event && typeof event === 'object' ? [event] : [];
      } catch {
        return [];
      }
    });
}

async function waitFor(predicate, runtime, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(runtime.output())) return;
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`${description}: runtime exited before the expected observation`);
    }
    await sleep(25);
  }
  throw new Error(`${description}: timed out`);
}

async function waitForExit(child, timeoutMs, description) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await Promise.race([
    new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    sleep(timeoutMs).then(() => {
      throw new Error(`${description}: process did not exit`);
    }),
  ]);
}

function signalRuntime(runtime, signal = 'SIGTERM') {
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill(signal);
  }
}

function forceKillProcessGroup(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function makePiFixture(tempRoot, fakePiSource) {
  const fixtureRoot = await mkdtemp(path.join(tempRoot, 'pi-fixture-'));
  const fixtureAppDir = path.join(fixtureRoot, 'app');
  const fixtureBinDir = path.join(fixtureRoot, 'node_modules/.bin');
  const workspace = path.join(fixtureRoot, 'workspace');
  await mkdir(fixtureAppDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const fixturePiLoop = path.join(fixtureAppDir, 'pi-loop.mjs');
  await copyFile(piLoopPath, fixturePiLoop, fsConstants.COPYFILE_EXCL);

  if (fakePiSource !== undefined) {
    await mkdir(fixtureBinDir, { recursive: true });
    const fakePiPath = path.join(fixtureBinDir, 'pi');
    await writeFile(fakePiPath, fakePiSource, { encoding: 'utf8', mode: 0o700 });
    await chmod(fakePiPath, 0o700);
  }

  return { fixturePiLoop, fixtureRoot, workspace };
}

async function verifySourceContracts(piSource, markerHelperSource, entrypointSource) {
  const nodeSyntax = spawnSync(process.execPath, ['--check', piLoopPath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  commandSucceeded(nodeSyntax, 'pi-loop Node syntax check');

  const markerHelperSyntax = spawnSync('/bin/sh', ['-n', piMarkerHelperPath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  commandSucceeded(markerHelperSyntax, 'Pi E2E marker helper POSIX shell syntax check');

  const shellSyntax = spawnSync('/bin/sh', ['-n', entrypointPath], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  commandSucceeded(shellSyntax, 'entrypoint POSIX shell syntax check');

  const combinedSource = `${piSource}\n${markerHelperSource}\n${entrypointSource}`;
  expect(!/models\.deepseek/i.test(combinedSource), 'runtime entry files must not reference models.deepseek');
  expect(!/models\.json/i.test(combinedSource), 'runtime entry files must not install a custom models.json');
  expect(!/\b(?:copyFile|cp)\b[\s\S]{0,160}models/i.test(combinedSource), 'runtime entry files must not copy custom model configuration');

  const durationFunctionSource = extractNamedFunction(piSource, 'durationMs');
  const durationMs = Function(`"use strict"; ${durationFunctionSource}; return durationMs;`)();
  const cases = [
    { value: undefined, fallback: 60, min: 1, max: 86_400, expected: 60_000 },
    { value: 'not-a-number', fallback: 10, min: 1, max: 3_600, expected: 10_000 },
    { value: Number.POSITIVE_INFINITY, fallback: 90, min: 10, max: 3_600, expected: 90_000 },
    { value: '-500', fallback: 60, min: 1, max: 86_400, expected: 1_000 },
    { value: '999999999', fallback: 60, min: 1, max: 86_400, expected: 86_400_000 },
    { value: '1.2345', fallback: 60, min: 1, max: 86_400, expected: 1_235 },
  ];
  for (const testCase of cases) {
    const actual = durationMs(testCase.value, testCase.fallback, testCase.min, testCase.max);
    expect(Number.isFinite(actual), 'duration parser result must be finite');
    expect(actual >= testCase.min * 1_000, 'duration parser result must honor its lower bound');
    expect(actual <= testCase.max * 1_000, 'duration parser result must honor its upper bound');
    expectEqual(actual, testCase.expected, 'duration parser returned an unexpected value');
  }

  expect(/durationMs\(process\.env\.AGENT_INTERVAL_SECONDS,\s*60,\s*1,\s*86_400\)/.test(piSource), 'agent interval must use explicit finite bounds');
  expect(/durationMs\(process\.env\.PI_RETRY_SECONDS,\s*10,\s*1,\s*3_600\)/.test(piSource), 'retry interval must use explicit finite bounds');
  expect(/durationMs\(process\.env\.PI_TURN_TIMEOUT_SECONDS,\s*90,\s*10,\s*3_600\)/.test(piSource), 'turn timeout must use explicit finite bounds');
}

async function verifyPiMarkerHelper(tempRoot) {
  const fixture = await mkdtemp(path.join(tempRoot, 'pi-marker-helper-'));
  const workspace = path.join(fixture, 'workspace');
  const markerFile = path.join(fixture, 'marker');
  const marker = `asel-marker-contract-${process.pid}`;
  await mkdir(workspace, { mode: 0o700 });

  const execute = () => spawnSync('/bin/sh', [piMarkerHelperPath], {
    encoding: 'utf8',
    env: cleanRuntimeEnvironment({
      AGENT_WORKSPACE: workspace,
      PI_E2E_MARKER_FILE: markerFile,
    }),
    timeout: 10_000,
  });

  await writeFile(markerFile, `${marker}\n`, { encoding: 'utf8', mode: 0o600 });
  commandSucceeded(execute(), 'Pi E2E marker helper valid marker');
  expectEqual(await readFile(path.join(workspace, 'tool-events.log'), 'utf8'), `${marker}\n`, 'marker helper must preserve the exact marker in its proof file');

  const gatedWorkspace = path.join(fixture, 'gated-workspace');
  const releaseFile = path.join(fixture, 'release');
  await mkdir(gatedWorkspace, { mode: 0o700 });
  const gated = spawn('/bin/sh', [piMarkerHelperPath], {
    env: cleanRuntimeEnvironment({
      AGENT_WORKSPACE: gatedWorkspace,
      PI_E2E_MARKER_FILE: markerFile,
      PI_E2E_RELEASE_FILE: releaseFile,
    }),
    stdio: 'ignore',
  });
  try {
    await sleep(250);
    expectEqual(gated.exitCode, null, 'marker helper must wait until the runtime release gate opens');
    let proofExists = true;
    try {
      await stat(path.join(gatedWorkspace, 'tool-events.log'));
    } catch (error) {
      if (error?.code === 'ENOENT') proofExists = false;
      else throw error;
    }
    expectEqual(proofExists, false, 'marker helper must not emit the marker before runtime release');
    await writeFile(releaseFile, 'go\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    let heldArgv;
    const argvDeadline = Date.now() + 2_000;
    while (Date.now() < argvDeadline) {
      try {
        const argv = (await readFile(`/proc/${gated.pid}/cmdline`))
          .toString('utf8').split('\0').filter(Boolean);
        if (argv[0] === '/bin/sh' && argv[1] === '-c') {
          heldArgv = argv;
          break;
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await sleep(25);
    }
    expectEqual(
      JSON.stringify(heldArgv),
      JSON.stringify(['/bin/sh', '-c', '/bin/sleep 3;:', marker]),
      'marker helper must expose the exact held ToolExec argv contract',
    );
    const gatedExit = await waitForExit(gated, 10_000, 'released Pi marker helper');
    expectEqual(gatedExit.code, 0, 'released marker helper must exit successfully');
    expectEqual(
      await readFile(path.join(gatedWorkspace, 'tool-events.log'), 'utf8'),
      `${marker}\n`,
      'released marker helper must preserve the exact marker',
    );
  } finally {
    if (gated.exitCode === null && gated.signalCode === null) gated.kill('SIGKILL');
  }

  const invalidRelease = path.join(fixture, 'invalid-release');
  await writeFile(invalidRelease, 'not-go\n', { encoding: 'utf8', mode: 0o600 });
  const invalidReleaseResult = spawnSync('/bin/sh', [piMarkerHelperPath], {
    encoding: 'utf8',
    env: cleanRuntimeEnvironment({
      AGENT_WORKSPACE: gatedWorkspace,
      PI_E2E_MARKER_FILE: markerFile,
      PI_E2E_RELEASE_FILE: invalidRelease,
    }),
    timeout: 5_000,
  });
  expectEqual(invalidReleaseResult.status, 65, 'marker helper must reject an invalid release gate');

  const unterminatedExtraRelease = path.join(fixture, 'unterminated-extra-release');
  await writeFile(unterminatedExtraRelease, 'go\ntrailing', { encoding: 'utf8', mode: 0o600 });
  const unterminatedExtraReleaseResult = spawnSync('/bin/sh', [piMarkerHelperPath], {
    encoding: 'utf8',
    env: cleanRuntimeEnvironment({
      AGENT_WORKSPACE: gatedWorkspace,
      PI_E2E_MARKER_FILE: markerFile,
      PI_E2E_RELEASE_FILE: unterminatedExtraRelease,
    }),
    timeout: 5_000,
  });
  expectEqual(
    unterminatedExtraReleaseResult.status,
    65,
    'marker helper must reject an unterminated second release-gate line',
  );

  await writeFile(markerFile, '', { encoding: 'utf8', mode: 0o600 });
  expectEqual(execute().status, 65, 'marker helper must reject an empty marker file');

  await writeFile(markerFile, 'first-line\nsecond-line\n', { encoding: 'utf8', mode: 0o600 });
  expectEqual(execute().status, 65, 'marker helper must reject a multi-line marker file');

  await writeFile(markerFile, 'first-line\nsecond-line', { encoding: 'utf8', mode: 0o600 });
  expectEqual(execute().status, 65, 'marker helper must reject an unterminated second marker line');

  await writeFile(markerFile, 'contains_underscore\n', { encoding: 'utf8', mode: 0o600 });
  expectEqual(execute().status, 65, 'marker helper must reject characters outside the safe alphabet');

  await writeFile(markerFile, `${'a'.repeat(161)}\n`, { encoding: 'utf8', mode: 0o600 });
  expectEqual(execute().status, 65, 'marker helper must reject an overlong marker');

  const markerHelperSource = await readFile(piMarkerHelperPath, 'utf8');
  expect(markerHelperSource.includes("exec /bin/sh -c '/bin/sleep 3;:' \"$marker\""), 'marker helper must hold the marker-bearing exec for ancestry resolution');
}

async function verifySpawnErrorRetries(tempRoot) {
  const fixture = await makePiFixture(tempRoot);
  const runtime = spawnRuntime(fixture.fixturePiLoop, fixture.workspace, {
    PI_RETRY_SECONDS: '1',
    PI_TURN_TIMEOUT_SECONDS: '10',
  });

  try {
    await waitFor(({ stdout }) => {
      const events = parseRuntimeEvents(stdout);
      return events.filter((event) => event.event === 'pi_process_error').length >= 2
        && events.some((event) => event.event === 'pi_retry_scheduled' && event.code === 127);
    }, runtime, 5_000, 'spawn error retry contract');

    const events = parseRuntimeEvents(runtime.output().stdout);
    expect(events.filter((event) => event.event === 'pi_process_error').length >= 2, 'spawn errors must settle and permit a later retry');
    expect(events.some((event) => event.event === 'pi_retry_scheduled' && event.code === 127), 'spawn errors must be converted to the bounded retry path');

    signalRuntime(runtime);
    const result = await waitForExit(runtime.child, 2_000, 'spawn error runtime shutdown');
    expectEqual(result.code, 0, 'spawn error runtime must shut down cleanly');
  } finally {
    forceKillProcessGroup(runtime.child.pid);
  }
}

async function verifySignalInterruptsLongDelay(tempRoot) {
  const fixture = await makePiFixture(tempRoot);
  const runtime = spawnRuntime(fixture.fixturePiLoop, fixture.workspace, {
    PI_RETRY_SECONDS: '3600',
    PI_TURN_TIMEOUT_SECONDS: '10',
  });

  try {
    await waitFor(({ stdout }) => parseRuntimeEvents(stdout)
      .some((event) => event.event === 'pi_retry_scheduled' && event.retrySeconds === 3_600), runtime, 3_000, 'long retry delay setup');

    const shutdownStartedAt = Date.now();
    signalRuntime(runtime);
    const result = await waitForExit(runtime.child, 1_500, 'SIGTERM delay interruption');
    const shutdownElapsedMs = Date.now() - shutdownStartedAt;
    expectEqual(result.code, 0, 'SIGTERM during retry delay must shut down cleanly');
    expect(shutdownElapsedMs < 1_500, 'SIGTERM must wake a long retry delay immediately');

    const events = parseRuntimeEvents(runtime.output().stdout);
    expect(events.some((event) => event.event === 'shutdown_requested' && event.signal === 'SIGTERM'), 'runtime must observe SIGTERM while delayed');
  } finally {
    forceKillProcessGroup(runtime.child.pid);
  }
}

async function verifyTimeoutForceKill(tempRoot) {
  const fakePiSource = `#!/usr/bin/env node
process.on('SIGTERM', () => {});
setInterval(() => {}, 1_000);
`;
  const fixture = await makePiFixture(tempRoot, fakePiSource);
  const runtime = spawnRuntime(fixture.fixturePiLoop, fixture.workspace, {
    PI_RETRY_SECONDS: '3600',
    PI_TURN_TIMEOUT_SECONDS: '10',
  });

  try {
    await waitFor(({ stdout }) => {
      const events = parseRuntimeEvents(stdout);
      return events.some((event) => event.event === 'pi_process_timeout')
        && events.some((event) => event.event === 'pi_process_exited' && event.signal === 'SIGKILL')
        && events.some((event) => event.event === 'pi_retry_scheduled' && event.code === 124);
    }, runtime, 16_000, 'timeout SIGKILL fallback');

    const events = parseRuntimeEvents(runtime.output().stdout);
    expect(events.some((event) => event.event === 'pi_process_timeout' && event.timeoutSeconds === 10), 'turn timeout must fire at the configured lower bound');
    expect(events.some((event) => event.event === 'pi_process_exited' && event.signal === 'SIGKILL'), 'a child ignoring SIGTERM must receive SIGKILL');
    expect(events.some((event) => event.event === 'pi_retry_scheduled' && event.code === 124), 'a timed-out turn must settle with code 124 and enter retry delay');

    signalRuntime(runtime);
    const result = await waitForExit(runtime.child, 1_500, 'timeout runtime shutdown');
    expectEqual(result.code, 0, 'runtime must shut down after the timeout path settles');
  } finally {
    forceKillProcessGroup(runtime.child.pid);
  }
}

async function verifyEntrypointSecretFile(tempRoot) {
  const missingSecret = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: cleanRuntimeEnvironment({
      AGENT_RUNTIME: 'pi',
      DEEPSEEK_API_KEY_FILE: path.join(tempRoot, 'does-not-exist'),
    }),
    timeout: 5_000,
  });
  expectEqual(missingSecret.status, 78, 'entrypoint must fail with EX_CONFIG when the secret file is missing');
  expect(missingSecret.stderr.includes('DEEPSEEK_API_KEY_FILE is not readable'), 'missing secret failure must be diagnosable');

  const secretFixture = await mkdtemp(path.join(tempRoot, 'entrypoint-secret-'));
  const fakeBinDir = path.join(secretFixture, 'bin');
  const secretFile = path.join(secretFixture, 'deepseek-key');
  const captureFile = path.join(secretFixture, 'captured-key');
  const fakeNode = path.join(fakeBinDir, 'node');
  const secretValue = `contract-secret-${process.pid}-${Date.now()}`;
  await mkdir(fakeBinDir, { recursive: true });
  await writeFile(secretFile, `${secretValue}\r\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(secretFile, 0o600);
  await writeFile(fakeNode, `#!/bin/sh
set -eu
[ "$1" = "/opt/agent-lab/app/pi-loop.mjs" ]
umask 077
printf '%s' "$DEEPSEEK_API_KEY" > "$CONTRACT_CAPTURE_FILE"
byte_count="$(printf '%s' "$DEEPSEEK_API_KEY" | wc -c | tr -d ' ')"
printf 'observable-child secret-present bytes=%s\\n' "$byte_count"
`, { encoding: 'utf8', mode: 0o700 });
  await chmod(fakeNode, 0o700);

  const secretMode = (await stat(secretFile)).mode & 0o777;
  expectEqual(secretMode, 0o600, 'secret fixture must be mode 0600');

  const observedSecret = spawnSync('/bin/sh', [entrypointPath], {
    encoding: 'utf8',
    env: cleanRuntimeEnvironment({
      AGENT_RUNTIME: 'pi',
      CONTRACT_CAPTURE_FILE: captureFile,
      DEEPSEEK_API_KEY_FILE: secretFile,
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
    }),
    timeout: 5_000,
  });
  commandSucceeded(observedSecret, 'entrypoint secret handoff');
  expect(observedSecret.stdout.includes('observable-child secret-present bytes='), 'replaceable child must provide non-secret observability');
  expect(!observedSecret.stdout.includes(secretValue), 'entrypoint or child stdout must not print the secret value');
  expect(!observedSecret.stderr.includes(secretValue), 'entrypoint or child stderr must not print the secret value');

  const capturedSecret = await readFile(captureFile, 'utf8');
  expect(capturedSecret === secretValue, 'entrypoint must trim line endings and export the exact secret to its child');
  const captureMode = (await stat(captureFile)).mode & 0o777;
  expectEqual(captureMode, 0o600, 'observable child capture must remain mode 0600');
}

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'anysentry-agent-runtime-lab-contract-'));
  try {
    const [piSource, markerHelperSource, entrypointSource] = await Promise.all([
      readFile(piLoopPath, 'utf8'),
      readFile(piMarkerHelperPath, 'utf8'),
      readFile(entrypointPath, 'utf8'),
    ]);
    await verifySourceContracts(piSource, markerHelperSource, entrypointSource);
    await verifyPiMarkerHelper(tempRoot);
    await verifySpawnErrorRetries(tempRoot);
    await verifySignalInterruptsLongDelay(tempRoot);
    await verifyTimeoutForceKill(tempRoot);
    await verifyEntrypointSecretFile(tempRoot);

    process.stdout.write(`${JSON.stringify({
      status: 'passed',
      assertions: assertionCount,
      networkUsed: false,
      targets: [
        path.relative(repositoryRoot, piLoopPath),
        path.relative(repositoryRoot, piMarkerHelperPath),
        path.relative(repositoryRoot, entrypointPath),
      ],
    })}\n`);
  } finally {
    for (const pid of activeProcessGroups) forceKillProcessGroup(pid);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`agent runtime lab contract verification failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
