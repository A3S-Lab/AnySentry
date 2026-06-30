#!/usr/bin/env node

import fs from 'node:fs';
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
const skillTimeoutMs = Number(process.env.A3S_CODE_SKILL_TIMEOUT_MS ?? '240000');
const runId = process.env.ANYSENTRY_A3S_CODE_TEST_RUN_ID ?? safeProbeId('a3s-code-skill-itest');
const agentId = process.env.ANYSENTRY_A3S_CODE_TEST_AGENT_ID ?? 'a3s-code-skill-itest';
const sessionId = `${runId}-session`;
const workspacePath = 'repo://anysentry/a3s-code-skill-itest';

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

console.log(JSON.stringify({
  healthOk: true,
  listed: true,
  described: operation.name,
  eventId,
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
- Follow the progressive flow: healthz, list, describe, execute, events/list.
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

  try {
    const toolNames = session.toolNames();
    assert('a3s-code exposes Skill, search_skills, and bash tools', ['Skill', 'search_skills', 'bash'].every((name) => toolNames.includes(name)), toolNames);

    const search = await session.tool('search_skills', { query: 'AnySentry progressive API', limit: 5 });
    assert('a3s-code discovers the anysentry-api Skill', String(search.output ?? '').includes('anysentry-api'), search);

    const result = await session.tool('Skill', {
      skill_name: 'anysentry-api',
      prompt: buildSkillPrompt(),
    });
    const metadata = parseMetadataJson(result);

    assert('a3s-code Skill tool invocation succeeds', result.exitCode === 0, result);
    assert('Skill invocation is for anysentry-api', metadata.skill_name === 'anysentry-api', metadata);
    assert('Skill used at least one tool while applying the API flow', Number(metadata.tool_calls ?? 0) >= 1, metadata);

    const event = await eventually('event recorded by a3s-code Skill run', async () => {
      const list = await request('/events/list', {
        method: 'POST',
        body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
      });
      return list.items?.find((item) => item.runId === runId && item.agentId === agentId && item.eventKind === 'LlmCall');
    });

    assert('AnySentry stores the event created through progressive execute', Boolean(event?.eventId), event);
    assert('stored event carries the a3s-code Skill evidence markers', event?.attributes?.['progressive.skill'] === 'anysentry-api' && event?.attributes?.['progressive.runner'] === 'a3s-code', event);

    console.log(
      JSON.stringify(
        {
          skill: metadata.skill_name,
          model,
          runId,
          agentId,
          eventId: event.eventId,
          verdict: event.verdict,
          toolCalls: metadata.tool_calls,
        },
        null,
        2,
      ),
    );
  } finally {
    session.close?.();
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
