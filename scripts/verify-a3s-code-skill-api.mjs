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
const verifierSummarySchema = 'anysentry.a3s_code_skill_verifier.summary.v1';
const verifierProcessStartedAt = Date.now();
let lastVerifierTimings = {};

function positiveIntEnv(name, fallback, max) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function booleanEnv(name, fallback = false) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value);
}

const skillTimeoutMs = positiveIntEnv('A3S_CODE_SKILL_TIMEOUT_MS', 240000, 900000);
const sessionCloseTimeoutMs = positiveIntEnv('A3S_CODE_SESSION_CLOSE_TIMEOUT_MS', 5000, 60000);
const nearTimeoutRatio = Number(process.env.A3S_CODE_NEAR_TIMEOUT_RATIO ?? 0.5);
const nearTimeoutThresholdRatio = Number.isFinite(nearTimeoutRatio) && nearTimeoutRatio > 0 && nearTimeoutRatio < 1 ? nearTimeoutRatio : 0.5;
const nearTimeoutThresholdMs = Math.round(skillTimeoutMs * nearTimeoutThresholdRatio);
const requireNearTimeoutWarning = booleanEnv('A3S_CODE_REQUIRE_NEAR_TIMEOUT_WARNING');
const verifierSelfTest = process.argv.includes('--self-test') || booleanEnv('ANYSENTRY_A3S_CODE_VERIFIER_SELF_TEST');
const verifierCommit = currentGitCommit();
const verifierAttributes = {
  'progressive.verifier': 'verify-a3s-code-skill-api',
  'progressive.verifier.schema': 'anysentry.a3s_code_skill_verifier.v1',
  'progressive.verifier.commit': verifierCommit,
  'progressive.verifier.skillTimeoutMs': skillTimeoutMs,
  'progressive.verifier.sessionCloseTimeoutMs': sessionCloseTimeoutMs,
  'progressive.verifier.nearTimeoutRatio': nearTimeoutThresholdRatio,
  'progressive.verifier.nearTimeoutThresholdMs': nearTimeoutThresholdMs,
  'progressive.verifier.requireNearTimeoutWarning': requireNearTimeoutWarning,
  'progressive.verifier.model': model,
  'progressive.verifier.node': process.version,
};

function durationMs(startedAt) {
  return Math.max(0, Date.now() - startedAt);
}

function timingAttributes(timings = {}) {
  const out = {};
  for (const [key, value] of Object.entries(timings)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[`progressive.verifier.${key}Ms`] = Math.max(0, Math.round(value));
    } else if (typeof value === 'string' && value.trim()) {
      out[`progressive.verifier.${key}`] = value.trim();
    }
  }
  return out;
}

function sameAttributeValue(actual, expected) {
  if (typeof expected === 'number') return Number(actual) === expected;
  return actual === expected;
}

function trueAttribute(value) {
  return value === true || value === 'true';
}

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

let verifierSummaryPrinted = false;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function evidenceFieldMismatchIssues(prefix, actual, expected, fields) {
  const issues = [];
  for (const field of fields) {
    if (actual?.[field] !== expected?.[field]) {
      issues.push(`${prefix}.${field} must match failure.evidence.${field}`);
    }
  }
  return issues;
}

