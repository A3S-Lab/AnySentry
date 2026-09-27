#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [controller, aggregation] = await Promise.all([
  readFile(new URL('../apps/api/src/security-monitoring/security-monitoring.controller.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/api/src/security-monitoring/aggregation.service.ts', import.meta.url), 'utf8'),
]);

const bundleStart = controller.indexOf('async evidenceBundle(');
const exportEnd = controller.indexOf('/** Live agent-observability stream', bundleStart);
assert(bundleStart > 0 && exportEnd > bundleStart, 'Evidence Bundle source region must be discoverable');
const evidence = controller.slice(bundleStart, exportEnd);

assert.match(evidence, /const snapshotAsOf = query\.snapshotAsOf \?\? new Date\(\)\.toISOString\(\)/u);
assert.match(evidence, /classificationView: query\.classificationView \?\? 'as_observed'/u);
assert.match(evidence, /await this\.agg\.storedAgentEvents\(filter\)/u);
assert.match(evidence, /await this\.agg\.storedAgentTimeline\(filter\)/u);
assert.doesNotMatch(evidence, /this\.agg\.agentEvents\(/u, 'Bundle event evidence must not read only the hot Ring');
assert.doesNotMatch(evidence, /this\.agg\.agentTimeline\(/u, 'Bundle timeline must not read only the hot Ring');
assert.match(evidence, /subjectAssetId: scope\.subjectAssetId/u);
assert.match(controller, /'subjectAssetId', 'collectorId'/u,
  'Bundle identity must include subjectAssetId so two Asset exports cannot collide');
assert.match(evidence, /scope\.eventId \|\|\s*scope\.subjectAssetId/u,
  'an Asset subject is an exact evidence context');
assert.match(evidence, /subjectEventIds\.has\(item\.lastEventId\)/u,
  'Asset-scoped incidents must have a direct subject event relation');
assert.match(evidence, /item\.eventId && subjectEventIds\.has\(item\.eventId\)/u,
  'Asset-scoped alerts/remediations must have a direct event or filtered parent relation');
assert.match(evidence, /item\.evidenceEventId && subjectEventIds\.has\(item\.evidenceEventId\)/u,
  'Asset-scoped coverage issues must have a direct evidence event relation');
assert.match(evidence, /topologyCandidates\.edges\.filter\(\(edge\) => subjectEventIds\.has\(edge\.sampleEventId\)\)/u,
  'Asset-scoped topology must be derived only from subject events');
assert.match(evidence, /durableEvidenceCoverage = conservativeEvidenceCoverage\(eventList\.coverage, storedTimeline\.coverage\)/u);
assert.match(evidence, /coverage: subjectScoped[\s\S]{0,700}partialReason: durableEvidenceCoverage\.partialReason \?\? 'scan_limit'/u);
assert.match(controller, /function conservativeEvidenceCoverage\(/u);
assert.match(controller, /partialReason === 'storage_unavailable'/u);
assert.match(evidence, /async evidenceExport\(/u);
assert.match(evidence, /const bundle = await this\.evidenceBundle\(query\)/u);
assert.match(controller, /\['Evidence Data Source', bundle\.timeline\.coverage\.source\]/u);
assert.match(controller, /\['Evidence Partial Reason', bundle\.timeline\.coverage\.partialReason \?\? 'none'\]/u);

assert.match(
  aggregation,
  /subjectAssetId: filter\.subjectAssetId,/u,
  'durable event lookup must push subjectAssetId into StoredEventQuery even for a pinned event',
);
assert.match(
  aggregation,
  /if \(matchesEventId && subjectAssetId && e\.subjectAssetId !== subjectAssetId\) return false/u,
  'hot overlap must not let a pinned event escape explicit Asset scope',
);
assert.match(
  aggregation,
  /subjectAssetId: filter\.subjectAssetId,[\s\S]{0,500}traceId,/u,
  'durable timeline lookup must push subjectAssetId alongside trace scope',
);

console.log('PASS Evidence Bundle/Export durable history, Asset pushdown, and coverage contract');
