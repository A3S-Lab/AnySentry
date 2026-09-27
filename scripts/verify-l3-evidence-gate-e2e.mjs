#!/usr/bin/env node

// Live end-to-end proof that an L3 agent session now closes past the a3s-code completion gate:
// the per-run evidence workspace plus read-only tool policy let the model perform the required
// workspace observation and return a terminal verdict. Skips silently without real credentials.
//
// Required env: A3S_SENTRY_L3_URL, A3S_SENTRY_L3_KEY, A3S_SENTRY_L3_MODEL
// Optional env: ANYSENTRY_L3_SKILLS (defaults to the repo skills/l3 directory)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { L3AgentPool, isL3CompletionGateError } = require('../apps/api/dist/security-monitoring/l3-agent-pool.js');
const { parseL3Decision } = require('../apps/api/dist/security-monitoring/l3-decision-parser.js');

const url = process.env.A3S_SENTRY_L3_URL?.trim();
const key = process.env.A3S_SENTRY_L3_KEY?.trim();
const model = process.env.A3S_SENTRY_L3_MODEL?.trim();
if (!url || !key || !model) {
  console.log('SKIP: A3S_SENTRY_L3_URL/KEY/MODEL are not set; live L3 gate e2e requires real model credentials');
  process.exit(0);
}

const skills = process.env.ANYSENTRY_L3_SKILLS
  ?? fs.realpathSync(path.join(new URL('../skills/l3', import.meta.url).pathname));
assert(fs.existsSync(skills), `skills directory ${skills} must exist`);

const observerLine = JSON.stringify({
  identity: { agent: 'e2e-l3-gate' },
  event: { ToolExec: { argv: ['echo', 'gate-e2e'], cwd: '/tmp' } },
});
const prompt = [
  'You are a security incident responder with the skills in your skills directory.',
  'The event evidence is materialized under evidence/ in your workspace: inspect it first with',
  'your read-only workspace tools (read, ls, grep, glob) — the session completion gate requires',
  'that observation — then judge the flagged action below and respond with ONLY a JSON object:',
  '{"verdict":"allow"|"block","severity":"low"|"medium"|"high"|"critical","reason":"<concise justification>"}.',
  '<<UNTRUSTED>>',
  `Observed: echo gate-e2e in /tmp by e2e-l3-gate`,
  `Raw event: ${observerLine}`,
  '<<UNTRUSTED>>',
].join('\n');

const pool = new L3AgentPool({
  size: 1,
  timeoutMs: Number(process.env.ANYSENTRY_L3_TIMEOUT_MS || 170_000),
  executionTimeoutMs: 165_000,
  maxJobsPerSession: 1,
  modelConfig: { url, model, key, contextLimit: 32_768 },
});

const startedAt = Date.now();
let run;
try {
  await pool.initialize();
  run = await pool.run(skills, prompt, undefined, {
    timeoutMs: Number(process.env.ANYSENTRY_L3_TIMEOUT_MS || 170_000),
    evidence: {
      'event.json': observerLine,
      'brief.txt': 'Actor: e2e-l3-gate\nProvider: e2e\nSignal: ToolExec\nSubject: echo gate-e2e in /tmp',
    },
  });
  const decision = parseL3Decision(run.text);
  assert(['allow', 'block'].includes(decision.verdict), `verdict must be terminal, got ${decision.verdict}`);
  console.log(JSON.stringify({
    ok: true,
    gateRejected: false,
    elapsedMs: Date.now() - startedAt,
    poolWaitMs: run.poolWaitMs,
    agentRunMs: run.agentRunMs,
    verdict: decision.verdict,
    severity: decision.severity,
  }, null, 2));
} catch (error) {
  if (isL3CompletionGateError(error) || /completion gate:/iu.test(run?.text ?? '')) {
    console.error('FAIL: the completion gate still rejects the session with the evidence workspace in place');
  }
  throw error;
} finally {
  await pool.close();
}