function verifierSummaryIssues(summary) {
  const issues = [];
  if (!isRecord(summary)) return ['summary must be an object'];
  if (summary.schemaVersion !== verifierSummarySchema) issues.push('schemaVersion must be anysentry.a3s_code_skill_verifier.summary.v1');
  if (!['passed', 'failed'].includes(summary.status)) issues.push('status must be passed or failed');
  if (summary.verifier?.name !== 'verify-a3s-code-skill-api') issues.push('verifier.name must be verify-a3s-code-skill-api');
  if (!isNonEmptyString(summary.verifier?.commit)) issues.push('verifier.commit must be a non-empty string');
  if (!isNonEmptyString(summary.verifier?.model)) issues.push('verifier.model must be a non-empty string');
  if (!isNonEmptyString(summary.target?.apiBase)) issues.push('target.apiBase must be a non-empty string');
  if (!isNonEmptyString(summary.target?.runId)) issues.push('target.runId must be a non-empty string');
  if (!isNonEmptyString(summary.target?.agentId)) issues.push('target.agentId must be a non-empty string');
  if (!isNonEmptyString(summary.target?.sessionId)) issues.push('target.sessionId must be a non-empty string');
  if (!isRecord(summary.timings)) issues.push('timings must be an object');

  if (summary.status === 'passed') {
    if (summary.failure) issues.push('passed summary must not include failure');
    if (summary.verifier?.skill !== 'anysentry-api') issues.push('passed summary verifier.skill must be anysentry-api');
    if (!isPositiveInteger(summary.verifier?.toolCalls)) issues.push('passed summary verifier.toolCalls must be a positive integer');
    if (!isNonEmptyString(summary.evidence?.eventId)) issues.push('passed summary evidence.eventId must be a non-empty string');
    if (!isNonEmptyString(summary.evidence?.bundleId)) issues.push('passed summary evidence.bundleId must be a non-empty string');
    if (!isPositiveInteger(summary.evidence?.bundleEventCount)) issues.push('passed summary evidence.bundleEventCount must be a positive integer');
    if (summary.evidence?.eventKind !== 'LlmCall') issues.push('passed summary evidence.eventKind must be LlmCall');
    if (summary.evidence?.verdict !== 'allow') issues.push('passed summary evidence.verdict must be allow');
    if (!isNonEmptyString(summary.evidence?.skillOutput?.eventId)) issues.push('passed summary evidence.skillOutput.eventId must be a non-empty string');
    if (!isNonEmptyString(summary.evidence?.skillOutput?.bundleId)) issues.push('passed summary evidence.skillOutput.bundleId must be a non-empty string');
    if (!isPositiveInteger(summary.evidence?.skillOutput?.bundleEventCount)) {
      issues.push('passed summary evidence.skillOutput.bundleEventCount must be a positive integer');
    }
    if (summary.evidence?.skillOutput?.eventKind !== 'LlmCall') issues.push('passed summary evidence.skillOutput.eventKind must be LlmCall');
    if (summary.evidence?.skillOutput?.verdict !== 'allow') issues.push('passed summary evidence.skillOutput.verdict must be allow');
    if (summary.evidence?.skillOutput?.queriedBack !== true) issues.push('passed summary evidence.skillOutput.queriedBack must be true');
    if (summary.evidence?.eventId !== summary.evidence?.skillOutput?.eventId) issues.push('passed summary eventId must match skillOutput.eventId');
    if (summary.evidence?.bundleId !== summary.evidence?.skillOutput?.bundleId) issues.push('passed summary bundleId must match skillOutput.bundleId');
    if (summary.evidence?.bundleEventCount !== summary.evidence?.skillOutput?.bundleEventCount) {
      issues.push('passed summary bundleEventCount must match skillOutput.bundleEventCount');
    }
    if (!isRecord(summary.warning)) issues.push('passed summary warning must be an object');
    if (summary.warning?.required === true && summary.warning?.triggered !== true) {
      issues.push('passed summary required warning must be triggered');
    }
  }

  if (summary.status === 'failed') {
    if (!isNonEmptyString(summary.failure?.phase)) issues.push('failed summary failure.phase must be a non-empty string');
    if (!isNonEmptyString(summary.failure?.reason)) issues.push('failed summary failure.reason must be a non-empty string');
    const evidence = summary.failure?.evidence;
    if (!isRecord(evidence)) {
      issues.push('failed summary failure.evidence must be an object');
    } else if (typeof evidence.recorded !== 'boolean') {
      issues.push('failed summary failure.evidence.recorded must be a boolean');
    } else if (evidence.recorded === true) {
      if (!isNonEmptyString(evidence.eventId)) issues.push('recorded failure evidence.eventId must be a non-empty string');
      if (!isNonEmptyString(evidence.bundleId)) issues.push('recorded failure evidence.bundleId must be a non-empty string');
      if (!isPositiveInteger(evidence.bundleEventCount)) {
        issues.push('recorded failure evidence.bundleEventCount must be a positive integer');
      }
      if (evidence.eventKind !== 'SecurityAction') issues.push('recorded failure evidence.eventKind must be SecurityAction');
      if (evidence.eventCategory !== 'security') issues.push('recorded failure evidence.eventCategory must be security');
      if (!isNonEmptyString(evidence.verdict) || evidence.verdict === 'allow') {
        issues.push('recorded failure evidence.verdict must be a non-allow string');
      }
      if (evidence.riskCategory !== 'runtime_failure') {
        issues.push('recorded failure evidence.riskCategory must be runtime_failure');
      }
    } else if (!isNonEmptyString(evidence.error)) {
      issues.push('unrecorded failure evidence.error must explain why evidence was not written');
    }
  }

  if (summary.warning !== undefined) {
    if (typeof summary.warning?.required !== 'boolean') issues.push('warning.required must be a boolean');
    if (typeof summary.warning?.triggered !== 'boolean') issues.push('warning.triggered must be a boolean');
    if (!isFiniteNumber(summary.warning?.thresholdMs) || summary.warning.thresholdMs <= 0) issues.push('warning.thresholdMs must be a positive number');
    if (summary.status === 'failed' && summary.warning?.required === true && summary.warning?.triggered === false) {
      if (!isRecord(summary.warning?.failure)) {
        issues.push('failed warning.failure must be an object when required warning is missing');
      } else if (!isRecord(summary.warning.failure.evidence)) {
        issues.push('failed warning.failure.evidence must be an object when required warning is missing');
      } else {
        issues.push(
          ...evidenceFieldMismatchIssues('failed warning.failure.evidence', summary.warning.failure.evidence, summary.failure?.evidence, [
            'recorded',
            'eventId',
            'eventKind',
            'eventCategory',
            'verdict',
            'riskCategory',
            'bundleId',
            'bundleEventCount',
            'error',
          ]),
        );
      }
    }
    if (summary.warning?.triggered === true) {
      if (!isNonEmptyString(summary.warning?.eventId)) issues.push('triggered warning.eventId must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.bundleId)) issues.push('triggered warning.bundleId must be a non-empty string');
      if (isNonEmptyString(summary.evidence?.bundleId) && summary.warning?.bundleId !== summary.evidence.bundleId) {
        issues.push('triggered warning.bundleId must match evidence.bundleId');
      }
      if (summary.warning?.isolation?.warningRows !== 1) issues.push('triggered warning isolation.warningRows must be 1');
      if (summary.warning?.isolation?.llmPollutionCount !== 0) issues.push('triggered warning isolation.llmPollutionCount must be 0');
    }
  }
  return issues;
}

function normalizedVerifierSummary(summary) {
  const issues = verifierSummaryIssues(summary);
  if (issues.length > 0) {
    return summaryValidationFailureSummary(summary, issues);
  }
  return summary;
}

function printVerifierSummary(summary) {
  const normalizedSummary = normalizedVerifierSummary(summary);
  if (normalizedSummary !== summary) process.exitCode = 1;
  summary = normalizedSummary;
  verifierSummaryPrinted = true;
  console.log(`VERIFIER_SUMMARY ${JSON.stringify(summary)}`);
  console.log(JSON.stringify(summary, null, 2));
}

function verifierSummaryBase(status) {
  return {
    schemaVersion: verifierSummarySchema,
    status,
    verifier: {
      name: 'verify-a3s-code-skill-api',
      commit: verifierCommit,
      model,
    },
    target: {
      apiBase,
      runId,
      agentId,
      sessionId,
    },
  };
}

function defaultFailureEvidence(phase) {
  return {
    recorded: false,
    error: `failure evidence was not attempted for phase ${phase}`,
  };
}

function summaryValidationFailureSummary(summary, issues) {
  const base = verifierSummaryBase('failed');
  const originalVerifier = isRecord(summary?.verifier) ? summary.verifier : {};
  const originalTarget = isRecord(summary?.target) ? summary.target : {};
  return {
    ...base,
    verifier: {
      ...base.verifier,
      ...originalVerifier,
      name: 'verify-a3s-code-skill-api',
      commit: isNonEmptyString(originalVerifier.commit) ? originalVerifier.commit : verifierCommit,
      model: isNonEmptyString(originalVerifier.model) ? originalVerifier.model : model,
    },
    target: {
      ...base.target,
      apiBase: isNonEmptyString(originalTarget.apiBase) ? originalTarget.apiBase : apiBase,
      runId: isNonEmptyString(originalTarget.runId) ? originalTarget.runId : runId,
      agentId: isNonEmptyString(originalTarget.agentId) ? originalTarget.agentId : agentId,
      sessionId: isNonEmptyString(originalTarget.sessionId) ? originalTarget.sessionId : sessionId,
    },
    failure: {
      phase: 'summary_validation',
      reason: 'verifier summary contract validation failed',
      details: {
        issues,
        originalStatus: isRecord(summary) ? summary.status : undefined,
        originalFailurePhase: isRecord(summary) ? summary.failure?.phase : undefined,
      },
      evidence: defaultFailureEvidence('summary_validation'),
    },
    summaryValidation: {
      status: 'failed',
      issues,
    },
    timings: isRecord(summary?.timings) ? summary.timings : {},
  };
}

function failureSummary(phase, reason, details, timings, failureEvidence) {
  return {
    ...verifierSummaryBase('failed'),
    failure: {
      phase,
      reason,
      details,
      evidence: failureEvidence ?? defaultFailureEvidence(phase),
    },
    timings,
  };
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

async function recordFailureEvidence(reason, details, timings) {
  try {
    const failureAttributes = timingAttributes(timings);
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
                ...failureAttributes,
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
      const matches = list.items?.filter((item) => item.runId === runId && item.agentId === agentId) ?? [];
      const byRecordedId = matches.find((item) => item.eventId === recordedEventId);
      if (byRecordedId) return byRecordedId;
      return list.items?.find(
        (item) =>
          item.runId === runId &&
          item.agentId === agentId &&
          trueAttribute(item.attributes?.['progressive.failure']) &&
          item.attributes?.['progressive.failure.reason'] === reason,
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
    for (const key of Object.keys(failureAttributes)) {
      if (!sameAttributeValue(failureAttrs[key], failureAttributes[key])) {
        throw new Error(`failure evidence lost verifier timing metadata ${key}: ${compact(failureEvent)}`);
      }
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
    if (!isPositiveInteger(bundle.summary?.eventCount)) {
      throw new Error(`failure evidence bundle did not report a positive event count: ${compact(bundle)}`);
    }
    console.error(
      `Recorded and verified AnySentry failure evidence for ${reason}: ${failureEvent.eventId}, bundle ${bundle.bundleId}`,
    );
    return {
      recorded: true,
      eventId: failureEvent.eventId,
      eventKind: failureEvent.eventKind,
      eventCategory: failureEvent.eventCategory,
      verdict: failureEvent.verdict,
      riskCategory: failureEvent.riskCategory,
      bundleId: bundle.bundleId,
      bundleEventCount: bundle.summary?.eventCount,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Unable to record or verify AnySentry failure evidence: ${message}`);
    return {
      recorded: false,
      error: message,
    };
  }
}

async function recordNearTimeoutWarning(event, bundle, timings) {
  if (timings.skill < nearTimeoutThresholdMs) return undefined;
  const warningAttributes = {
    ...verifierAttributes,
    ...timingAttributes(timings),
    'progressive.runner': 'a3s-code',
    'progressive.skill': 'anysentry-api',
    'progressive.warning': 'near_timeout',
    'progressive.warning.reason': 'a3s-code Skill verifier completed close to its timeout budget',
    'progressive.warning.eventId': event.eventId,
    'progressive.warning.bundleId': bundle.bundleId,
    'progressive.warning.thresholdMs': nearTimeoutThresholdMs,
  };
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
            kind: 'RuntimeEvent',
            runtimeKind: 'near_timeout',
            workspacePath,
            agentId,
            sessionId,
            runId,
            model,
            subject: `a3s-code Skill progressive API verification slow success: ${timings.skill}ms of ${skillTimeoutMs}ms`,
            promptTokens: 0,
            completionTokens: 0,
            latencyMs: timings.skill,
            attributes: warningAttributes,
          },
        ],
      },
    }),
  });
  const warningEventId = recorded?.items?.[0]?.eventId;
  const warningEvent = await eventually('near-timeout warning evidence to be queryable', async () => {
    const list = await request('/events/list', {
      method: 'POST',
      body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 20 }),
    });
    return list.items?.find(
      (item) =>
        item.eventId === warningEventId ||
        (item.attributes?.['progressive.warning'] === 'near_timeout' && item.attributes?.['progressive.warning.eventId'] === event.eventId),
    );
  });
  if (!warningEvent?.eventId) {
    throw new Error(`near-timeout warning evidence did not become queryable: ${compact({ recorded, warningEvent })}`);
  }
  if (warningEvent.verdict !== 'allow' || warningEvent.eventKind !== 'RuntimeEvent' || warningEvent.eventCategory !== 'runtime') {
    throw new Error(`near-timeout warning should remain allow evidence: ${compact(warningEvent)}`);
  }
  const warningAttrs = warningEvent.attributes ?? {};
  if (
    warningAttrs['progressive.verifier.commit'] !== verifierCommit ||
    warningAttrs['progressive.warning'] !== 'near_timeout' ||
    warningAttrs['progressive.warning.eventId'] !== event.eventId ||
    warningAttrs['progressive.warning.bundleId'] !== bundle.bundleId ||
    Number(warningAttrs['progressive.warning.thresholdMs']) !== nearTimeoutThresholdMs ||
    Number(warningAttrs['progressive.verifier.skillMs']) !== Math.round(timings.skill)
  ) {
    throw new Error(`near-timeout warning lost audit metadata: ${compact(warningEvent)}`);
  }
  const warningRows = await request('/events/list', {
    method: 'POST',
    body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 50 }),
  });
  const warningItems =
    warningRows.items?.filter(
      (item) => item.runId === runId && item.agentId === agentId && item.attributes?.['progressive.warning'] === 'near_timeout',
    ) ?? [];
  const llmPollution = warningItems.filter((item) => item.eventKind === 'LlmCall' || item.eventCategory === 'llm');
  if (llmPollution.length > 0) {
    throw new Error(`near-timeout warning polluted LLM metrics: ${compact(llmPollution)}`);
  }
  const nonRuntimeWarnings = warningItems.filter((item) => item.eventKind !== 'RuntimeEvent' || item.eventCategory !== 'runtime');
  if (nonRuntimeWarnings.length > 0) {
    throw new Error(`near-timeout warning rows must stay runtime evidence: ${compact(nonRuntimeWarnings)}`);
  }
  if (warningItems.length !== 1) {
    throw new Error(`near-timeout warning must produce exactly one runtime evidence row: ${compact(warningItems)}`);
  }
  return {
    ...warningEvent,
    verifierIsolation: {
      warningRows: warningItems.length,
      llmPollutionCount: llmPollution.length,
    },
  };
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

function jsonObjectCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

function parseSkillOutputJson(result) {
  const output = String(result?.output ?? '').trim();
  if (!output) throw new Error('Skill output was empty');
  try {
    const parsed = JSON.parse(output);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to extracting a JSON object from tool output wrappers.
  }
  for (const candidate of jsonObjectCandidates(output).reverse()) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Skill output did not contain a JSON object: ${compact(output)}`);
}

function runVerifierSelfTest() {
  const passedSummary = {
    ...verifierSummaryBase('passed'),
    verifier: {
      ...verifierSummaryBase('passed').verifier,
      skill: 'anysentry-api',
      toolCalls: 1,
    },
    evidence: {
      eventId: 'evt_self_test',
      eventKind: 'LlmCall',
      verdict: 'allow',
      bundleId: 'evb_self_test',
      bundleEventCount: 1,
      skillOutput: {
        eventId: 'evt_self_test',
        eventKind: 'LlmCall',
        verdict: 'allow',
        bundleId: 'evb_self_test',
        bundleEventCount: 1,
        queriedBack: true,
      },
    },
    warning: {
      required: true,
      triggered: true,
      thresholdMs: 100,
      eventId: 'evt_warning_self_test',
      bundleId: 'evb_self_test',
      isolation: {
        warningRows: 1,
        llmPollutionCount: 0,
      },
    },
    timings: {
      skill: 75,
      elapsed: 100,
    },
  };
  assert('verifier self-test accepts the passed summary contract', verifierSummaryIssues(passedSummary).length === 0, verifierSummaryIssues(passedSummary));

  const missingVerifierSkillSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      skill: undefined,
    },
  };
  assert(
    'verifier self-test rejects passed summaries without the Skill name',
    verifierSummaryIssues(missingVerifierSkillSummary).includes('passed summary verifier.skill must be anysentry-api'),
    verifierSummaryIssues(missingVerifierSkillSummary),
  );
  const zeroToolCallSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      toolCalls: 0,
    },
  };
  assert(
    'verifier self-test rejects passed summaries without tool calls',
    verifierSummaryIssues(zeroToolCallSummary).includes('passed summary verifier.toolCalls must be a positive integer'),
    verifierSummaryIssues(zeroToolCallSummary),
  );
  const missingWarningSummary = {
    ...passedSummary,
    warning: undefined,
  };
  assert(
    'verifier self-test rejects passed summaries without warning budget state',
    verifierSummaryIssues(missingWarningSummary).includes('passed summary warning must be an object'),
    verifierSummaryIssues(missingWarningSummary),
  );
  const missingRequiredWarningSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      triggered: false,
      eventId: undefined,
      bundleId: undefined,
      isolation: undefined,
    },
  };
  assert(
    'verifier self-test rejects passed summaries missing a required warning',
    verifierSummaryIssues(missingRequiredWarningSummary).includes('passed summary required warning must be triggered'),
    verifierSummaryIssues(missingRequiredWarningSummary),
  );

  const failedSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      recorded: true,
      eventId: 'evt_failure_self_test',
      eventKind: 'SecurityAction',
      eventCategory: 'security',
      verdict: 'block',
      riskCategory: 'runtime_failure',
      bundleId: 'evb_failure_self_test',
      bundleEventCount: 1,
    },
  );
  assert('verifier self-test accepts the failed summary contract', verifierSummaryIssues(failedSummary).length === 0, verifierSummaryIssues(failedSummary));

  const driftedFailureSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      verdict: 'allow',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence that looks allow-listed',
    verifierSummaryIssues(driftedFailureSummary).includes('recorded failure evidence.verdict must be a non-allow string'),
    verifierSummaryIssues(driftedFailureSummary),
  );

  const missingFailureBundleCountSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      bundleEventCount: 0,
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence without a bundle count',
    verifierSummaryIssues(missingFailureBundleCountSummary).includes(
      'recorded failure evidence.bundleEventCount must be a positive integer',
    ),
    verifierSummaryIssues(missingFailureBundleCountSummary),
  );

  const requiredWarningFailureSummary = {
    ...failedSummary,
    failure: {
      ...failedSummary.failure,
      phase: 'near_timeout_warning',
      reason: 'required near-timeout warning was not emitted',
    },
    warning: {
      required: true,
      triggered: false,
      thresholdMs: 100,
      failure: {
        evidence: failedSummary.failure.evidence,
      },
    },
  };
  assert(
    'verifier self-test accepts required-warning failures bound to top-level evidence',
    verifierSummaryIssues(requiredWarningFailureSummary).length === 0,
    verifierSummaryIssues(requiredWarningFailureSummary),
  );

  const driftedWarningFailureSummary = {
    ...requiredWarningFailureSummary,
    warning: {
      ...requiredWarningFailureSummary.warning,
      failure: {
        ...requiredWarningFailureSummary.warning.failure,
        evidence: {
          ...requiredWarningFailureSummary.warning.failure.evidence,
          eventId: 'evt_other_failure',
        },
      },
    },
  };
  assert(
    'verifier self-test rejects warning failure evidence drift',
    verifierSummaryIssues(driftedWarningFailureSummary).includes(
      'failed warning.failure.evidence.eventId must match failure.evidence.eventId',
    ),
    verifierSummaryIssues(driftedWarningFailureSummary),
  );

  const unrecordedFailureSummary = failureSummary(
    'preflight',
    'required local verifier prerequisites are missing',
    { aclPath: '/missing/config.acl' },
    { elapsed: 1 },
  );
  assert(
    'verifier self-test accepts explicit unrecorded failure evidence',
    unrecordedFailureSummary.failure.evidence.recorded === false && verifierSummaryIssues(unrecordedFailureSummary).length === 0,
    { summary: unrecordedFailureSummary, issues: verifierSummaryIssues(unrecordedFailureSummary) },
  );

  const mismatchedSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        bundleId: 'evb_mismatch',
      },
    },
  };
  assert(
    'verifier self-test rejects mismatched Skill output IDs',
    verifierSummaryIssues(mismatchedSummary).includes('passed summary bundleId must match skillOutput.bundleId'),
    verifierSummaryIssues(mismatchedSummary),
  );
  const driftedEvidenceSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      eventKind: 'RuntimeEvent',
    },
  };
  assert(
    'verifier self-test rejects passed summaries with drifted evidence kind',
    verifierSummaryIssues(driftedEvidenceSummary).includes('passed summary evidence.eventKind must be LlmCall'),
    verifierSummaryIssues(driftedEvidenceSummary),
  );
  const driftedSkillOutputSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        queriedBack: false,
      },
    },
  };
  assert(
    'verifier self-test rejects Skill outputs that were not queried back',
    verifierSummaryIssues(driftedSkillOutputSummary).includes('passed summary evidence.skillOutput.queriedBack must be true'),
    verifierSummaryIssues(driftedSkillOutputSummary),
  );
  const mismatchedBundleCountSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        bundleEventCount: 2,
      },
    },
  };
  assert(
    'verifier self-test rejects mismatched Evidence Bundle counts',
    verifierSummaryIssues(mismatchedBundleCountSummary).includes(
      'passed summary bundleEventCount must match skillOutput.bundleEventCount',
    ),
    verifierSummaryIssues(mismatchedBundleCountSummary),
  );
  const missingWarningBundleSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      bundleId: undefined,
    },
  };
  assert(
    'verifier self-test rejects triggered warnings without bundle IDs',
    verifierSummaryIssues(missingWarningBundleSummary).includes('triggered warning.bundleId must be a non-empty string'),
    verifierSummaryIssues(missingWarningBundleSummary),
  );
  const mismatchedWarningBundleSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      bundleId: 'evb_other',
    },
  };
  assert(
    'verifier self-test rejects warning bundle IDs that do not match evidence',
    verifierSummaryIssues(mismatchedWarningBundleSummary).includes('triggered warning.bundleId must match evidence.bundleId'),
    verifierSummaryIssues(mismatchedWarningBundleSummary),
  );
  const duplicateWarningRowsSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      isolation: {
        ...passedSummary.warning.isolation,
        warningRows: 2,
      },
    },
  };
  assert(
    'verifier self-test rejects duplicate warning rows',
    verifierSummaryIssues(duplicateWarningRowsSummary).includes('triggered warning isolation.warningRows must be 1'),
    verifierSummaryIssues(duplicateWarningRowsSummary),
  );
  const normalizedMismatch = normalizedVerifierSummary(mismatchedSummary);
  assert(
    'verifier self-test converts invalid passed summaries into failed summary-validation results',
    normalizedMismatch.status === 'failed' &&
      normalizedMismatch.failure?.phase === 'summary_validation' &&
      verifierSummaryIssues(normalizedMismatch).length === 0,
    { summary: normalizedMismatch, issues: verifierSummaryIssues(normalizedMismatch) },
  );

  const invalidFailureSummary = {
    ...verifierSummaryBase('failed'),
    failure: { reason: 'missing phase' },
    timings: {},
  };
  assert(
    'verifier self-test rejects failed summaries without a phase',
    verifierSummaryIssues(invalidFailureSummary).includes('failed summary failure.phase must be a non-empty string'),
    verifierSummaryIssues(invalidFailureSummary),
  );

  assert(
    'verifier self-test rejects failed summaries without evidence status',
    verifierSummaryIssues(invalidFailureSummary).includes('failed summary failure.evidence must be an object'),
    verifierSummaryIssues(invalidFailureSummary),
  );

  const directSkillOutput = parseSkillOutputJson({ output: '{"eventId":"evt_a","bundleId":"evb_a"}' });
  assert('verifier self-test parses compact Skill JSON output', directSkillOutput.eventId === 'evt_a' && directSkillOutput.bundleId === 'evb_a', directSkillOutput);
  const wrappedSkillOutput = parseSkillOutputJson({ output: 'log line {"ignored":true}\n{"eventId":"evt_b","bundleId":"evb_b"}' });
  assert('verifier self-test extracts the final Skill JSON object from wrapper output', wrappedSkillOutput.eventId === 'evt_b' && wrappedSkillOutput.bundleId === 'evb_b', wrappedSkillOutput);
  try {
    parseSkillOutputJson({ output: 'not json' });
    fail('verifier self-test rejects non-JSON Skill output');
  } catch {
    pass('verifier self-test rejects non-JSON Skill output');
  }

  if (process.exitCode) process.exit(process.exitCode);
  console.log('a3s-code Skill verifier self-test passed');
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
const flowStartedAt = Date.now();
const flowTimings = {};

