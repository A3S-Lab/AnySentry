#!/usr/bin/env node

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { safeProbeId } from './probe-id.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const apiBase = (process.env.ANYSENTRY_API_BASE ?? 'http://127.0.0.1:29653/security-center').replace(/\/+$/u, '');
const model = process.env.A3S_TEST_MODEL ?? process.env.A3S_CODE_MODEL ?? 'openai/glm5.1-w4a8';
const aclPath = process.env.A3S_CODE_ACL ?? path.join(process.env.HOME ?? '', '.a3s/config.acl');
const sdkBase = process.env.A3S_CODE_SDK_BASE ?? path.resolve(repoRoot, '../os/apps/api');
const skillRoot = path.join(repoRoot, 'integrations/skills');
const runId = process.env.ANYSENTRY_A3S_CODE_TEST_RUN_ID ?? safeProbeId('a3s-code-skill-itest');
const agentId = process.env.ANYSENTRY_A3S_CODE_TEST_AGENT_ID ?? 'a3s-code-skill-itest';
const sessionId = `${runId}-session`;
const workspacePath = 'repo://anysentry/a3s-code-skill-itest';

function positiveIntEnv(name, fallback, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

const skillTimeoutMs = positiveIntEnv('A3S_CODE_SKILL_TIMEOUT_MS', 240000, 900000);
const sessionCloseTimeoutMs = positiveIntEnv('A3S_CODE_SESSION_CLOSE_TIMEOUT_MS', 5000, 60000);
const verifierCommit = currentGitCommit();
const verifierAttributes = {
  'progressive.verifier': 'verify-a3s-code-skill-api',
  'progressive.verifier.schema': 'anysentry.a3s_code_skill_verifier.v1',
  'progressive.verifier.commit': verifierCommit,
  'progressive.verifier.skillTimeoutMs': skillTimeoutMs,
  'progressive.verifier.sessionCloseTimeoutMs': sessionCloseTimeoutMs,
  'progressive.verifier.model': model,
  'progressive.verifier.node': process.version,
};

function currentGitCommit() {
  const fromEnv = (process.env.ANYSENTRY_VERIFIER_COMMIT ?? '').trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

function fail(message, details) {
  console.error(`FAIL ${message}`);
  if (details !== undefined) {
    console.error(typeof details === 'string' ? details : JSON.stringify(details, null, 2));
  }
  process.exitCode = 1;
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function assert(message, condition, details) {
  if (condition) pass(message);
  else fail(message, details);
}

function compact(value, limit = 2400) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > limit ? `${text.slice(0, limit)}... [truncated]` : text;
}

async function withTimeout(label, task, timeoutMs, onTimeout) {
  let timer;
  let timedOut = false;
  let settled = false;
  const work = Promise.resolve().then(task);
  return await new Promise((resolve, reject) => {
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    work.then(
      (value) => {
        if (!timedOut) settle(resolve, value);
      },
      (error) => {
        if (!timedOut) settle(reject, error);
      },
    );
    timer = setTimeout(() => {
      timedOut = true;
      Promise.resolve()
        .then(() => onTimeout?.())
        .catch((error) => {
          console.error(`Unable to stop timed-out ${label}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => settle(reject, new Error(`${label} timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
  });
}

async function recordFailureEvidence(reason, details) {
  try {
    const recorded = await request('/capabilities', {
      method: 'POST',
      body: JSON.stringify({
        action: 'execute',
        module: 'security-center',
        operation: 'recordSecurityEvents',
        params: {
          sourceName: 'a3s-code-skill-itest',
          sourceType: 'custom',
          workspacePath,
          agentId,
          sessionId,
          events: [
            {
              kind: 'SecurityFinding',
              workspacePath,
              agentId,
              sessionId,
              runId,
              status: 'failed',
              subject: `a3s-code Skill progressive API verification failed: ${reason}`,
              attributes: {
                ...verifierAttributes,
                'progressive.runner': 'a3s-code',
                'progressive.skill': 'anysentry-api',
                'progressive.failure': true,
                'progressive.failure.reason': reason,
                'progressive.failure.details': compact(details, 1200),
              },
            },
          ],
        },
      }),
    });
    const recordedEventId = recorded?.items?.[0]?.eventId;
    const failureEvent = await eventually('failure evidence to be queryable', async () => {
      const list = await request('/events/list', {
        method: 'POST',
        body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 20 }),
      });
      return list.items?.find(
        (item) =>
          item.runId === runId &&
          item.agentId === agentId &&
          (item.eventId === recordedEventId || item.attributes?.['progressive.failure'] === true || item.attributes?.['progressive.failure'] === 'true'),
      );
    });
    if (!failureEvent?.eventId) {
      throw new Error(`failure evidence did not become queryable: ${compact({ recorded, failureEvent })}`);
    }
    if (!failureEvent.verdict || failureEvent.verdict === 'allow' || failureEvent.riskCategory !== 'runtime_failure') {
      throw new Error(`failure evidence was not actionable runtime failure evidence: ${compact(failureEvent)}`);
    }
    const failureAttrs = failureEvent.attributes ?? {};
    if (
      failureAttrs['progressive.verifier.commit'] !== verifierCommit ||
      Number(failureAttrs['progressive.verifier.skillTimeoutMs']) !== skillTimeoutMs ||
      Number(failureAttrs['progressive.verifier.sessionCloseTimeoutMs']) !== sessionCloseTimeoutMs
    ) {
      throw new Error(`failure evidence lost verifier audit metadata: ${compact(failureEvent)}`);
    }
    const bundle = await request('/capabilities', {
      method: 'POST',
      body: JSON.stringify({
        action: 'execute',
        module: 'security-center',
        operation: 'buildEvidenceBundle',
        params: {
          timeType: 'last_30d',
          eventId: failureEvent.eventId,
          limit: 20,
        },
      }),
    });
    if (bundle?.schemaVersion !== 'anysentry.evidence_bundle.v1' || !bundle.events?.some((item) => item.eventId === failureEvent.eventId)) {
      throw new Error(`failure evidence bundle did not include the failure event: ${compact(bundle)}`);
    }
    console.error(
      `Recorded and verified AnySentry failure evidence for ${reason}: ${failureEvent.eventId}, bundle ${bundle.bundleId}`,
    );
  } catch (error) {
    console.error(`Unable to record or verify AnySentry failure evidence: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadA3sCode() {
  try {
    return await import('@a3s-lab/code');
  } catch (directError) {
    try {
      const requireFromSdkBase = createRequire(path.join(sdkBase, 'package.json'));
      return requireFromSdkBase('@a3s-lab/code');
    } catch (fallbackError) {
      throw new Error(
        [
          'Unable to load @a3s-lab/code.',
          'Install it in this repo or set A3S_CODE_SDK_BASE to a project that depends on @a3s-lab/code.',
          `Direct import: ${directError instanceof Error ? directError.message : String(directError)}`,
          `Fallback import from ${sdkBase}: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        ].join('\n'),
      );
    }
  }
}

async function request(pathname, init) {
  const response = await fetch(`${apiBase}${pathname}`, {
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} -> HTTP ${response.status}: ${text}`);
  return body?.data ?? body;
}

async function eventually(label, fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${compact(lastValue)}`);
}

function parseMetadataJson(result) {
  if (!result?.metadataJson) return {};
  try {
    return JSON.parse(result.metadataJson);
  } catch {
    return {};
  }
}

function verifierSource() {
  return `
const apiBase = ${JSON.stringify(apiBase)};
const runId = ${JSON.stringify(runId)};
const agentId = ${JSON.stringify(agentId)};
const sessionId = ${JSON.stringify(sessionId)};
const workspacePath = ${JSON.stringify(workspacePath)};
const model = ${JSON.stringify(model)};
const verifierAttributes = ${JSON.stringify(verifierAttributes)};

async function request(pathname, init = {}) {
  const response = await fetch(\`\${apiBase}\${pathname}\`, {
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(\`\${init.method ?? 'GET'} \${pathname} -> HTTP \${response.status}: \${text}\`);
  return body?.data ?? body;
}

async function eventually(label, fn) {
  const deadline = Date.now() + 15000;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await fn();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(\`Timed out waiting for \${label}: \${JSON.stringify(lastValue)}\`);
}

await request('/healthz');

const modules = await request('/capabilities?action=list');
if (!Array.isArray(modules) || !modules.some((module) => module.name === 'security-center')) {
  throw new Error(\`security-center module missing from list: \${JSON.stringify(modules)}\`);
}

const operation = await request('/capabilities?action=describe&module=security-center&operation=recordSecurityEvents');
if (operation?.name !== 'recordSecurityEvents' || !operation.inputSchema) {
  throw new Error(\`recordSecurityEvents describe failed: \${JSON.stringify(operation)}\`);
}

const recorded = await request('/capabilities', {
  method: 'POST',
  body: JSON.stringify({
    action: 'execute',
    module: 'security-center',
    operation: 'recordSecurityEvents',
    params: {
      sourceName: 'a3s-code-skill-itest',
      sourceType: 'custom',
      workspacePath,
      agentId,
      sessionId,
      events: [
        {
          kind: 'LlmCall',
          workspacePath,
          agentId,
          sessionId,
          runId,
          model,
          subject: 'a3s-code used anysentry-api skill to call progressive API',
          promptTokens: 12,
          completionTokens: 8,
          latencyMs: 321,
          attributes: {
            ...verifierAttributes,
            'progressive.runner': 'a3s-code',
            'progressive.skill': 'anysentry-api',
            'progressive.flow': 'healthz,list,describe,execute,events-list',
            'progressive.model': model,
          },
        },
      ],
    },
  }),
});

const eventId = recorded.items?.[0]?.eventId;
if (recorded.accepted !== true || !eventId) {
  throw new Error(\`recordSecurityEvents did not accept one event: \${JSON.stringify(recorded)}\`);
}

const event = await eventually('recorded event to be queryable', async () => {
  const list = await request('/events/list', {
    method: 'POST',
    body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
  });
  return list.items?.find((item) => item.eventId === eventId && item.runId === runId && item.agentId === agentId);
});

const bundle = await request('/capabilities', {
  method: 'POST',
  body: JSON.stringify({
    action: 'execute',
    module: 'security-center',
    operation: 'buildEvidenceBundle',
    params: {
      timeType: 'last_30d',
      eventId,
      limit: 20,
    },
  }),
});
if (bundle?.schemaVersion !== 'anysentry.evidence_bundle.v1' || !bundle.events?.some((item) => item.eventId === eventId)) {
  throw new Error(\`buildEvidenceBundle did not include the recorded event: \${JSON.stringify(bundle)}\`);
}

console.log(JSON.stringify({
  healthOk: true,
  listed: true,
  described: operation.name,
  eventId,
  bundleId: bundle.bundleId,
  bundleEventCount: bundle.summary?.eventCount,
  eventKind: event.eventKind,
  verdict: event.verdict ?? recorded.items?.[0]?.verdict,
  queriedBack: true,
  runId,
  agentId,
}));
`.trim();
}

function buildSkillPrompt() {
  return `
Use the anysentry-api Skill instructions to verify the progressive API at ${apiBase}.

Constraints:
- Do not deploy services.
- Do not edit files.
- Use bash to run exactly one verification command.
- Follow the progressive flow: healthz, list, describe, execute, events/list, buildEvidenceBundle.
- Return only the compact JSON printed by the command.

Run this command:

\`\`\`sh
node --input-type=module <<'ANYSENTRY_A3S_CODE_SKILL_VERIFY'
${verifierSource()}
ANYSENTRY_A3S_CODE_SKILL_VERIFY
\`\`\`
`.trim();
}

async function main() {
  console.log('AnySentry a3s-code Skill progressive API verification');
  console.log(`API base: ${apiBase}`);
  console.log(`Model: ${model}`);
  console.log(`Run ID: ${runId}`);

  assert('a3s-code ACL exists', fs.existsSync(aclPath), `Set A3S_CODE_ACL. Missing: ${aclPath}`);
  assert('anysentry-api Skill directory exists', fs.existsSync(path.join(skillRoot, 'anysentry-api', 'SKILL.md')), skillRoot);
  if (process.exitCode) process.exit(process.exitCode);

  await request('/healthz');
  pass('AnySentry API healthz responds before a3s-code run');

  const { Agent } = await loadA3sCode();
  const agent = await Agent.create(aclPath);
  const session = agent.session(repoRoot, {
    model,
    builtinSkills: false,
    skillDirs: [skillRoot],
    permissionPolicy: { defaultDecision: 'allow' },
    planningMode: 'disabled',
    maxToolRounds: 20,
    toolTimeoutMs: skillTimeoutMs,
  });
  let sessionClosed = false;
  async function closeSession(reason) {
    if (sessionClosed) return;
    sessionClosed = true;
    let closeTimer;
    const closeWork = Promise.resolve().then(() => session.close?.());
    try {
      await Promise.race([
        closeWork,
        new Promise((_, reject) => {
          closeTimer = setTimeout(
            () => reject(new Error(`a3s-code session close timed out after ${sessionCloseTimeoutMs}ms`)),
            sessionCloseTimeoutMs,
          );
        }),
      ]);
      console.error(`Closed a3s-code session after ${reason}`);
    } catch (error) {
      console.error(
        `Timed out or failed closing a3s-code session after ${reason}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (closeTimer) clearTimeout(closeTimer);
      closeWork.catch(() => undefined);
    }
  }

  try {
    const toolNames = session.toolNames();
    assert('a3s-code exposes Skill, search_skills, and bash tools', ['Skill', 'search_skills', 'bash'].every((name) => toolNames.includes(name)), toolNames);

    let search;
    try {
      search = await withTimeout(
        'a3s-code search_skills tool invocation',
        () => session.tool('search_skills', { query: 'AnySentry progressive API', limit: 5 }),
        Math.min(skillTimeoutMs, 60000),
        () => closeSession('search_skills timeout'),
      );
    } catch (error) {
      await recordFailureEvidence('search_skills tool invocation failed or timed out', error instanceof Error ? error.message : String(error));
      throw error;
    }
    assert('a3s-code discovers the anysentry-api Skill', String(search.output ?? '').includes('anysentry-api'), search);

    let result;
    try {
      result = await withTimeout(
        'a3s-code Skill tool invocation',
        () => session.tool('Skill', {
          skill_name: 'anysentry-api',
          prompt: buildSkillPrompt(),
        }),
        skillTimeoutMs,
        () => closeSession('Skill timeout'),
      );
    } catch (error) {
      await recordFailureEvidence('Skill tool invocation failed or timed out', error instanceof Error ? error.message : String(error));
      throw error;
    }
    const metadata = parseMetadataJson(result);

    assert('a3s-code Skill tool invocation succeeds', result.exitCode === 0, result);
    assert('Skill invocation is for anysentry-api', metadata.skill_name === 'anysentry-api', metadata);
    assert('Skill used at least one tool while applying the API flow', Number(metadata.tool_calls ?? 0) >= 1, metadata);
    if (result.exitCode !== 0 || metadata.skill_name !== 'anysentry-api' || Number(metadata.tool_calls ?? 0) < 1) {
      await recordFailureEvidence('skill invocation returned an invalid result', { result, metadata });
    }

    const event = await eventually('event recorded by a3s-code Skill run', async () => {
      const list = await request('/events/list', {
        method: 'POST',
        body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
      });
      return list.items?.find((item) => item.runId === runId && item.agentId === agentId && item.eventKind === 'LlmCall');
    });

    assert('AnySentry stores the event created through progressive execute', Boolean(event?.eventId), event);
    assert('stored event carries the a3s-code Skill evidence markers', event?.attributes?.['progressive.skill'] === 'anysentry-api' && event?.attributes?.['progressive.runner'] === 'a3s-code', event);
    assert(
      'stored event carries verifier audit metadata',
      event?.attributes?.['progressive.verifier.commit'] === verifierCommit &&
        Number(event?.attributes?.['progressive.verifier.skillTimeoutMs']) === skillTimeoutMs &&
        Number(event?.attributes?.['progressive.verifier.sessionCloseTimeoutMs']) === sessionCloseTimeoutMs,
      event,
    );
    const bundle = await request('/capabilities', {
      method: 'POST',
      body: JSON.stringify({
        action: 'execute',
        module: 'security-center',
        operation: 'buildEvidenceBundle',
        params: {
          timeType: 'last_30d',
          eventId: event.eventId,
          limit: 20,
        },
      }),
    });
    assert(
      'stored event builds an Evidence Bundle through the progressive API',
      bundle?.schemaVersion === 'anysentry.evidence_bundle.v1' && bundle.events?.some((item) => item.eventId === event.eventId),
      bundle,
    );

    console.log(
      JSON.stringify(
        {
          skill: metadata.skill_name,
          model,
          runId,
          agentId,
          eventId: event.eventId,
          bundleId: bundle.bundleId,
          verdict: event.verdict,
          toolCalls: metadata.tool_calls,
        },
        null,
        2,
      ),
    );
  } finally {
    await closeSession('verification completion');
  }

  if (process.exitCode) {
    console.error('a3s-code Skill progressive API verification failed');
    process.exit(process.exitCode);
  }
  console.log('a3s-code Skill progressive API verification passed');
}

main().catch((error) => {
  fail('verification threw', error instanceof Error ? error.message : String(error));
  process.exit(process.exitCode || 1);
});
