// Read-only, bounded check of the running Harbor record. Does not restart tasks or change facts.
import assert from 'node:assert/strict';
const [recordId, expectedKey] = process.argv.slice(2);
if (!/^[a-f0-9]{24}$/.test(recordId ?? '') || !/^pri_[a-f0-9]{24}$/.test(expectedKey ?? '')) {
  throw new Error('Provide an explicit Local Record ID and expected complete process key');
}
for (let round = 1; round <= 3; round += 1) {
  const response = await fetch(`http://127.0.0.1:29653/security-center/local-records/${recordId}?limit=1&includeSystemEvidence=true&evidenceLimit=5000&includeObservedLlmRequests=true&includeObservedLlmRequestContent=false`,
    { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.code, 200);
  const e = body.data?.systemEvidence;
  assert.equal(e?.binding?.matchedOsProcessInstanceKey, expectedKey);
  assert.ok(e.counts.lineage > 0, 'descendant evidence must remain visible');
  assert.equal(e.counts.conflict, 0);
  const kinds = (e.events ?? []).reduce((o, event) => {
    o[event.eventKind] = (o[event.eventKind] ?? 0) + 1;
    return o;
  }, {});
  assert.ok(kinds.ToolExec > 0);
  console.log(JSON.stringify({ at: new Date().toISOString(), round,
    bindingId: e.binding.bindingId, key: e.binding.matchedOsProcessInstanceKey,
    counts: e.counts, kinds, completeness: e.completeness, persistence: e.persistence }));
  if (round < 3) await new Promise(r => setTimeout(r, 25000));
}
console.log('PASS: 3 live reads retain one complete binding and descendant ToolExec evidence');