async function timed(label, fn) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    flowTimings[label] = Math.max(0, Date.now() - startedAt);
  }
}

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

await timed('innerHealthzMs', () => request('/healthz'));

const modules = await timed('innerListMs', () => request('/capabilities?action=list'));
if (!Array.isArray(modules) || !modules.some((module) => module.name === 'security-center')) {
  throw new Error(\`security-center module missing from list: \${JSON.stringify(modules)}\`);
}

const operation = await timed('innerDescribeRecordMs', () =>
  request('/capabilities?action=describe&module=security-center&operation=recordSecurityEvents'),
);
if (operation?.name !== 'recordSecurityEvents' || !operation.inputSchema) {
  throw new Error(\`recordSecurityEvents describe failed: \${JSON.stringify(operation)}\`);
}

const preRecordMs = Math.max(0, Date.now() - flowStartedAt);
const recorded = await timed('innerRecordMs', () => request('/capabilities', {
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
            'progressive.verifier.innerHealthzMs': flowTimings.innerHealthzMs,
            'progressive.verifier.innerListMs': flowTimings.innerListMs,
            'progressive.verifier.innerDescribeRecordMs': flowTimings.innerDescribeRecordMs,
            'progressive.verifier.innerPreRecordMs': preRecordMs,
            'progressive.runner': 'a3s-code',
            'progressive.skill': 'anysentry-api',
            'progressive.flow': 'healthz,list,describe,execute,events-list,build-evidence-bundle',
            'progressive.model': model,
          },
        },
      ],
    },
  }),
}));

const eventId = recorded.items?.[0]?.eventId;
if (recorded.accepted !== true || !eventId) {
  throw new Error(\`recordSecurityEvents did not accept one event: \${JSON.stringify(recorded)}\`);
}

const event = await timed('innerQueryEventMs', () => eventually('recorded event to be queryable', async () => {
  const list = await request('/events/list', {
    method: 'POST',
    body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
  });
  return list.items?.find((item) => item.eventId === eventId && item.runId === runId && item.agentId === agentId);
}));

const bundle = await timed('innerBundleMs', () => request('/capabilities', {
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
}));
if (bundle?.schemaVersion !== 'anysentry.evidence_bundle.v1' || !bundle.events?.some((item) => item.eventId === eventId)) {
  throw new Error(\`buildEvidenceBundle did not include the recorded event: \${JSON.stringify(bundle)}\`);
}
flowTimings.innerTotalMs = Math.max(0, Date.now() - flowStartedAt);

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
  timings: flowTimings,
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
  const verifierStartedAt = Date.now();
  const timings = {};
  lastVerifierTimings = timings;
  console.log('AnySentry a3s-code Skill progressive API verification');
  console.log(`API base: ${apiBase}`);
  console.log(`Model: ${model}`);
  console.log(`Run ID: ${runId}`);
  console.log(`Near-timeout threshold: ${nearTimeoutThresholdMs}ms (${nearTimeoutThresholdRatio})`);
  console.log(`Require near-timeout warning: ${requireNearTimeoutWarning ? 'yes' : 'no'}`);

  assert('a3s-code ACL exists', fs.existsSync(aclPath), `Set A3S_CODE_ACL. Missing: ${aclPath}`);
  assert('anysentry-api Skill directory exists', fs.existsSync(path.join(skillRoot, 'anysentry-api', 'SKILL.md')), skillRoot);
  if (process.exitCode) {
    timings.elapsed = durationMs(verifierStartedAt);
    printVerifierSummary(failureSummary('preflight', 'required local verifier prerequisites are missing', { aclPath, skillRoot }, timings));
    process.exit(process.exitCode);
  }

  async function failPhase(phase, reason, details, failureEvidenceOverride) {
    timings.elapsed = durationMs(verifierStartedAt);
    const failureTimings = {
      ...timings,
      failurePhase: phase,
    };
    const failureEvidence = failureEvidenceOverride ?? (await recordFailureEvidence(reason, details, failureTimings));
    printVerifierSummary(failureSummary(phase, reason, details, failureTimings, failureEvidence));
    throw new Error(reason);
  }

  const healthStartedAt = Date.now();
  try {
    await request('/healthz');
    timings.healthz = durationMs(healthStartedAt);
  } catch (error) {
    timings.healthz = durationMs(healthStartedAt);
    const details = error instanceof Error ? error.message : String(error);
    await failPhase('healthz', 'AnySentry API healthz failed before a3s-code run', details, {
      recorded: false,
      error: 'AnySentry API healthz failed before failure evidence could be written',
    });
  }
  pass('AnySentry API healthz responds before a3s-code run');

  const loadStartedAt = Date.now();
  let Agent;
  try {
    ({ Agent } = await loadA3sCode());
    timings.loadA3sCode = durationMs(loadStartedAt);
  } catch (error) {
    timings.loadA3sCode = durationMs(loadStartedAt);
    const details = error instanceof Error ? error.message : String(error);
    await failPhase('load_a3s_code', 'unable to load @a3s-lab/code before a3s-code run', details);
  }
  const createAgentStartedAt = Date.now();
  let agent;
  try {
    agent = await Agent.create(aclPath);
    timings.createAgent = durationMs(createAgentStartedAt);
  } catch (error) {
    timings.createAgent = durationMs(createAgentStartedAt);
    const details = error instanceof Error ? error.message : String(error);
    await failPhase('agent_create', 'unable to create a3s-code Agent before Skill run', details);
  }
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

  async function requireVerification(message, condition, phase, reason, details) {
    assert(message, condition, details);
    if (!condition) await failPhase(phase, reason, details);
  }

  try {
    const toolNames = session.toolNames();
    await requireVerification(
      'a3s-code exposes Skill, search_skills, and bash tools',
      ['Skill', 'search_skills', 'bash'].every((name) => toolNames.includes(name)),
      'tool_capabilities',
      'a3s-code did not expose required Skill, search_skills, and bash tools',
      { toolNames },
    );

    let search;
    try {
      const searchStartedAt = Date.now();
      search = await withTimeout(
        'a3s-code search_skills tool invocation',
        () => session.tool('search_skills', { query: 'AnySentry progressive API', limit: 5 }),
        Math.min(skillTimeoutMs, 60000),
        () => closeSession('search_skills timeout'),
      );
      timings.searchSkills = durationMs(searchStartedAt);
    } catch (error) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'search_skills tool invocation failed or timed out';
      const details = error instanceof Error ? error.message : String(error);
      const failureTimings = {
        ...timings,
        failurePhase: 'search_skills',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('search_skills', reason, details, failureTimings, failureEvidence));
      throw error;
    }
    await requireVerification(
      'a3s-code discovers the anysentry-api Skill',
      String(search.output ?? '').includes('anysentry-api'),
      'search_skills',
      'a3s-code did not discover the anysentry-api Skill',
      search,
    );

    let result;
    try {
      const skillStartedAt = Date.now();
      result = await withTimeout(
        'a3s-code Skill tool invocation',
        () => session.tool('Skill', {
          skill_name: 'anysentry-api',
          prompt: buildSkillPrompt(),
        }),
        skillTimeoutMs,
        () => closeSession('Skill timeout'),
      );
      timings.skill = durationMs(skillStartedAt);
    } catch (error) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'Skill tool invocation failed or timed out';
      const details = error instanceof Error ? error.message : String(error);
      const failureTimings = {
        ...timings,
        failurePhase: 'skill',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('skill', reason, details, failureTimings, failureEvidence));
      throw error;
    }
    const metadata = parseMetadataJson(result);

    assert('a3s-code Skill tool invocation succeeds', result.exitCode === 0, result);
    assert('Skill invocation is for anysentry-api', metadata.skill_name === 'anysentry-api', metadata);
    assert('Skill used at least one tool while applying the API flow', Number(metadata.tool_calls ?? 0) >= 1, metadata);
    if (result.exitCode !== 0 || metadata.skill_name !== 'anysentry-api' || Number(metadata.tool_calls ?? 0) < 1) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'skill invocation returned an invalid result';
      const details = { result, metadata };
      const failureTimings = {
        ...timings,
        failurePhase: 'skill_result',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('skill_result', reason, details, failureTimings, failureEvidence));
      throw new Error(reason);
    }
    let skillOutput;
    try {
      skillOutput = parseSkillOutputJson(result);
    } catch (error) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'skill output JSON was invalid';
      const details = error instanceof Error ? error.message : String(error);
      const failureTimings = {
        ...timings,
        failurePhase: 'skill_output',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('skill_output', reason, details, failureTimings, failureEvidence));
      throw error;
    }
    const outputMatchesRun =
      typeof skillOutput.eventId === 'string' &&
      typeof skillOutput.bundleId === 'string' &&
      skillOutput.runId === runId &&
      skillOutput.agentId === agentId &&
      skillOutput.queriedBack === true;
    assert('Skill output reports the recorded event and bundle for this run', outputMatchesRun, skillOutput);
    if (!outputMatchesRun) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'skill output did not match the verifier run';
      const details = { skillOutput, runId, agentId };
      const failureTimings = {
        ...timings,
        failurePhase: 'skill_output',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('skill_output', reason, details, failureTimings, failureEvidence));
      throw new Error(reason);
    }

    const queryStartedAt = Date.now();
    const event = await eventually('event recorded by a3s-code Skill run', async () => {
      const list = await request('/events/list', {
        method: 'POST',
        body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 10 }),
      });
      return list.items?.find((item) => item.eventId === skillOutput.eventId && item.runId === runId && item.agentId === agentId);
    });
    timings.queryEvent = durationMs(queryStartedAt);

    await requireVerification(
      'AnySentry stores the event created through progressive execute',
      Boolean(event?.eventId),
      'event_query',
      'event recorded by the a3s-code Skill run was not queryable',
      event,
    );
    await requireVerification(
      'stored event ID matches the Skill output',
      event?.eventId === skillOutput.eventId,
      'event_binding',
      'stored event ID did not match the Skill output',
      { event, skillOutput },
    );
    await requireVerification(
      'stored event remains LlmCall allow evidence',
      event?.eventKind === 'LlmCall' && event?.verdict === 'allow',
      'event_contract',
      'stored event was not LlmCall allow evidence',
      event,
    );
    await requireVerification(
      'stored event carries the a3s-code Skill evidence markers',
      event?.attributes?.['progressive.skill'] === 'anysentry-api' && event?.attributes?.['progressive.runner'] === 'a3s-code',
      'event_contract',
      'stored event lost a3s-code Skill evidence markers',
      event,
    );
    await requireVerification(
      'stored event carries verifier audit metadata',
      event?.attributes?.['progressive.verifier.commit'] === verifierCommit &&
        Number(event?.attributes?.['progressive.verifier.skillTimeoutMs']) === skillTimeoutMs &&
        Number(event?.attributes?.['progressive.verifier.sessionCloseTimeoutMs']) === sessionCloseTimeoutMs,
      'event_contract',
      'stored event lost verifier audit metadata',
      event,
    );
    await requireVerification(
      'stored event carries inner API timing metadata',
      Number(event?.attributes?.['progressive.verifier.innerPreRecordMs']) >= 0 &&
        Number(event?.attributes?.['progressive.verifier.innerHealthzMs']) >= 0 &&
        Number(event?.attributes?.['progressive.verifier.innerListMs']) >= 0 &&
        Number(event?.attributes?.['progressive.verifier.innerDescribeRecordMs']) >= 0,
      'event_contract',
      'stored event lost inner API timing metadata',
      event,
    );
    const bundleStartedAt = Date.now();
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
    timings.bundle = durationMs(bundleStartedAt);
    timings.elapsed = durationMs(verifierStartedAt);
    await requireVerification(
      'stored event builds an Evidence Bundle through the progressive API',
      bundle?.schemaVersion === 'anysentry.evidence_bundle.v1' && bundle.events?.some((item) => item.eventId === event.eventId),
      'evidence_bundle',
      'evidence bundle did not include the stored event',
      bundle,
    );
    assert('Evidence Bundle ID matches the Skill output', bundle?.bundleId === skillOutput.bundleId, { bundle, skillOutput });
    if (bundle?.bundleId !== skillOutput.bundleId) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'evidence bundle did not match the Skill output';
      const details = { eventId: event.eventId, outerBundleId: bundle?.bundleId, skillBundleId: skillOutput.bundleId };
      const failureTimings = {
        ...timings,
        failurePhase: 'evidence_bundle',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      printVerifierSummary(failureSummary('evidence_bundle', reason, details, failureTimings, failureEvidence));
      throw new Error(reason);
    }
    let warningEvent;
    try {
      warningEvent = await recordNearTimeoutWarning(event, bundle, timings);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      await failPhase('near_timeout_warning', 'near-timeout warning evidence failed validation', details);
    }
    let warningRequirementFailure;
    let summaryFailure;
    if (warningEvent) pass('near-timeout success warning evidence is queryable and non-blocking');
    else if (requireNearTimeoutWarning) {
      const details = {
        skillMs: Math.round(timings.skill),
        thresholdMs: nearTimeoutThresholdMs,
        nearTimeoutRatio: nearTimeoutThresholdRatio,
      };
      warningRequirementFailure = details;
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'required near-timeout warning was not emitted';
      const failureTimings = {
        ...timings,
        failurePhase: 'near_timeout_warning',
      };
      const failureEvidence = await recordFailureEvidence(reason, details, failureTimings);
      warningRequirementFailure = { ...details, evidence: failureEvidence };
      summaryFailure = {
        phase: 'near_timeout_warning',
        reason,
        details,
        evidence: failureEvidence,
      };
      fail('required near-timeout warning evidence is present when requested', details);
    } else {
      pass('near-timeout warning was not emitted because the Skill run stayed below threshold');
    }

    printVerifierSummary({
      schemaVersion: verifierSummarySchema,
      status: process.exitCode ? 'failed' : 'passed',
      verifier: {
        name: 'verify-a3s-code-skill-api',
        commit: verifierCommit,
        model,
        skill: metadata.skill_name,
        toolCalls: Number(metadata.tool_calls ?? 0),
      },
      target: {
        apiBase,
        runId,
        agentId,
        sessionId,
      },
      evidence: {
        eventId: event.eventId,
        eventKind: event.eventKind,
        verdict: event.verdict,
        bundleId: bundle.bundleId,
        bundleEventCount: bundle.summary?.eventCount,
        skillOutput: {
          eventId: skillOutput.eventId,
          eventKind: skillOutput.eventKind,
          verdict: skillOutput.verdict,
          bundleId: skillOutput.bundleId,
          bundleEventCount: skillOutput.bundleEventCount,
          queriedBack: skillOutput.queriedBack,
        },
      },
      warning: {
        required: requireNearTimeoutWarning,
        triggered: Boolean(warningEvent),
        thresholdMs: nearTimeoutThresholdMs,
        eventId: warningEvent?.eventId,
        bundleId: warningEvent?.attributes?.['progressive.warning.bundleId'],
        isolation: warningEvent?.verifierIsolation,
        failure: warningRequirementFailure,
      },
      ...(summaryFailure ? { failure: summaryFailure } : {}),
      timings,
    });
  } finally {
    await closeSession('verification completion');
  }

  if (process.exitCode) {
    console.error('a3s-code Skill progressive API verification failed');
    process.exit(process.exitCode);
  }
  console.log('a3s-code Skill progressive API verification passed');
}

if (verifierSelfTest) {
  runVerifierSelfTest();
} else {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    fail('verification threw', message);
    if (!verifierSummaryPrinted) {
      lastVerifierTimings.elapsed = durationMs(verifierProcessStartedAt);
      printVerifierSummary(failureSummary('uncaught', 'verification threw', message, lastVerifierTimings));
    }
    process.exit(process.exitCode || 1);
  });
}
