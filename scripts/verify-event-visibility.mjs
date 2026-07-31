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

console.log('PASS event visibility matrix and durable-search lifecycle contracts');
