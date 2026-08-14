#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const supervisorPath = fileURLToPath(new URL('./observer-supervisor.js', import.meta.url));

function statePath(stateDir, role, suffix) {
  return path.join(stateDir, `${role}.${suffix}`);
}

function writeState(stateDir, role, suffix, value) {
  fs.writeFileSync(statePath(stateDir, role, suffix), String(value), 'utf8');
}

function appendSignal(stateDir, role, signal) {
  fs.appendFileSync(statePath(stateDir, role, 'signals'), `${signal}\n`, 'utf8');
}

function runFixture() {
  const role = process.argv[3];
  const mode = process.argv[4];
  const stateDir = process.argv[5];
  if (!['collector', 'forwarder'].includes(role) || !stateDir) process.exit(90);

  let finished = false;
  const finishForwarder = (reason) => {
    if (finished) return;
    finished = true;
    if (role === 'forwarder') writeState(stateDir, role, 'final', reason);
    process.exit(0);
  };
  const handleSignal = (signal) => {
    appendSignal(stateDir, role, signal);
    if (mode === 'stubborn') return;
    if (role === 'forwarder') finishForwarder(`signal:${signal}`);
    else process.stdout.write(`{"fixture":"collector-final","signal":"${signal}"}\n`, () => process.exit(0));
  };
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));

  if (role === 'forwarder') {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => {
      writeState(stateDir, role, 'input', input);
      if (mode === 'delayed-eof') {
        writeState(stateDir, role, 'eof', '1');
        setTimeout(() => finishForwarder('stdin-eof'), 200);
        return;
      }
      if (mode !== 'stubborn' && mode !== 'exit17' && mode !== 'exit0') finishForwarder('stdin-eof');
    });
  } else {
    process.stdout.on('error', () => process.exit(0));
    process.stdout.write('{"fixture":"collector-ready"}\n');
  }

  writeState(stateDir, role, 'pid', process.pid);
  writeState(stateDir, role, 'ready', '1');

  if (mode === 'exit42') setTimeout(() => process.exit(42), 25);
  if (mode === 'exit17') setTimeout(() => process.exit(17), 25);
  if (mode === 'exit0') setTimeout(() => process.exit(0), 25);
  setInterval(() => {}, 1_000);
}

