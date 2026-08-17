'use strict';

// Test-only bounded witness placed between the Rust collector and the normal forwarder. It keeps
// the production byte stream unchanged and records only a minimal digest for ToolExec lines whose
// argv contains the run-owned marker. No marker means a pure passthrough.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');

const controlDirectory = String(process.env.ANYSENTRY_E2E_WITNESS_DIR || '');
const maxMatches = 8;
const maxLineBytes = 1024 * 1024;
let buffered = '';
let discardingOversizedLine = false;

function text(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function eventRecord(line) {
  if (!controlDirectory) return undefined;
  const normalizedLine = line.trim();
  let marker;
  try {
    marker = fs.readFileSync(path.join(controlDirectory, 'marker'), 'utf8').trim();
  } catch {
    return undefined;
  }
  if (!/^[a-z0-9-]{1,160}$/u.test(marker) || !normalizedLine.includes(marker)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(normalizedLine);
  } catch {
    return undefined;
  }
  const tool = parsed?.event?.ToolExec;
  if (!tool || !Array.isArray(tool.argv) || !tool.argv.some((arg) => text(arg) === marker)) {
    return undefined;
  }
  const processInfo = parsed?.process && typeof parsed.process === 'object' ? parsed.process : {};
  const identity = parsed?.identity && typeof parsed.identity === 'object' ? parsed.identity : {};
  const workload = parsed?.workload && typeof parsed.workload === 'object' ? parsed.workload : {};
  return {
    schema: 'anysentry.e2e_raw_witness.v1',
    observedAt: new Date().toISOString(),
    lineSha256: crypto.createHash('sha256').update(normalizedLine).digest('hex'),
    markerSha256: crypto.createHash('sha256').update(JSON.stringify(marker)).digest('hex'),
    eventKind: 'ToolExec',
    argvMarkerMatched: true,
    process: {
      hostId: text(processInfo.host_id || processInfo.hostId) || undefined,
      bootId: text(processInfo.boot_id || processInfo.bootId) || undefined,
      pid: Number(processInfo.pid || tool.pid) || undefined,
      ppid: Number(processInfo.ppid || tool.ppid) || undefined,
      startTimeTicks: text(processInfo.start_time_ticks || processInfo.startTimeTicks) || undefined,
      cgroup: text(processInfo.cgroup) || undefined,
      cgroupId: text(processInfo.cgroup_id || processInfo.cgroupId) || undefined,
    },
    identity: {
      agent: text(identity.agent) || undefined,
      task: text(identity.task) || undefined,
      session: text(identity.session) || undefined,
    },
    workload,
    execConfirmed: tool.exec_confirmed === true,
  };
}

function inspectLine(line) {
  const record = eventRecord(line);
  if (!record) return;
  try {
    const outputFile = path.join(controlDirectory, 'matches.ndjson');
    const recordText = JSON.stringify(record) + '\n';
    let existing = '';
    try { existing = fs.readFileSync(outputFile, 'utf8'); } catch {}
    const records = existing.split(/\r?\n/u).filter(Boolean);
    if (records.length >= maxMatches) records.shift();
    records.push(recordText.trimEnd());
    fs.writeFileSync(outputFile, records.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    process.stderr.write(`[observer-e2e-witness] ${error.message}\n`);
  }
}

function inspectChunk(chunk) {
  if (!controlDirectory) return;
  buffered += chunk.toString('utf8');
  while (true) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) break;
    const line = buffered.slice(0, newline).replace(/\r$/u, '');
    buffered = buffered.slice(newline + 1);
    if (!discardingOversizedLine) inspectLine(line);
    discardingOversizedLine = false;
  }
  if (Buffer.byteLength(buffered) > maxLineBytes) {
    buffered = '';
    discardingOversizedLine = true;
  }
}

if (controlDirectory) {
  if (!path.isAbsolute(controlDirectory)) throw new Error('ANYSENTRY_E2E_WITNESS_DIR must be absolute');
  fs.mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
}

const passthrough = new Transform({
  transform(chunk, _encoding, callback) {
    inspectChunk(chunk);
    callback(null, chunk);
  },
  flush(callback) {
    if (buffered && !discardingOversizedLine) inspectLine(buffered.replace(/\r$/u, ''));
    callback();
  },
});

process.stdin.pipe(passthrough).pipe(process.stdout);
