#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import os from 'node:os';

const apply = process.argv.includes('--apply');
const postgresContainer =
  process.env.ANYSENTRY_POSTGRES_CONTAINER?.trim() || 'anysentry-postgres-1';
const clickhouseContainer =
  process.env.ANYSENTRY_CLICKHOUSE_CONTAINER?.trim() || 'anysentry-clickhouse-1';
const postgresUser = process.env.POSTGRES_USER?.trim() || 'anysentry';
const postgresDatabase = process.env.POSTGRES_DB?.trim() || 'anysentry';
const limit = positiveInt(process.env.ANYSENTRY_EFFECT_RECONCILE_LIMIT, 5_000, 50_000);

function positiveInt(value, fallback, maximum) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function run(container, command, options = {}) {
  return execFileSync('docker', ['exec', '-i', container, ...command], {
    encoding: 'utf8',
    maxBuffer: 100 * 1024 * 1024,
    ...options,
  });
}

function postgres(sql) {
  return run(postgresContainer, [
    'psql',
    '-X',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    postgresUser,
    '-d',
    postgresDatabase,
    '-At',
    '-F',
    '\t',
    '-c',
    sql,
  ]);
}

function clickhouse(sql) {
  return run(clickhouseContainer, ['clickhouse-client', '--query', sql]);
}

function sqlString(value) {
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function noBusinessEffectExpected(fact) {
  if (fact.verdict === 'allow') return true;
  return fact.eventKind === 'ToolExec'
    && fact.verdict === 'escalate'
    && fact.tier === 'Rules'
    && String(fact.reason ?? '').toLowerCase().includes(
      'incomplete toolexec evidence: argv was truncated or could not be fully reassembled',
    );
}

const pendingRaw = postgres(`
  SELECT
    effect_key,
    payload_fingerprint,
    metadata->>'eventId',
    COALESCE(metadata->>'decisionRevision', '1'),
    created_at_ms
  FROM anysentry_business_effects
  WHERE status = 'pending'
    AND effect_type = 'incident-alert'
    AND lease_expires_at < (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
  ORDER BY created_at_ms, effect_key
  LIMIT ${limit}
`);

const pending = pendingRaw
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [effectKey, payloadFingerprint, eventId, revision, createdAt] = line.split('\t');
    if (!/^evt_[a-zA-Z0-9_-]+$/.test(eventId ?? '')) {
      throw new Error(`Unsafe or missing eventId in pending effect ${effectKey}`);
    }
    return {
      effectKey,
      payloadFingerprint,
      eventId,
      decisionRevision: Number(revision),
      createdAt: Number(createdAt),
    };
  });

const facts = [];
for (let index = 0; index < pending.length; index += 150) {
  const batch = pending.slice(index, index + 150);
  const eventIds = [...new Set(batch.map((item) => item.eventId))];
  const output = clickhouse(`
    SELECT
      eventId,
      decisionRevision,
      payloadFingerprint,
      any(verdict) AS verdict,
      any(severity) AS severity,
      any(eventKind) AS eventKind,
      any(tier) AS tier,
      any(reason) AS reason,
      count() AS physicalRows
    FROM anysentry.events
    WHERE eventId IN (${eventIds.map(sqlString).join(',')})
    GROUP BY eventId, decisionRevision, payloadFingerprint
    FORMAT JSONEachRow
  `);
  for (const line of output.trim().split('\n')) {
    if (line) facts.push(JSON.parse(line));
  }
}

const factsByIdentity = new Map();
for (const fact of facts) {
  factsByIdentity.set(
    `${fact.eventId}\0${Number(fact.decisionRevision)}\0${fact.payloadFingerprint}`,
    fact,
  );
}

const eligible = [];
const unresolved = [];
for (const effect of pending) {
  const identity =
    `${effect.eventId}\0${effect.decisionRevision}\0${effect.payloadFingerprint}`;
  const fact = factsByIdentity.get(identity);
  if (!fact) {
    unresolved.push({ ...effect, reason: 'matching canonical fact not found' });
  } else if (!noBusinessEffectExpected(fact)) {
    unresolved.push({
      ...effect,
      reason: 'canonical fact may require Incident or Alert side effects',
      fact,
    });
  } else {
    eligible.push({ ...effect, fact });
  }
}

let updated = 0;
if (apply && eligible.length > 0) {
  const reconciledAt = Date.now();
  for (let index = 0; index < eligible.length; index += 100) {
    const candidates = eligible.slice(index, index + 100).map((item) => ({
      effect_key: item.effectKey,
      payload_fingerprint: item.payloadFingerprint,
    }));
    const payload = JSON.stringify(candidates);
    if (payload.includes('$reconcile$')) throw new Error('Unexpected reconciliation delimiter');
    const output = postgres(`
      WITH candidates AS (
        SELECT *
        FROM jsonb_to_recordset($reconcile$${payload}$reconcile$::jsonb)
          AS item(effect_key text, payload_fingerprint text)
      ),
      reconciled AS (
        UPDATE anysentry_business_effects AS effect
        SET
          status = 'applied',
          lease_owner = ${sqlString(`reconciler:${os.hostname()}`)},
          lease_expires_at = ${reconciledAt},
          applied_at = ${reconciledAt},
          updated_at = ${reconciledAt},
          metadata = effect.metadata || jsonb_build_object(
            'reconciliation',
            jsonb_build_object(
              'kind', 'verified_no_business_effect',
              'tool', 'scripts/reconcile-noop-business-effects.mjs',
              'at', ${reconciledAt},
              'canonicalFactFingerprint', effect.payload_fingerprint
            )
          )
        FROM candidates
        WHERE effect.effect_key = candidates.effect_key
          AND effect.payload_fingerprint = candidates.payload_fingerprint
          AND effect.status = 'pending'
          AND effect.lease_expires_at < ${reconciledAt}
        RETURNING effect.effect_key
      )
      SELECT count(*) FROM reconciled
    `);
    updated += Number(output.trim() || 0);
  }
  if (updated !== eligible.length) {
    throw new Error(
      `Reconciliation changed ${updated} rows, expected ${eligible.length}; concurrent state changed`,
    );
  }
}

const byVerdict = Object.entries(
  eligible.reduce((counts, item) => {
    const verdict = item.fact.verdict || 'unknown';
    counts[verdict] = (counts[verdict] ?? 0) + 1;
    return counts;
  }, {}),
).map(([verdict, count]) => ({ verdict, count }));

console.log(JSON.stringify({
  schemaVersion: 'anysentry.business-effect-reconciliation.v1',
  mode: apply ? 'apply' : 'dry-run',
  pendingExamined: pending.length,
  canonicalFactsMatched: eligible.length,
  safeNoEffect: eligible.length,
  unresolved: unresolved.length,
  updated,
  byVerdict,
  unresolvedSamples: unresolved.slice(0, 20),
}, null, 2));

if (unresolved.length > 0) process.exitCode = 2;