if (process.argv[2] === '--fixture') {
  runFixture();
} else {
  const isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  };

  function processIdsWithMarker(marker) {
    const matches = [];
    for (const entry of fs.readdirSync('/proc', { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      try {
        const commandLine = fs.readFileSync(path.join('/proc', entry.name, 'cmdline'));
        if (commandLine.includes(Buffer.from(marker))) matches.push(Number(entry.name));
      } catch {}
    }
    return matches;
  }

  async function waitFor(check, timeoutMs, label) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(10);
    }
    throw new Error(`${label} timed out after ${timeoutMs} ms`);
  }

  async function within(promise, timeoutMs, label) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function readSignals(stateDir, role) {
    const file = statePath(stateDir, role, 'signals');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
  }

  async function runScenario({
    label,
    collectorMode,
    forwarderMode,
    signal,
    signalAfterState,
    aliveBeforeSignal = ['collector', 'forwarder'],
    signalDuringFirstSpawn = false,
    secondSignalAfterCollectorAck = false,
    missingRole,
    expectedReadyRoles = ['collector', 'forwarder'],
    collectorTimeoutMs = 300,
    shutdownTimeoutMs = 1_000,
    escapeTimeoutMs = 500,
    expectedCode,
    assertResult = () => {},
  }) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `anysentry-supervisor-${label}-`));
    const collectorCommand = missingRole === 'collector'
      ? path.join(stateDir, 'missing-collector')
      : process.execPath;
    const forwarderCommand = missingRole === 'forwarder'
      ? path.join(stateDir, 'missing-forwarder')
      : process.execPath;
    let supervisor;
    let resultPromise;
    let supervisorClosed = false;
    let collectorPid;
    let forwarderPid;
    let stderr = '';
    let actionAt;
    try {
      let nodeOptions = process.env.NODE_OPTIONS;
      if (signalDuringFirstSpawn) {
        const preloadPath = path.join(stateDir, 'signal-during-first-spawn.cjs');
        fs.writeFileSync(preloadPath, [
          "const childProcess = require('node:child_process');",
          'const originalSpawn = childProcess.spawn;',
          'let firstSpawn = true;',
          'childProcess.spawn = function patchedSpawn(...args) {',
          '  const child = originalSpawn.apply(this, args);',
          '  if (firstSpawn) {',
          '    firstSpawn = false;',
          "    process.emit('SIGTERM');",
          '  }',
          '  return child;',
          '};',
          '',
        ].join('\n'), 'utf8');
        nodeOptions = `--require=${preloadPath}`;
      }
      supervisor = spawn(process.execPath, [supervisorPath], {
        env: {
          ...process.env,
          ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }),
          OBSERVER_SUPERVISOR_COLLECTOR_COMMAND: collectorCommand,
          OBSERVER_SUPERVISOR_COLLECTOR_ARGS_JSON: JSON.stringify([
            scriptPath,
            '--fixture',
            'collector',
            collectorMode,
            stateDir,
          ]),
          OBSERVER_SUPERVISOR_FORWARDER_COMMAND: forwarderCommand,
          OBSERVER_SUPERVISOR_FORWARDER_ARGS_JSON: JSON.stringify([
            scriptPath,
            '--fixture',
            'forwarder',
            forwarderMode,
            stateDir,
          ]),
          OBSERVER_SUPERVISOR_COLLECTOR_TIMEOUT_MS: String(collectorTimeoutMs),
          OBSERVER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
          OBSERVER_SUPERVISOR_ESCAPE_TIMEOUT_MS: String(escapeTimeoutMs),
        },
        shell: false,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      supervisor.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      resultPromise = new Promise((resolve) => {
        supervisor.once('close', (code, exitSignal) => {
          supervisorClosed = true;
          resolve({ code, signal: exitSignal });
        });
      });

      await waitFor(
        () => expectedReadyRoles.every((role) => fs.existsSync(statePath(stateDir, role, 'ready'))),
        2_000,
        `${label} child readiness`,
      );
      if (fs.existsSync(statePath(stateDir, 'collector', 'pid'))) {
        collectorPid = Number(fs.readFileSync(statePath(stateDir, 'collector', 'pid'), 'utf8'));
      }
      if (fs.existsSync(statePath(stateDir, 'forwarder', 'pid'))) {
        forwarderPid = Number(fs.readFileSync(statePath(stateDir, 'forwarder', 'pid'), 'utf8'));
      }

      if (signalAfterState) {
        await waitFor(
          () => fs.existsSync(statePath(stateDir, signalAfterState.role, signalAfterState.suffix)),
          2_000,
          `${label} ${signalAfterState.role}.${signalAfterState.suffix}`,
        );
      }
      if (signal) {
        const rolePids = { collector: collectorPid, forwarder: forwarderPid };
        for (const role of aliveBeforeSignal) {
          assert.ok(isAlive(rolePids[role]), `${label}: ${role} must be alive before the signal`);
        }
        actionAt = Date.now();
        assert.equal(supervisor.kill(signal), true, `${label}: failed to signal only the supervisor`);
        if (secondSignalAfterCollectorAck) {
          await waitFor(
            () => readSignals(stateDir, 'collector').includes(signal),
            1_000,
            `${label} collector signal acknowledgement`,
          );
          supervisor.kill(signal);
        }
      }

      const result = await within(
        resultPromise,
        shutdownTimeoutMs + escapeTimeoutMs + 2_000,
        `${label} supervisor: ${stderr}`,
      );
      const elapsedMs = Date.now() - (actionAt ?? Date.now());
      assert.deepEqual(result, { code: expectedCode, signal: null }, `${label}: ${stderr}`);
      if (collectorPid) assert.equal(isAlive(collectorPid), false, `${label}: collector PID ${collectorPid} leaked`);
      if (forwarderPid) assert.equal(isAlive(forwarderPid), false, `${label}: forwarder PID ${forwarderPid} leaked`);
      assert.deepEqual(processIdsWithMarker(stateDir), [], `${label}: a fixture process still references its state directory`);
      await assertResult({ stateDir, elapsedMs, stderr, collectorPid, forwarderPid });
    } finally {
      if (supervisor && !supervisorClosed) supervisor.kill('SIGKILL');
      if (resultPromise && !supervisorClosed) {
        await within(resultPromise, 500, `${label} supervisor cleanup`).catch(() => {});
      }
      const cleanupPids = new Set([
        collectorPid,
        forwarderPid,
        ...processIdsWithMarker(stateDir),
      ]);
      for (const pid of cleanupPids) {
        if (!Number.isSafeInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
      await waitFor(
        () => processIdsWithMarker(stateDir).length === 0,
        500,
        `${label} fixture cleanup`,
      ).catch(() => {});
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  }

  const supervisorSource = fs.readFileSync(supervisorPath, 'utf8');
  assert.ok(
    supervisorSource.indexOf("process.on('SIGTERM'") < supervisorSource.indexOf('collector = spawn('),
    'SIGTERM handler must be installed before the collector is spawned',
  );
  assert.ok(
    supervisorSource.indexOf("process.on('SIGINT'") < supervisorSource.indexOf('collector = spawn('),
    'SIGINT handler must be installed before the collector is spawned',
  );

  await runScenario({
    label: 'signal-during-first-spawn',
    collectorMode: 'wait',
    forwarderMode: 'graceful',
    signalDuringFirstSpawn: true,
    expectedReadyRoles: ['forwarder'],
    expectedCode: 143,
    assertResult: ({ stateDir }) => {
      assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
    },
  });

  for (let iteration = 0; iteration < 10; iteration++) {
    await runScenario({
      label: `term-${iteration}`,
      collectorMode: 'wait',
      forwarderMode: 'graceful',
      signal: 'SIGTERM',
      expectedCode: 143,
      assertResult: ({ stateDir }) => {
        assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGTERM']);
        assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
        assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
        assert.match(fs.readFileSync(statePath(stateDir, 'forwarder', 'input'), 'utf8'), /collector-final/u);
      },
    });
  }

  await runScenario({
    label: 'interrupt',
    collectorMode: 'wait',
    forwarderMode: 'graceful',
    signal: 'SIGINT',
    expectedCode: 130,
    assertResult: ({ stateDir }) => {
      assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGINT']);
      assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
      assert.match(fs.readFileSync(statePath(stateDir, 'forwarder', 'input'), 'utf8'), /collector-final/u);
    },
  });

  await runScenario({
    label: 'collector-42',
    collectorMode: 'exit42',
    forwarderMode: 'graceful',
    expectedCode: 42,
    assertResult: ({ stateDir }) => {
      assert.equal(readSignals(stateDir, 'forwarder').length, 0);
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
    },
  });

  await runScenario({
    label: 'collector-42-remains-primary-after-term',
    collectorMode: 'exit42',
    forwarderMode: 'delayed-eof',
    signal: 'SIGTERM',
    signalAfterState: { role: 'forwarder', suffix: 'eof' },
    aliveBeforeSignal: ['forwarder'],
    expectedCode: 42,
    assertResult: ({ stateDir }) => {
      assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
    },
  });

  await runScenario({
    label: 'forwarder-17',
    collectorMode: 'wait',
    forwarderMode: 'exit17',
    expectedCode: 17,
    assertResult: ({ stateDir }) => {
      assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGTERM']);
    },
  });

  await runScenario({
    label: 'forwarder-zero-while-collector-running',
    collectorMode: 'wait',
    forwarderMode: 'exit0',
    expectedCode: 1,
    assertResult: ({ stateDir }) => {
      assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGTERM']);
    },
  });

  await runScenario({
    label: 'missing-collector',
    collectorMode: 'wait',
    forwarderMode: 'graceful',
    missingRole: 'collector',
    expectedReadyRoles: ['forwarder'],
    expectedCode: 127,
    assertResult: ({ stateDir }) => {
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
    },
  });

  await runScenario({
    label: 'missing-forwarder',
    collectorMode: 'wait',
    forwarderMode: 'graceful',
    missingRole: 'forwarder',
    expectedReadyRoles: [],
    expectedCode: 127,
  });

  await runScenario({
    label: 'non-external-timeout',
    collectorMode: 'exit0',
    forwarderMode: 'stubborn',
    shutdownTimeoutMs: 200,
    expectedCode: 124,
  });

  await runScenario({
    label: 'forced-kill',
    collectorMode: 'stubborn',
    forwarderMode: 'graceful',
    signal: 'SIGTERM',
    collectorTimeoutMs: 200,
    shutdownTimeoutMs: 1_000,
    escapeTimeoutMs: 500,
    expectedCode: 143,
    assertResult: ({ stateDir, elapsedMs }) => {
      assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGTERM']);
      assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
      assert.equal(fs.readFileSync(statePath(stateDir, 'forwarder', 'final'), 'utf8'), 'stdin-eof');
      assert.ok(elapsedMs >= 180, `forced shutdown escaped its grace period after ${elapsedMs} ms`);
      assert.ok(elapsedMs < 1_500, `forced shutdown exceeded its bound after ${elapsedMs} ms`);
    },
  });

  await runScenario({
    label: 'second-signal-forces',
    collectorMode: 'stubborn',
    forwarderMode: 'stubborn',
    signal: 'SIGTERM',
    secondSignalAfterCollectorAck: true,
    collectorTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    expectedCode: 143,
    assertResult: ({ stateDir, elapsedMs }) => {
      assert.deepEqual(readSignals(stateDir, 'collector'), ['SIGTERM']);
      assert.deepEqual(readSignals(stateDir, 'forwarder'), []);
      assert.ok(elapsedMs < 700, `second signal did not force shutdown: ${elapsedMs} ms`);
    },
  });

  console.log('Observer PID1 supervisor lifecycle verification passed');
}
