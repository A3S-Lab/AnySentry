#!/usr/bin/env node

// Interaction read window clamp verification (UOS #16).
// Guards the 24h catalogue-read cap in time-window.ts and its wiring in
// aggregation.service.ts readAgentInteractions: an unclamped wide window once
// scanned 969 MiB / 5.1 万行 and blew the 5s bounded budget, degrading the
// conversation directory to the hot ring and back-pressuring the spool.
// Runtime assertions run against the compiled app (build first); a source
// assertion catches a stale dist.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const {
  clampInteractionReadWindow,
  INTERACTION_READ_MAX_SPAN_MS,
} = require(join(root, 'apps/api/dist/security-monitoring/time-window.js'));

const DAY = 24 * 3_600_000;
assert.equal(INTERACTION_READ_MAX_SPAN_MS, DAY, 'cap must be 24h');

const wide = { startMs: 1_700_000_000_000, endMs: 1_700_000_000_000 + 30 * DAY, spanMs: 30 * DAY, custom: false, cacheKey: 'last_30d' };

// 1. Catalogue read with a 30-day window clamps to 24h, end preserved.
const clamped = clampInteractionReadWindow(wide, false);
assert.equal(clamped.spanMs, DAY);
assert.equal(clamped.endMs, wide.endMs, 'end must be preserved');
assert.equal(clamped.startMs, wide.endMs - DAY, 'start must move to end-24h');
assert.ok(clamped.cacheKey.includes('clamped24h'), 'cache key must reflect the clamp');

// 2. Tight windows pass through untouched.
const tight = { startMs: wide.endMs - 3_600_000, endMs: wide.endMs, spanMs: 3_600_000, custom: false, cacheKey: 'last_1h' };
assert.deepEqual(clampInteractionReadWindow(tight, false), tight, 'tight window must not change');

// 3. Exact membership point reads are exempt (old ids must stay reachable).
assert.deepEqual(clampInteractionReadWindow(wide, true), wide, 'exact membership read must be exempt');

// 4. Custom snapshot semantics survive the clamp.
const customWide = { ...wide, custom: true, cacheKey: 'custom|a|b' };
const customClamped = clampInteractionReadWindow(customWide, false);
assert.equal(customClamped.custom, true, 'custom flag must survive');
assert.equal(customClamped.endMs, customWide.endMs);

// 5. Wiring: readAgentInteractions applies the clamp to its resolved window.
const aggSrc = readFileSync(join(root, 'apps/api/src/security-monitoring/aggregation.service.ts'), 'utf8');
assert.ok(
  aggSrc.includes('clampInteractionReadWindow(resolveTimeWindow(filter), exactMembershipRead)'),
  'readAgentInteractions must clamp the resolved window (exactMembershipRead first)',
);

console.log('Interaction read window clamp verification passed');
