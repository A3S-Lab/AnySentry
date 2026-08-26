import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

const clickhouse = read('apps/api/src/security-monitoring/clickhouse-store.ts');
const aggregation = read('apps/api/src/security-monitoring/aggregation.service.ts');
const controller = read('apps/api/src/security-monitoring/security-monitoring.controller.ts');
const types = read('apps/api/src/security-monitoring/types.ts');

for (const method of [
  'agentMetricBucketFacts',
  'workspaceWindowFacts',
  'storedAgentInstanceMetrics',
  'agentObservabilityForWindow',
  'storedWorkspaceInventory',
  'storedCoverageOverview',
  'storedPolicySimulation',
]) {
  assert.match(`${clickhouse}\n${aggregation}`, new RegExp(`\\b${method}\\(`));
}

assert.match(clickhouse, /GROUP BY bucketIndex, identityKey/);
assert.match(clickhouse, /GROUP BY workspacePath/);
assert.match(clickhouse, /JSONExtractString\(process, 'cwd'\)/);
assert.match(clickhouse, /groupUniqArrayIf\(collectorId, collectorId != ''\) AS collectorKeys/);
assert.match(clickhouse, /countIf\(collectorId = '' AND eventKind NOT IN \('AgentTool', 'AgentInvocation', 'SystemContext'\)\) AS eventsWithoutCollector/);
assert.match(clickhouse, /tuple\(decisionRevision, decisionUpdatedAt, at\)/);
assert.match(clickhouse, /eventId NOT IN \{excludedEventIds:Array\(String\)\}/);
assert.match(clickhouse, /if \(input\.monitoredOnly\) conditions\.push\('agentMonitored = 1'\)/);

assert.match(aggregation, /private mergeWorkspaceFacts\(/);
assert.match(aggregation, /new Set\(\[\.\.\.a\.collectorKeys, \.\.\.b\.collectorKeys\]\)/);
assert.match(aggregation, /source: hotEvents\.length \? 'clickhouse\+hot_delta' : 'clickhouse'/);
assert.match(aggregation, /durable\?: \{ collectors: T\.CollectorHealth; agents: T\.AgentInventory \}/);
assert.match(aggregation, /agent\.eventsWithoutCollector \?\? 0/);
assert.match(aggregation, /agent\.collectorIds \?\? \[\]/);
assert.match(aggregation, /strategy: 'latest_event_sample'/);
assert.match(aggregation, /totalMode: 'omitted'/);
assert.match(aggregation, /monitoredOnly: input\.scope === 'agent'/);
assert.match(aggregation, /rawEvents = pinnedEdgeId && !topologyFacts/);

assert.match(controller, /(?:await\s+)?this\.agg\.storedWorkspaceInventory\(f\)/);
assert.match(controller, /await this\.agg\.storedCoverageOverview\(f\)/);
assert.match(controller, /await this\.agg\.storedPolicySimulation\(body\)/);
assert.match(controller, /(?:await\s+)?this\.agg\.storedAgentInstanceMetrics\(f\)/);
assert.match(controller, /(?:await\s+)?this\.agg\.agentObservabilityForWindow\(f\)/);
assert.match(controller, /mergeMap\(async \(\) => \(\{ data: await this\.agg\.agentObservabilityForWindow\(q\) \}\)\)/);

assert.match(types, /coverage\?: QueryCoverage;/);
assert.match(types, /collectorIds\?: string\[\];/);
assert.match(types, /eventsWithoutCollector\?: number;/);

console.log('Data lifecycle Phase 3 verification passed');
