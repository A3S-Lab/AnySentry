import assert from 'node:assert/strict';
import { observerRequestScope } from '../apps/web/src/lib/observer-request-scope.ts';

const cases = [
  [{ model: 'gpt-6-astra', threadId: 'main' }, 'main'],
  [{ model: 'codex-auto-review', threadId: 'review' }, 'auto_review'],
  [{ model: 'CODEX-AUTO-REVIEW', threadId: 'main' }, 'auto_review'],
  [{ model: 'codex-auto-review' }, 'auto_review'],
  [{ model: 'gpt-6-astra', threadId: 'other' }, 'related_thread'],
  [{ threadId: 'other' }, 'related_thread'],
  [{ model: 'gpt-6-astra' }, 'main'],
  [{ model: 'auto-review-mentioned-by-user', threadId: 'main' }, 'main'],
];
for (const [request, expected] of cases) {
  const snapshot = structuredClone(request);
  assert.equal(observerRequestScope(Object.freeze(request), 'main'), expected);
  assert.deepEqual(request, snapshot);
}
console.log(`PASS: ${cases.length} request scope cases; no identity mutation`);
