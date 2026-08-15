import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [store, notifications, reviews, audit, types] = await Promise.all([
  read('apps/api/src/security-monitoring/clickhouse-store.ts'),
  read('apps/api/src/security-monitoring/notification.service.ts'),
  read('apps/api/src/security-monitoring/identity-review-agent.service.ts'),
  read('apps/api/src/security-monitoring/audit.service.ts'),
  read('apps/api/src/security-monitoring/types.ts'),
]);

for (const [constant, table] of [
  ['NOTIFICATION_DELIVERY_TABLE', 'notification_delivery_facts'],
  ['IDENTITY_AI_REVIEW_TABLE', 'identity_ai_review_revisions'],
  ['AUDIT_FACT_TABLE', 'audit_facts'],
]) {
  assert.match(store, new RegExp(`const ${constant} = '${table}'`));
  assert.match(store, new RegExp(`CREATE TABLE IF NOT EXISTS \\$\\{${constant}\\}`));
}

assert.match(store, /argMax\(payload, tuple\(revision, ingestedAt\)\)/);
assert.match(store, /GROUP BY deliveryId/);
assert.match(store, /GROUP BY auditId/);
assert.match(store, /appendNotificationDeliveryFacts/);
assert.match(store, /appendIdentityAiReviewRevision/);
assert.match(store, /appendAuditFacts/);
assert.match(store, /deliveries: \[\]/);

assert.match(notifications, /pendingDeliveryFacts/);
assert.match(notifications, /this\.ch\.appendNotificationDeliveryFacts\(deliveryFacts\)/);
assert.match(notifications, /deliveryFacts\.length > 0 && !this\.closing/);
assert.match(reviews, /revision: 1/);
assert.match(reviews, /revision: 2/);
assert.match(reviews, /appendIdentityAiReviewRevision\(record\)/);
assert.match(reviews, /pendingRevisions/);
assert.match(reviews, /flushPendingRevisions/);
assert.match(audit, /pendingFacts/);
assert.match(audit, /this\.ch\.appendAuditFacts\(facts\)/);
assert.match(audit, /facts\.length > 0 && !this\.closing/);
assert.match(types, /revision\?: number/);
assert.match(types, /updatedAt\?: string/);

console.log('Data lifecycle Phase 9 verification passed');
