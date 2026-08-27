#!/usr/bin/env node
// PID 1 for the Observer wrapper image. It connects the collector to the forwarder without a
// shell, preserves stream backpressure, and owns both child lifecycles.
const { spawn } = require('node:child_process');
const os = require('node:os');

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 20_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 25_000;
const DEFAULT_COLLECTOR_TIMEOUT_MS = 3_000;
const DEFAULT_ESCAPE_TIMEOUT_MS = 1_000;

function boundedMilliseconds(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback;
}

function configuredCommand(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const command = value.trim();
  if (!command || command.length > 4_096 || command.includes('\0')) {
    throw new Error(`${name} must be a non-empty direct executable path`);
  }
  return command;
}

function configuredArgs(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return [...fallback];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (
    !Array.isArray(parsed) || parsed.length > 128
    || parsed.some((item) => typeof item !== 'string' || item.length > 32_768 || item.includes('\0'))
  ) {
    throw new Error(`${name} must be a JSON string array with at most 128 bounded arguments`);
  }
  return parsed;
}

function signalExitCode(signal) {
  const number = os.constants.signals[signal];
  return Number.isSafeInteger(number) ? 128 + number : 1;
}

function main() {
  let collectorConfig;
  let forwarderConfig;
  try {
    collectorConfig = {
      command: configuredCommand('OBSERVER_SUPERVISOR_COLLECTOR_COMMAND', 'a3s-observer-collector'),
      args: configuredArgs('OBSERVER_SUPERVISOR_COLLECTOR_ARGS_JSON', []),
    };
    forwarderConfig = {
      command: configuredCommand('OBSERVER_SUPERVISOR_FORWARDER_COMMAND', process.execPath),
      args: configuredArgs('OBSERVER_SUPERVISOR_FORWARDER_ARGS_JSON', ['/opt/observer-forward.js']),
    };
  } catch (error) {
    console.error(`[observer-supervisor] invalid configuration: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const shutdownTimeoutMs = boundedMilliseconds(
    process.env.OBSERVER_SUPERVISOR_SHUTDOWN_TIMEOUT_MS,
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    100,
    MAX_SHUTDOWN_TIMEOUT_MS,
  );
  const collectorTimeoutMs = boundedMilliseconds(
    process.env.OBSERVER_SUPERVISOR_COLLECTOR_TIMEOUT_MS,
    DEFAULT_COLLECTOR_TIMEOUT_MS,
    100,
    5_000,
  );
  const escapeTimeoutMs = boundedMilliseconds(
    process.env.OBSERVER_SUPERVISOR_ESCAPE_TIMEOUT_MS,
    DEFAULT_ESCAPE_TIMEOUT_MS,
    100,
    2_000,
  );

  let collector;
  let forwarder;
  let states;
  let firstExternalSignal;
  let externalSignalCount = 0;
  let primaryOutcome;
  let startupComplete = false;
  const pendingExternalSignals = [];
  let shutdownStarted = false;
  let shutdownTimer;
  let collectorTimer;
  let escapeTimer;
  let finalized = false;
  let forcedKill = false;
  let forcing = false;
  let pipelineFailed = false;

  function latchOutcome(code, kind) {
    if (primaryOutcome) return false;
    primaryOutcome = { code, kind };
    return true;
  }

  function resolvedExitCode() {
    return primaryOutcome?.code ?? (forcedKill ? 124 : 0);
  }

  function rememberOutcome(state, code, signal) {
    if (primaryOutcome) return;
    if (Number.isInteger(code) && code !== 0 && state.supervisorSignals.size === 0) {
      latchOutcome(code > 0 && code <= 255 ? code : 1, `${state.role}-exit`);
      return;
    }
    if (signal && !state.supervisorSignals.has(signal)) {
      latchOutcome(signalExitCode(signal), `${state.role}-signal`);
    }
  }

  function signalChild(state, signal) {
    if (state.exited || state.closed) return false;
    try {
      const sent = state.child.kill(signal);
      if (sent) state.supervisorSignals.add(signal);
      return sent;
    } catch (error) {
      console.error(`[observer-supervisor] could not signal ${state.role}: ${error.message}`);
      return false;
    }
  }

  function forceChildren() {
    if (forcing) return;
    forcing = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
    if (collectorTimer) clearTimeout(collectorTimer);
    collectorTimer = undefined;
    forcedKill = true;
    latchOutcome(124, 'shutdown-timeout');
    for (const state of Object.values(states)) signalChild(state, 'SIGKILL');
    escapeTimer = setTimeout(() => {
      const open = Object.values(states).filter((state) => !state.closed).map((state) => state.role);
      if (open.length) {
        console.error(`[observer-supervisor] final escape with unclosed children: ${open.join(',')}`);
      }
      process.exit(resolvedExitCode());
    }, escapeTimeoutMs);
  }

  function beginShutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    shutdownTimer = setTimeout(forceChildren, shutdownTimeoutMs);
  }

  function scheduleCollectorForce() {
    if (collectorTimer || states.collector.exited || states.collector.closed) return;
    collectorTimer = setTimeout(() => {
      collectorTimer = undefined;
      forcedKill = true;
      signalChild(states.collector, 'SIGKILL');
    }, collectorTimeoutMs);
  }

  function maybeFinalize() {
    if (finalized || !states.collector.closed || !states.forwarder.closed) return;
    finalized = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (collectorTimer) clearTimeout(collectorTimer);
    if (escapeTimer) clearTimeout(escapeTimer);
    collector.stdout?.unpipe(forwarder.stdin);
    if (forwarder.stdin && !forwarder.stdin.destroyed) forwarder.stdin.destroy();
    process.exitCode = resolvedExitCode();
  }

  function childExited(state, code, signal) {
    if (state.exited) return;
    const collectorWasRunning = !states.collector.exited && !states.collector.closed;
    state.exited = true;
    rememberOutcome(state, code, signal);
    if (
      state.role === 'forwarder' && !firstExternalSignal && collectorWasRunning
      && code === 0 && primaryOutcome === undefined
    ) {
      // A healthy forwarder can only finish after collector EOF. Exiting first silently disables
      // observation and must not make the wrapper look healthy.
      latchOutcome(1, 'forwarder-early-exit');
    }
    beginShutdown();
    if (state.role === 'forwarder') {
      if (!firstExternalSignal) {
        // Deliver the lifecycle signal before tearing down the failed pipeline. Otherwise the
        // collector can observe stdout closure and exit first, making orderly shutdown depend on
        // a stream-error race rather than the supervisor-owned signal path.
        signalChild(states.collector, 'SIGTERM');
        scheduleCollectorForce();
      }
      collector.stdout?.unpipe(forwarder.stdin);
      if (forwarder.stdin && !forwarder.stdin.destroyed) forwarder.stdin.destroy();
    }
  }

  function childErrored(state, error) {
    console.error(`[observer-supervisor] ${state.role} process error: ${error.message}`);
    if (!firstExternalSignal) {
      const code = error.code === 'ENOENT'
        ? 127
        : error.code === 'EACCES' || error.code === 'EPERM'
          ? 126
          : 1;
      latchOutcome(code, `${state.role}-spawn-error`);
    }
    beginShutdown();
    if (state.role === 'forwarder' && !firstExternalSignal) {
      signalChild(states.collector, 'SIGTERM');
      scheduleCollectorForce();
    }
  }

  function childClosed(state, code, signal) {
    if (!state.exited) childExited(state, code, signal);
    state.closed = true;
    if (state.role === 'collector' && collectorTimer) {
      clearTimeout(collectorTimer);
      collectorTimer = undefined;
    }
    maybeFinalize();
  }

  function pipelineErrored(error) {
    if (pipelineFailed || states.forwarder.exited || states.forwarder.closed || finalized) return;
    pipelineFailed = true;
    console.error(`[observer-supervisor] collector-forwarder stream error: ${error.message}`);
    latchOutcome(1, 'pipeline-error');
    beginShutdown();
    if (!firstExternalSignal) {
      signalChild(states.collector, 'SIGTERM');
      scheduleCollectorForce();
    }
    collector.stdout?.unpipe(forwarder.stdin);
    if (forwarder.stdin && !forwarder.stdin.destroyed) forwarder.stdin.destroy();
  }
  function processExternalSignal(signal) {
    externalSignalCount += 1;
    if (externalSignalCount > 1) {
      forceChildren();
      return;
    }
    firstExternalSignal = signal;
    latchOutcome(signalExitCode(signal), 'external-signal');
    beginShutdown();
    signalChild(states.collector, signal);
    scheduleCollectorForce();
  }

  function handleExternalSignal(signal) {
    if (!startupComplete) {
      pendingExternalSignals.push(signal);
      return;
    }
    processExternalSignal(signal);
  }

  // Install handlers before either child is spawned. A signal delivered during the synchronous
  // startup section is queued until both child states and the pipe are owned by the supervisor.
  process.on('SIGTERM', () => handleExternalSignal('SIGTERM'));
  process.on('SIGINT', () => handleExternalSignal('SIGINT'));

  collector = spawn(collectorConfig.command, collectorConfig.args, {
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  forwarder = spawn(forwarderConfig.command, forwarderConfig.args, {
    env: process.env,
    shell: false,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  states = {
    collector: {
      role: 'collector',
      child: collector,
      exited: false,
      closed: false,
      supervisorSignals: new Set(),
    },
    forwarder: {
      role: 'forwarder',
      child: forwarder,
      exited: false,
      closed: false,
      supervisorSignals: new Set(),
    },
  };
  for (const state of Object.values(states)) {
    state.child.once('error', (error) => childErrored(state, error));
    state.child.once('exit', (code, signal) => childExited(state, code, signal));
    state.child.once('close', (code, signal) => childClosed(state, code, signal));
  }
  forwarder.stdin.on('error', pipelineErrored);
  collector.stdout.on('error', pipelineErrored);
  collector.stdout.pipe(forwarder.stdin);
  startupComplete = true;
  for (const signal of pendingExternalSignals.splice(0)) processExternalSignal(signal);
}

if (require.main === module) main();

module.exports = {
  MAX_SHUTDOWN_TIMEOUT_MS,
  signalExitCode,
};
