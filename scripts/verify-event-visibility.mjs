#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { isEventClassificationVisible } = await import('../apps/api/dist/security-monitoring/event-visibility.js');

assert.equal(isEventClassificationVisible('confirmed_agent', 'agent'), true);
assert.equal(isEventClassificationVisible('probable_agent', 'agent'), true);
assert.equal(isEventClassificationVisible('unknown', 'agent'), false);
assert.equal(isEventClassificationVisible('non_agent', 'agent'), false);
assert.equal(isEventClassificationVisible('confirmed_agent', 'raw'), true);
assert.equal(isEventClassificationVisible('probable_agent', 'raw'), true);
assert.equal(isEventClassificationVisible('unknown', 'raw'), true);
assert.equal(isEventClassificationVisible('unknown', 'raw', false), false);
assert.equal(isEventClassificationVisible('non_agent', 'raw'), false);
assert.equal(isEventClassificationVisible('non_agent', 'raw', true, true), true);

const storeSource = await readFile(new URL('../apps/api/src/security-monitoring/clickhouse-store.ts', import.meta.url), 'utf8');
assert.match(storeSource, /async searchEvents\(input: StoredEventQuery\)/u);
assert.match(storeSource, /ORDER BY at DESC, decisionUpdatedAt DESC/u);
assert.match(storeSource, /const latest = new Map<string, JudgedEvent>/u);

const aggregationSource = await readFile(new URL('../apps/api/src/security-monitoring/aggregation.service.ts', import.meta.url), 'utf8');
const directFilterAt = aggregationSource.indexOf('const matchesDirectFilter =');
const earlyRejectAt = aggregationSource.indexOf('if (!matchesEventId && !matchesDirectFilter) return false;');
const identityResolveAt = aggregationSource.indexOf('const resolved = this.agentMetadata.resolveEvent(e);', directFilterAt);
assert.ok(directFilterAt >= 0 && directFilterAt < earlyRejectAt && earlyRejectAt < identityResolveAt,
  'exact event filters must reject before identity/display metadata resolution');
assert.match(aggregationSource, /const pinnedEvent = pinnedEventId \? this\.judge\.findEvent\(pinnedEventId\) : undefined;/u);
assert.match(aggregationSource, /if \(!pinnedEdgeId && !isPinnedEvent && !matchesDirectScope\) continue;/u);

const judgeSource = await readFile(new URL('../apps/api/src/security-monitoring/sentry-judge.service.ts', import.meta.url), 'utf8');
assert.match(judgeSource, /findEvent\(eventId: string\): JudgedEvent \| undefined \{\s*return this\.storeById\.get\(eventId\);/u);

console.log('PASS event visibility matrix and durable-search lifecycle contracts');
