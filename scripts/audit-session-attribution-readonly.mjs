// Bounded lifecycle-identity replay. Never initializes production stores or writes
// bindings/relations. This is not full HTTP/API or payload-capture validation.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { SessionEventAttributionService } from '../apps/api/dist/security-monitoring/session-event-attribution.service.js';
const pgContainer = process.env.ANYSENTRY_TEST_POSTGRES_CONTAINER;
const chContainer = process.env.ANYSENTRY_TEST_CLICKHOUSE_CONTAINER;
if (!pgContainer || !chContainer) throw new Error('Explicit PostgreSQL and ClickHouse test container names required');
const run = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 });
const rows = output => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const bindings = rows(run(['exec', pgContainer, 'psql', '-X', '-At', '-U', 'anysentry', '-d', 'anysentry',
  '-c', 'SELECT record FROM anysentry_session_process_bindings ORDER BY valid_from DESC LIMIT 5001']));
assert.ok(bindings.length < 5001, 'binding context truncated');
const q = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
const ch = sql => rows(run(['exec', chContainer, 'clickhouse-client', '--max_execution_time=8',
  '--max_threads=1', '--max_memory_usage=134217728', '--query', `${sql} FORMAT JSONEachRow`]));
const selected = [];
const seen = new Set();
for (const binding of bindings) {
  if (seen.has(binding.nativeSessionId)) continue;
  seen.add(binding.nativeSessionId);
  selected.push(binding);
  if (selected.length === 4) break;
}
const report = [];
for (const binding of selected) {
  try {
  const scope = `hostId=${q(binding.hostId)} AND bootId=${q(binding.bootId)}`;
  const columns = `factId,eventId,factKind,at,receivedAt,source,collectorId,
    runtimeInstanceId,rootProcess,processInstanceKey,hostId,bootId,pid,ppid,
    pidNamespace,namespacePid,namespacePpid,startTime`;
  const latest = ch(`SELECT ${columns} FROM anysentry.process_lifecycle_facts WHERE ${scope}
    AND processInstanceKey=${q(binding.matchedOsProcessInstanceKey)} ORDER BY at DESC LIMIT 1`)[0];
  if (!latest) {
    report.push({ session: binding.nativeSessionId, status: 'no_root_fact', pid: binding.matchedPid });
    continue;
  }
  const window = { since: Number(latest.at) - 60000, until: Number(latest.at) + 60000 };
  const raw = ch(`SELECT ${columns}
    FROM anysentry.process_lifecycle_facts WHERE ${scope}
    AND at BETWEEN ${window.since} AND ${window.until}
    AND ppid=${Number(binding.matchedPid)}
    ORDER BY at LIMIT 5001`);
  if (raw.length >= 5001) {
    report.push({ session: binding.nativeSessionId, status: 'window_truncated' });
    continue;
  }
  raw.push(latest);
  const numeric = ['at', 'receivedAt', 'pid', 'ppid', 'namespacePid', 'namespacePpid'];
  const facts = [...new Map(raw.map(row => {
    for (const key of numeric) row[key] = Number(row[key]);
    row.rootProcess = Boolean(row.rootProcess);
    row.schemaVersion = 'anysentry.process_lifecycle_fact.v1';
    return [row.factId, row];
  })).values()];
  const byId = new Map(facts.map(f => [f.eventId, f]));
  const clickhouse = {
    readSessionProcessFamilyFacts: async () => facts,
    readSessionProcessObservedEvents: async () => [],
    // Minimal event hydration from real lifecycle facts. No command/body invented.
    eventsByIds: async ids => ids.map(id => {
      const f = byId.get(id);
      return { eventId: id, at: f.at, eventKind: f.factKind === 'exit' ? 'ProcessExit' : 'ToolExec',
        process: { pid: f.pid, ppid: f.ppid }, subject: '', attributes: {}, reasons: [] };
    }),
  };
  const writes = () => { throw new Error('Read-only audit attempted persistence'); };
  const relational = {
    loadSessionProcessBindings: async () => bindings.filter(b => b.hostId === binding.hostId
      && b.bootId === binding.bootId && b.validFrom <= window.until && (b.validTo == null || b.validTo >= window.since)),
    saveSessionProcessBindings: writes, saveProcessLineageEdges: writes,
    saveEventSessionAttributionResults: writes, saveEventSessionRelations: writes,
    reconcileEventSessionRelations: writes,
  };
  const service = new SessionEventAttributionService(clickhouse, relational);
  const first = await service.evidence(binding, window, undefined, 250, { persist: false });
  const second = await new SessionEventAttributionService(clickhouse, relational)
    .evidence(binding, window, undefined, 250, { persist: false });
  assert.deepEqual(first.counts, second.counts);
  assert.deepEqual(first.events.map(e => e.eventId), second.events.map(e => e.eventId));
  report.push({ session: binding.nativeSessionId, pid: binding.matchedPid, window,
    facts: facts.length, counts: first.counts, deterministicReplay: true,
    note: 'root + direct children only; not full session validation' });
  } catch (error) {
    report.push({ session: binding.nativeSessionId, status: 'query_failed',
      reason: error.code ?? error.status ?? 'unknown' });
  }
}
console.log(JSON.stringify({ readOnly: true, report }, null, 2));
