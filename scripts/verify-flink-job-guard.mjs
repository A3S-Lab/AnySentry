import assert from 'node:assert/strict';
import { classifyJobs, supervise } from '../streaming/flink/job-guard.mjs';
const name = 'AnySentry Flink Shadow Risk';
const body = state => ({ jobs: state ? [{ name, state, jid: 'fixture' }] : [] });
for (const state of ['RUNNING', 'RESTARTING', 'CREATED', 'FAILING', 'CANCELLING', 'SUSPENDED']) {
  assert.equal(classifyJobs(body(state), name).absent, false);
}
assert.throws(() => classifyJobs({}, name));
assert.throws(() => classifyJobs(body('NEW_UNKNOWN_STATE'), name));
for (const state of ['FAILED', 'FINISHED', 'CANCELED']) assert.equal(classifyJobs(body(state), name).absent, true);

async function scenario(responses, expected, failSubmit = false) {
  let calls = 0;
  let observations = 0;
  const waits = [];
  await supervise({ iterations: 4, env: {}, log: () => {},
    fetcher: async () => {
      const value = responses[Math.min(observations++, responses.length - 1)];
      if (value instanceof Error) throw value;
      return { ok: true, json: async () => value };
    },
    run: async () => { calls++; if (failSubmit) throw new Error('response lost'); },
    wait: async ms => waits.push(ms),
  });
  assert.equal(calls, expected);
  if (calls) assert.ok(waits.includes(60000), 'submission must cool down even after timeout');
  return observations;
}
await scenario([body('RUNNING')], 0);
await scenario([new Error('timeout')], 0);
await scenario([{}], 0);
await scenario([body(), new Error('timeout'), body('RUNNING')], 0);
await scenario([body(), body(), body('RUNNING')], 0); // appears on pre-submit check
await scenario([body(), body(), body(), body('RUNNING')], 1);
await scenario([body(), body(), body(), body('RUNNING')], 1, true);
console.log('PASS: REST polling launches zero CLI processes for healthy/unknown states; confirmed absence submits once.');
