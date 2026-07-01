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
const innerVerifierScript = path.join(repoRoot, 'scripts/verify-a3s-code-skill-inner.mjs');
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
const skillOutputTimingFields = [
  'innerHealthzMs',
  'innerListMs',
  'innerDescribeRecordMs',
  'innerPreRecordMs',
  'innerRecordMs',
  'innerQueryEventMs',
  'innerBundleMs',
  'innerTotalMs',
];
const eventInnerTimingFields = ['innerHealthzMs', 'innerListMs', 'innerDescribeRecordMs', 'innerPreRecordMs'];
const expectedProgressiveFlow = 'healthz,list,describe,execute,events-list,build-evidence-bundle';
const expectedDescribedOperation = 'recordSecurityEvents';
const skillOutputPreflightBindings = [
  { field: 'healthOk', summaryField: 'healthOk', attribute: 'progressive.verifier.healthOk', expected: true },
  { field: 'listed', summaryField: 'listed', attribute: 'progressive.verifier.listed', expected: true },
  {
    field: 'described',
    summaryField: 'describedOperation',
    attribute: 'progressive.verifier.describedOperation',
    expected: expectedDescribedOperation,
  },
];
const nearTimeoutWarningReason = 'a3s-code Skill verifier completed close to its timeout budget';

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
  if (typeof expected === 'boolean') return actual === expected || String(actual).toLowerCase() === String(expected);
  return actual === expected;
}

function expectedValueText(value) {
  return String(value);
}

function verifierAttributeIssues(attributes) {
  const issues = [];
  for (const [key, expected] of Object.entries(verifierAttributes)) {
    if (!sameAttributeValue(attributes?.[key], expected)) {
      issues.push(key);
    }
  }
  return issues;
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

function isValidTimingValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  return isNonEmptyString(value);
}

function hasFailureDetails(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return value !== undefined && value !== null;
}

function timingIssues(timings) {
  const issues = [];
  for (const [key, value] of Object.entries(timings)) {
    if (!isValidTimingValue(value)) {
      issues.push(`timings.${key} must be a non-negative number or non-empty string`);
    }
  }
  return issues;
}

function sanitizedTimings(timings) {
  if (!isRecord(timings)) return {};
  return Object.fromEntries(Object.entries(timings).filter(([, value]) => isValidTimingValue(value)));
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

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => isNonEmptyString(item));
}

function sameStringArray(left, right) {
  return stringArray(left) && stringArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
}

function skillOutputTimingIssues(timings, context) {
  const issues = [];
  if (!isRecord(timings)) {
    return [`${context} evidence.skillOutput.timings must be an object`];
  }
  for (const field of skillOutputTimingFields) {
    if (!isFiniteNumber(timings[field]) || timings[field] < 0) {
      issues.push(`${context} evidence.skillOutput.timings.${field} must be a non-negative number`);
    }
  }
  if (isFiniteNumber(timings.innerTotalMs)) {
    for (const field of skillOutputTimingFields.filter((item) => item !== 'innerTotalMs')) {
      if (isFiniteNumber(timings[field]) && timings.innerTotalMs < timings[field]) {
        issues.push(`${context} evidence.skillOutput.timings.innerTotalMs must be greater than or equal to ${field}`);
      }
    }
  }
  return issues;
}

function eventInnerTimingAttributeIssues(attributes, timings) {
  const issues = [];
  if (!isRecord(attributes)) {
    return ['event attributes must be an object'];
  }
  if (!isRecord(timings)) {
    return ['evidence.skillOutput.timings must be an object'];
  }
  for (const field of eventInnerTimingFields) {
    const expected = timings[field];
    const attributeKey = `progressive.verifier.${field}`;
    if (!isFiniteNumber(expected) || expected < 0) {
      issues.push(`evidence.skillOutput.timings.${field} must be a non-negative number`);
    } else if (Number(attributes[attributeKey]) !== Math.round(expected)) {
      issues.push(`event attributes ${attributeKey} must match evidence.skillOutput.timings.${field}`);
    }
  }
  return issues;
}

function skillEventAttributeIssues(attributes) {
  const issues = [];
  if (!isRecord(attributes)) {
    return ['event attributes must be an object'];
  }
  if (attributes['progressive.runner'] !== 'a3s-code') {
    issues.push('event attribute progressive.runner must be a3s-code');
  }
  if (attributes['progressive.skill'] !== 'anysentry-api') {
    issues.push('event attribute progressive.skill must be anysentry-api');
  }
  if (attributes['progressive.flow'] !== expectedProgressiveFlow) {
    issues.push('event attribute progressive.flow must match the expected progressive flow');
  }
  if (attributes['progressive.model'] !== model) {
    issues.push('event attribute progressive.model must match the verifier model');
  }
  return issues;
}

function skillOutputPreflightIssues(skillOutput, prefix) {
  const issues = [];
  for (const { field, expected } of skillOutputPreflightBindings) {
    if (skillOutput?.[field] !== expected) {
      issues.push(`${prefix}.${field} must be ${expectedValueText(expected)}`);
    }
  }
  return issues;
}

function eventPreflightAttributeIssues(attributes, skillOutput) {
  const issues = [];
  if (!isRecord(attributes)) {
    return ['event attributes must be an object'];
  }
  if (!isRecord(skillOutput)) {
    return ['skillOutput must be an object'];
  }
  for (const { field, attribute, expected } of skillOutputPreflightBindings) {
    if (!sameAttributeValue(attributes[attribute], expected)) {
      issues.push(`event attribute ${attribute} must be ${expectedValueText(expected)}`);
    } else if (!sameAttributeValue(attributes[attribute], skillOutput[field])) {
      issues.push(`event attribute ${attribute} must match skillOutput.${field}`);
    }
  }
  return issues;
}

function persistedPreflightAttributeEvidence(attributes) {
  if (!isRecord(attributes)) return {};
  return Object.fromEntries(
    skillOutputPreflightBindings.map(({ summaryField, attribute }) => [summaryField, attributes[attribute]]),
  );
}

function persistedPreflightAttributeIssues(persistedAttributes, skillOutput, context) {
  const issues = [];
  if (!isRecord(persistedAttributes)) {
    return [`${context} evidence.persistedPreflightAttributes must be an object`];
  }
  if (!isRecord(skillOutput)) {
    return [`${context} evidence.skillOutput must be an object`];
  }
  for (const { field, summaryField, expected } of skillOutputPreflightBindings) {
    if (!sameAttributeValue(persistedAttributes[summaryField], expected)) {
      issues.push(`${context} evidence.persistedPreflightAttributes.${summaryField} must be ${expectedValueText(expected)}`);
    } else if (!sameAttributeValue(persistedAttributes[summaryField], skillOutput[field])) {
      issues.push(`${context} evidence.persistedPreflightAttributes.${summaryField} must match skillOutput.${field}`);
    }
  }
  return issues;
}

function skillOutputEvidenceIssues(skillOutput) {
  const issues = [];
  if (!isRecord(skillOutput)) {
    return ['skillOutput must be an object'];
  }
  if (!isNonEmptyString(skillOutput.eventId)) {
    issues.push('skillOutput.eventId must be a non-empty string');
  }
  if (!isNonEmptyString(skillOutput.bundleId)) {
    issues.push('skillOutput.bundleId must be a non-empty string');
  }
  if (skillOutput.workspacePath !== workspacePath) {
    issues.push('skillOutput.workspacePath must match the verifier workspacePath');
  }
  if (skillOutput.runId !== runId) {
    issues.push('skillOutput.runId must match the verifier runId');
  }
  if (skillOutput.agentId !== agentId) {
    issues.push('skillOutput.agentId must match the verifier agentId');
  }
  if (skillOutput.sessionId !== sessionId) {
    issues.push('skillOutput.sessionId must match the verifier sessionId');
  }
  issues.push(...skillOutputPreflightIssues(skillOutput, 'skillOutput'));
  if (skillOutput.eventKind !== 'LlmCall') {
    issues.push('skillOutput.eventKind must be LlmCall');
  }
  if (skillOutput.eventCategory !== 'llm') {
    issues.push('skillOutput.eventCategory must be llm');
  }
  if (skillOutput.verdict !== 'allow') {
    issues.push('skillOutput.verdict must be allow');
  }
  if (skillOutput.bundleSchemaVersion !== 'anysentry.evidence_bundle.v1') {
    issues.push('skillOutput.bundleSchemaVersion must be anysentry.evidence_bundle.v1');
  }
  if (skillOutput.bundleContainsEvent !== true) {
    issues.push('skillOutput.bundleContainsEvent must be true');
  }
  if (!isPositiveInteger(skillOutput.bundleEventCount)) {
    issues.push('skillOutput.bundleEventCount must be a positive integer');
  }
  if (skillOutput.queriedBack !== true) {
    issues.push('skillOutput.queriedBack must be true');
  }
  issues.push(...skillOutputTimingIssues(skillOutput.timings, 'Skill output'));
  return issues;
}

function evidenceBundleBindingIssues(bundle, skillOutput, eventId) {
  const issues = [];
  if (!isRecord(bundle)) {
    return ['bundle must be an object'];
  }
  if (!isRecord(skillOutput)) {
    return ['skillOutput must be an object'];
  }
  if (!isNonEmptyString(skillOutput.bundleId)) {
    issues.push('skillOutput.bundleId must be a non-empty string');
  } else if (bundle.bundleId !== skillOutput.bundleId) {
    issues.push('bundle.bundleId must match skillOutput.bundleId');
  }
  if (bundle.schemaVersion !== 'anysentry.evidence_bundle.v1') {
    issues.push('bundle.schemaVersion must be anysentry.evidence_bundle.v1');
  }
  if (bundle.schemaVersion !== skillOutput.bundleSchemaVersion) {
    issues.push('bundle.schemaVersion must match skillOutput.bundleSchemaVersion');
  }
  const bundleContainsEvent = Array.isArray(bundle.events) && bundle.events.some((item) => item.eventId === eventId);
  if (bundleContainsEvent !== true) {
    issues.push('bundle.events must contain the stored event');
  }
  if (bundleContainsEvent !== skillOutput.bundleContainsEvent) {
    issues.push('bundle event membership must match skillOutput.bundleContainsEvent');
  }
  if (!isPositiveInteger(skillOutput.bundleEventCount)) {
    issues.push('skillOutput.bundleEventCount must be a positive integer');
  } else if (bundle.summary?.eventCount !== skillOutput.bundleEventCount) {
    issues.push('bundle.summary.eventCount must match skillOutput.bundleEventCount');
  }
  return issues;
}

function warningEvidenceBindingIssues(warningEvent, event, bundle, timings) {
  const issues = [];
  if (!isRecord(warningEvent)) {
    return ['warningEvent must be an object'];
  }
  if (!isRecord(event)) {
    return ['source event must be an object'];
  }
  if (!isRecord(bundle)) {
    return ['bundle must be an object'];
  }
  if (!isRecord(timings)) {
    return ['timings must be an object'];
  }
  if (!isNonEmptyString(warningEvent.eventId)) {
    issues.push('warningEvent.eventId must be a non-empty string');
  } else if (warningEvent.eventId === event.eventId) {
    issues.push('warningEvent.eventId must differ from the source event ID');
  }
  if (warningEvent.verdict !== 'allow' || warningEvent.eventKind !== 'RuntimeEvent' || warningEvent.eventCategory !== 'runtime') {
    issues.push('warningEvent must remain RuntimeEvent runtime allow evidence');
  }
  if (
    warningEvent.workspacePath !== workspacePath ||
    warningEvent.runId !== runId ||
    warningEvent.agentId !== agentId ||
    warningEvent.sessionId !== sessionId
  ) {
    issues.push('warningEvent must keep the verifier target identity');
  }
  const attributes = warningEvent.attributes;
  if (!isRecord(attributes)) {
    issues.push('warningEvent.attributes must be an object');
    return issues;
  }
  const auditIssues = verifierAttributeIssues(attributes);
  for (const key of auditIssues) {
    issues.push(`warning attribute ${key} must match verifier audit metadata`);
  }
  if (attributes['progressive.runner'] !== 'a3s-code') {
    issues.push('warning attribute progressive.runner must be a3s-code');
  }
  if (attributes['progressive.skill'] !== 'anysentry-api') {
    issues.push('warning attribute progressive.skill must be anysentry-api');
  }
  if (attributes['progressive.warning'] !== 'near_timeout') {
    issues.push('warning attribute progressive.warning must be near_timeout');
  }
  if (attributes['progressive.warning.reason'] !== nearTimeoutWarningReason) {
    issues.push('warning attribute progressive.warning.reason must match the expected warning reason');
  }
  if (attributes['progressive.warning.eventId'] !== event.eventId) {
    issues.push('warning attribute progressive.warning.eventId must match the source event ID');
  }
  if (attributes['progressive.warning.bundleId'] !== bundle.bundleId) {
    issues.push('warning attribute progressive.warning.bundleId must match the Evidence Bundle ID');
  }
  if (Number(attributes['progressive.warning.thresholdMs']) !== nearTimeoutThresholdMs) {
    issues.push('warning attribute progressive.warning.thresholdMs must match the verifier threshold');
  }
  for (const [key, expected] of Object.entries(timingAttributes(timings))) {
    if (!sameAttributeValue(attributes[key], expected)) {
      issues.push(`warning attribute ${key} must match verifier timing metadata`);
    }
  }
  return issues;
}

function failureEvidenceBindingIssues(failureEvent, reason, details, timings) {
  const issues = [];
  if (!isRecord(failureEvent)) {
    return ['failureEvent must be an object'];
  }
  if (!isNonEmptyString(failureEvent.eventId)) {
    issues.push('failureEvent.eventId must be a non-empty string');
  }
  if (failureEvent.eventKind !== 'SecurityAction') {
    issues.push('failureEvent.eventKind must be SecurityAction');
  }
  if (failureEvent.eventCategory !== 'security') {
    issues.push('failureEvent.eventCategory must be security');
  }
  if (!isNonEmptyString(failureEvent.verdict) || failureEvent.verdict === 'allow') {
    issues.push('failureEvent.verdict must be a non-allow string');
  }
  if (failureEvent.riskCategory !== 'runtime_failure') {
    issues.push('failureEvent.riskCategory must be runtime_failure');
  }
  if (
    failureEvent.workspacePath !== workspacePath ||
    failureEvent.runId !== runId ||
    failureEvent.agentId !== agentId ||
    failureEvent.sessionId !== sessionId
  ) {
    issues.push('failureEvent must keep the verifier target identity');
  }
  const attributes = failureEvent.attributes;
  if (!isRecord(attributes)) {
    issues.push('failureEvent.attributes must be an object');
    return issues;
  }
  const auditIssues = verifierAttributeIssues(attributes);
  for (const key of auditIssues) {
    issues.push(`failure attribute ${key} must match verifier audit metadata`);
  }
  if (attributes['progressive.runner'] !== 'a3s-code') {
    issues.push('failure attribute progressive.runner must be a3s-code');
  }
  if (attributes['progressive.skill'] !== 'anysentry-api') {
    issues.push('failure attribute progressive.skill must be anysentry-api');
  }
  if (!trueAttribute(attributes['progressive.failure'])) {
    issues.push('failure attribute progressive.failure must be true');
  }
  if (attributes['progressive.failure.reason'] !== reason) {
    issues.push('failure attribute progressive.failure.reason must match the failure reason');
  }
  if (attributes['progressive.failure.details'] !== failureDetailsText(details)) {
    issues.push('failure attribute progressive.failure.details must match the failure details');
  }
  for (const [key, expected] of Object.entries(timingAttributes(timings))) {
    if (!sameAttributeValue(attributes[key], expected)) {
      issues.push(`failure attribute ${key} must match verifier timing metadata`);
    }
  }
  return issues;
}

function successfulEvidenceIssues(summary, context) {
  const issues = [];
  if (!isNonEmptyString(summary.evidence?.eventId)) issues.push(`${context} evidence.eventId must be a non-empty string`);
  if (!isNonEmptyString(summary.evidence?.workspacePath)) issues.push(`${context} evidence.workspacePath must be a non-empty string`);
  if (!isNonEmptyString(summary.evidence?.runId)) issues.push(`${context} evidence.runId must be a non-empty string`);
  if (!isNonEmptyString(summary.evidence?.agentId)) issues.push(`${context} evidence.agentId must be a non-empty string`);
  if (!isNonEmptyString(summary.evidence?.sessionId)) issues.push(`${context} evidence.sessionId must be a non-empty string`);
  if (!isNonEmptyString(summary.evidence?.bundleId)) issues.push(`${context} evidence.bundleId must be a non-empty string`);
  if (summary.evidence?.bundleSchemaVersion !== 'anysentry.evidence_bundle.v1') {
    issues.push(`${context} evidence.bundleSchemaVersion must be anysentry.evidence_bundle.v1`);
  }
  if (summary.evidence?.bundleContainsEvent !== true) issues.push(`${context} evidence.bundleContainsEvent must be true`);
  if (!isPositiveInteger(summary.evidence?.bundleEventCount)) issues.push(`${context} evidence.bundleEventCount must be a positive integer`);
  if (summary.evidence?.eventKind !== 'LlmCall') issues.push(`${context} evidence.eventKind must be LlmCall`);
  if (summary.evidence?.eventCategory !== 'llm') issues.push(`${context} evidence.eventCategory must be llm`);
  if (summary.evidence?.verdict !== 'allow') issues.push(`${context} evidence.verdict must be allow`);
  issues.push(
    ...persistedPreflightAttributeIssues(
      summary.evidence?.persistedPreflightAttributes,
      summary.evidence?.skillOutput,
      context,
    ),
  );
  if (!isNonEmptyString(summary.evidence?.skillOutput?.eventId)) {
    issues.push(`${context} evidence.skillOutput.eventId must be a non-empty string`);
  }
  if (!isNonEmptyString(summary.evidence?.skillOutput?.workspacePath)) {
    issues.push(`${context} evidence.skillOutput.workspacePath must be a non-empty string`);
  }
  if (!isNonEmptyString(summary.evidence?.skillOutput?.runId)) {
    issues.push(`${context} evidence.skillOutput.runId must be a non-empty string`);
  }
  if (!isNonEmptyString(summary.evidence?.skillOutput?.agentId)) {
    issues.push(`${context} evidence.skillOutput.agentId must be a non-empty string`);
  }
  if (!isNonEmptyString(summary.evidence?.skillOutput?.sessionId)) {
    issues.push(`${context} evidence.skillOutput.sessionId must be a non-empty string`);
  }
  if (!isNonEmptyString(summary.evidence?.skillOutput?.bundleId)) {
    issues.push(`${context} evidence.skillOutput.bundleId must be a non-empty string`);
  }
  issues.push(...skillOutputPreflightIssues(summary.evidence?.skillOutput, `${context} evidence.skillOutput`));
  if (summary.evidence?.skillOutput?.bundleSchemaVersion !== 'anysentry.evidence_bundle.v1') {
    issues.push(`${context} evidence.skillOutput.bundleSchemaVersion must be anysentry.evidence_bundle.v1`);
  }
  if (summary.evidence?.skillOutput?.bundleContainsEvent !== true) {
    issues.push(`${context} evidence.skillOutput.bundleContainsEvent must be true`);
  }
  if (!isPositiveInteger(summary.evidence?.skillOutput?.bundleEventCount)) {
    issues.push(`${context} evidence.skillOutput.bundleEventCount must be a positive integer`);
  }
  if (summary.evidence?.skillOutput?.eventKind !== 'LlmCall') issues.push(`${context} evidence.skillOutput.eventKind must be LlmCall`);
  if (summary.evidence?.skillOutput?.eventCategory !== 'llm') issues.push(`${context} evidence.skillOutput.eventCategory must be llm`);
  if (summary.evidence?.skillOutput?.verdict !== 'allow') issues.push(`${context} evidence.skillOutput.verdict must be allow`);
  if (summary.evidence?.skillOutput?.queriedBack !== true) issues.push(`${context} evidence.skillOutput.queriedBack must be true`);
  issues.push(...skillOutputTimingIssues(summary.evidence?.skillOutput?.timings, context));
  if (summary.evidence?.eventId !== summary.evidence?.skillOutput?.eventId) {
    issues.push(`${context} eventId must match skillOutput.eventId`);
  }
  if (summary.target?.workspacePath !== summary.evidence?.workspacePath) {
    issues.push(`${context} target.workspacePath must match evidence.workspacePath`);
  }
  if (summary.target?.runId !== summary.evidence?.runId) {
    issues.push(`${context} target.runId must match evidence.runId`);
  }
  if (summary.target?.agentId !== summary.evidence?.agentId) {
    issues.push(`${context} target.agentId must match evidence.agentId`);
  }
  if (summary.target?.sessionId !== summary.evidence?.sessionId) {
    issues.push(`${context} target.sessionId must match evidence.sessionId`);
  }
  if (summary.evidence?.runId !== summary.evidence?.skillOutput?.runId) {
    issues.push(`${context} evidence.runId must match skillOutput.runId`);
  }
  if (summary.evidence?.agentId !== summary.evidence?.skillOutput?.agentId) {
    issues.push(`${context} evidence.agentId must match skillOutput.agentId`);
  }
  if (summary.evidence?.sessionId !== summary.evidence?.skillOutput?.sessionId) {
    issues.push(`${context} evidence.sessionId must match skillOutput.sessionId`);
  }
  if (summary.evidence?.workspacePath !== summary.evidence?.skillOutput?.workspacePath) {
    issues.push(`${context} evidence.workspacePath must match skillOutput.workspacePath`);
  }
  if (summary.target?.workspacePath !== summary.evidence?.skillOutput?.workspacePath) {
    issues.push(`${context} target.workspacePath must match skillOutput.workspacePath`);
  }
  if (summary.target?.runId !== summary.evidence?.skillOutput?.runId) {
    issues.push(`${context} target.runId must match skillOutput.runId`);
  }
  if (summary.target?.agentId !== summary.evidence?.skillOutput?.agentId) {
    issues.push(`${context} target.agentId must match skillOutput.agentId`);
  }
  if (summary.target?.sessionId !== summary.evidence?.skillOutput?.sessionId) {
    issues.push(`${context} target.sessionId must match skillOutput.sessionId`);
  }
  if (summary.evidence?.bundleId !== summary.evidence?.skillOutput?.bundleId) {
    issues.push(`${context} bundleId must match skillOutput.bundleId`);
  }
  if (summary.evidence?.bundleSchemaVersion !== summary.evidence?.skillOutput?.bundleSchemaVersion) {
    issues.push(`${context} bundleSchemaVersion must match skillOutput.bundleSchemaVersion`);
  }
  if (summary.evidence?.bundleContainsEvent !== summary.evidence?.skillOutput?.bundleContainsEvent) {
    issues.push(`${context} bundleContainsEvent must match skillOutput.bundleContainsEvent`);
  }
  if (summary.evidence?.bundleEventCount !== summary.evidence?.skillOutput?.bundleEventCount) {
    issues.push(`${context} bundleEventCount must match skillOutput.bundleEventCount`);
  }
  if (summary.evidence?.eventKind !== summary.evidence?.skillOutput?.eventKind) {
    issues.push(`${context} eventKind must match skillOutput.eventKind`);
  }
  if (summary.evidence?.eventCategory !== summary.evidence?.skillOutput?.eventCategory) {
    issues.push(`${context} eventCategory must match skillOutput.eventCategory`);
  }
  if (summary.evidence?.verdict !== summary.evidence?.skillOutput?.verdict) {
    issues.push(`${context} verdict must match skillOutput.verdict`);
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
  if (isNonEmptyString(summary.verifier?.commit) && summary.verifier.commit !== verifierCommit) {
    issues.push('verifier.commit must match the running verifier commit');
  }
  if (summary.verifier?.schemaVersion !== verifierAttributes['progressive.verifier.schema']) {
    issues.push('verifier.schemaVersion must match the running verifier schema');
  }
  if (!isNonEmptyString(summary.verifier?.model)) issues.push('verifier.model must be a non-empty string');
  if (isNonEmptyString(summary.verifier?.model) && summary.verifier.model !== model) {
    issues.push('verifier.model must match the running verifier model');
  }
  if (summary.verifier?.skillTimeoutMs !== skillTimeoutMs) {
    issues.push('verifier.skillTimeoutMs must match the running verifier skill timeout');
  }
  if (summary.verifier?.sessionCloseTimeoutMs !== sessionCloseTimeoutMs) {
    issues.push('verifier.sessionCloseTimeoutMs must match the running verifier session close timeout');
  }
  if (summary.verifier?.nearTimeoutRatio !== nearTimeoutThresholdRatio) {
    issues.push('verifier.nearTimeoutRatio must match the running verifier near-timeout ratio');
  }
  if (summary.verifier?.nearTimeoutThresholdMs !== nearTimeoutThresholdMs) {
    issues.push('verifier.nearTimeoutThresholdMs must match the running verifier near-timeout threshold');
  }
  if (summary.verifier?.requireNearTimeoutWarning !== requireNearTimeoutWarning) {
    issues.push('verifier.requireNearTimeoutWarning must match the running verifier warning requirement');
  }
  if (summary.verifier?.node !== process.version) {
    issues.push('verifier.node must match the running verifier Node.js version');
  }
  if (!isNonEmptyString(summary.target?.apiBase)) issues.push('target.apiBase must be a non-empty string');
  if (isNonEmptyString(summary.target?.apiBase) && summary.target.apiBase !== apiBase) {
    issues.push('target.apiBase must match the running verifier API base');
  }
  if (!isNonEmptyString(summary.target?.workspacePath)) issues.push('target.workspacePath must be a non-empty string');
  if (isNonEmptyString(summary.target?.workspacePath) && summary.target.workspacePath !== workspacePath) {
    issues.push('target.workspacePath must match the running verifier workspacePath');
  }
  if (!isNonEmptyString(summary.target?.runId)) issues.push('target.runId must be a non-empty string');
  if (isNonEmptyString(summary.target?.runId) && summary.target.runId !== runId) {
    issues.push('target.runId must match the running verifier runId');
  }
  if (!isNonEmptyString(summary.target?.agentId)) issues.push('target.agentId must be a non-empty string');
  if (isNonEmptyString(summary.target?.agentId) && summary.target.agentId !== agentId) {
    issues.push('target.agentId must match the running verifier agentId');
  }
  if (!isNonEmptyString(summary.target?.sessionId)) issues.push('target.sessionId must be a non-empty string');
  if (isNonEmptyString(summary.target?.sessionId) && summary.target.sessionId !== sessionId) {
    issues.push('target.sessionId must match the running verifier sessionId');
  }
  if (!isRecord(summary.timings)) {
    issues.push('timings must be an object');
  } else {
    issues.push(...timingIssues(summary.timings));
  }

  if (summary.status === 'passed') {
    if (summary.failure) issues.push('passed summary must not include failure');
    if (summary.summaryValidation !== undefined) issues.push('passed summary must not include summaryValidation');
    if (summary.verifier?.skill !== 'anysentry-api') issues.push('passed summary verifier.skill must be anysentry-api');
    if (!isPositiveInteger(summary.verifier?.toolCalls)) issues.push('passed summary verifier.toolCalls must be a positive integer');
    issues.push(...successfulEvidenceIssues(summary, 'passed summary'));
    if (!isRecord(summary.warning)) issues.push('passed summary warning must be an object');
    if (summary.warning?.required === true && summary.warning?.triggered !== true) {
      issues.push('passed summary required warning must be triggered');
    }
  }

  if (summary.status === 'failed') {
    if (!isNonEmptyString(summary.failure?.phase)) issues.push('failed summary failure.phase must be a non-empty string');
    if (!isNonEmptyString(summary.failure?.reason)) issues.push('failed summary failure.reason must be a non-empty string');
    if (!hasFailureDetails(summary.failure?.details)) issues.push('failed summary failure.details must be present');
    if (
      isNonEmptyString(summary.failure?.phase) &&
      !['preflight', 'summary_validation'].includes(summary.failure.phase) &&
      summary.timings?.failurePhase !== summary.failure.phase
    ) {
      issues.push('failed summary timings.failurePhase must match failure.phase');
    }
    const evidence = summary.failure?.evidence;
    if (!isRecord(evidence)) {
      issues.push('failed summary failure.evidence must be an object');
    } else if (typeof evidence.recorded !== 'boolean') {
      issues.push('failed summary failure.evidence.recorded must be a boolean');
    } else if (evidence.recorded === true) {
      if (!isNonEmptyString(evidence.eventId)) issues.push('recorded failure evidence.eventId must be a non-empty string');
      if (!isNonEmptyString(evidence.failurePhase)) issues.push('recorded failure evidence.failurePhase must be a non-empty string');
      if (!isNonEmptyString(evidence.failureReason)) issues.push('recorded failure evidence.failureReason must be a non-empty string');
      if (!isNonEmptyString(evidence.failureDetails)) issues.push('recorded failure evidence.failureDetails must be a non-empty string');
      if (!isNonEmptyString(evidence.workspacePath)) issues.push('recorded failure evidence.workspacePath must be a non-empty string');
      if (!isNonEmptyString(evidence.runId)) issues.push('recorded failure evidence.runId must be a non-empty string');
      if (!isNonEmptyString(evidence.agentId)) issues.push('recorded failure evidence.agentId must be a non-empty string');
      if (!isNonEmptyString(evidence.sessionId)) issues.push('recorded failure evidence.sessionId must be a non-empty string');
      if (!isNonEmptyString(evidence.bundleId)) issues.push('recorded failure evidence.bundleId must be a non-empty string');
      if (evidence.bundleSchemaVersion !== 'anysentry.evidence_bundle.v1') {
        issues.push('recorded failure evidence.bundleSchemaVersion must be anysentry.evidence_bundle.v1');
      }
      if (evidence.bundleContainsEvent !== true) issues.push('recorded failure evidence.bundleContainsEvent must be true');
      if (!isPositiveInteger(evidence.bundleEventCount)) {
        issues.push('recorded failure evidence.bundleEventCount must be a positive integer');
      }
      if (evidence.workspacePath !== summary.target?.workspacePath) {
        issues.push('recorded failure evidence.workspacePath must match target.workspacePath');
      }
      if (evidence.runId !== summary.target?.runId) issues.push('recorded failure evidence.runId must match target.runId');
      if (evidence.agentId !== summary.target?.agentId) issues.push('recorded failure evidence.agentId must match target.agentId');
      if (evidence.sessionId !== summary.target?.sessionId) {
        issues.push('recorded failure evidence.sessionId must match target.sessionId');
      }
      if (evidence.failurePhase !== summary.failure?.phase) {
        issues.push('recorded failure evidence.failurePhase must match failure.phase');
      }
      if (evidence.failureReason !== summary.failure?.reason) {
        issues.push('recorded failure evidence.failureReason must match failure.reason');
      }
      if (hasFailureDetails(summary.failure?.details) && evidence.failureDetails !== failureDetailsText(summary.failure.details)) {
        issues.push('recorded failure evidence.failureDetails must match failure.details');
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
    if (summary.evidence !== undefined) {
      issues.push(...successfulEvidenceIssues(summary, 'failed summary'));
    }
    if (summary.failure?.phase === 'summary_validation') {
      if (!isRecord(summary.summaryValidation)) {
        issues.push('summary-validation failure must include summaryValidation');
      } else {
        if (summary.summaryValidation.status !== 'failed') {
          issues.push('summaryValidation.status must be failed');
        }
        if (!stringArray(summary.summaryValidation.issues)) {
          issues.push('summaryValidation.issues must be a non-empty string array');
        } else if (summary.summaryValidation.issues.length === 0) {
          issues.push('summaryValidation.issues must not be empty');
        }
        if (!sameStringArray(summary.summaryValidation.issues, summary.failure?.details?.issues)) {
          issues.push('summaryValidation.issues must match failure.details.issues');
        }
      }
    } else if (summary.summaryValidation !== undefined) {
      issues.push('non-summary-validation failure must not include summaryValidation');
    }
  }

  if (summary.warning !== undefined) {
    if (typeof summary.warning?.required !== 'boolean') issues.push('warning.required must be a boolean');
    if (typeof summary.warning?.triggered !== 'boolean') issues.push('warning.triggered must be a boolean');
    if (!isFiniteNumber(summary.warning?.thresholdMs) || summary.warning.thresholdMs <= 0) issues.push('warning.thresholdMs must be a positive number');
    if (typeof summary.warning?.required === 'boolean' && summary.warning.required !== requireNearTimeoutWarning) {
      issues.push('warning.required must match the running verifier requirement');
    }
    if (isFiniteNumber(summary.warning?.thresholdMs) && summary.warning.thresholdMs !== nearTimeoutThresholdMs) {
      issues.push('warning.thresholdMs must match the running verifier threshold');
    }
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
            'failurePhase',
            'failureReason',
            'failureDetails',
            'workspacePath',
            'runId',
            'agentId',
            'sessionId',
            'eventKind',
            'eventCategory',
            'verdict',
            'riskCategory',
            'bundleId',
            'bundleSchemaVersion',
            'bundleContainsEvent',
            'bundleEventCount',
            'error',
          ]),
        );
      }
    }
    if (summary.warning?.triggered === true) {
      if (!isFiniteNumber(summary.timings?.skill)) {
        issues.push('triggered warning timings.skill must be a non-negative number');
      } else if (summary.timings.skill < summary.warning?.thresholdMs) {
        issues.push('triggered warning timings.skill must be greater than or equal to warning.thresholdMs');
      }
      if (summary.warning?.reason !== nearTimeoutWarningReason) {
        issues.push('triggered warning.reason must match the expected warning reason');
      }
      if (!isNonEmptyString(summary.warning?.eventId)) issues.push('triggered warning.eventId must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.sourceEventId)) issues.push('triggered warning.sourceEventId must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.workspacePath)) issues.push('triggered warning.workspacePath must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.runId)) issues.push('triggered warning.runId must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.agentId)) issues.push('triggered warning.agentId must be a non-empty string');
      if (!isNonEmptyString(summary.warning?.sessionId)) issues.push('triggered warning.sessionId must be a non-empty string');
      if (summary.warning?.eventKind !== 'RuntimeEvent') issues.push('triggered warning.eventKind must be RuntimeEvent');
      if (summary.warning?.eventCategory !== 'runtime') issues.push('triggered warning.eventCategory must be runtime');
      if (summary.warning?.verdict !== 'allow') issues.push('triggered warning.verdict must be allow');
      if (!isNonEmptyString(summary.warning?.bundleId)) issues.push('triggered warning.bundleId must be a non-empty string');
      if (summary.warning?.bundleSchemaVersion !== 'anysentry.evidence_bundle.v1') {
        issues.push('triggered warning.bundleSchemaVersion must be anysentry.evidence_bundle.v1');
      }
      if (summary.warning?.bundleContainsSourceEvent !== true) {
        issues.push('triggered warning.bundleContainsSourceEvent must be true');
      }
      if (!isPositiveInteger(summary.warning?.bundleEventCount)) {
        issues.push('triggered warning.bundleEventCount must be a positive integer');
      }
      if (summary.warning?.failure !== undefined) issues.push('triggered warning.failure must be absent');
      if (isNonEmptyString(summary.evidence?.eventId) && summary.warning?.eventId === summary.evidence.eventId) {
        issues.push('triggered warning.eventId must differ from evidence.eventId');
      }
      if (isNonEmptyString(summary.evidence?.eventId) && summary.warning?.sourceEventId !== summary.evidence.eventId) {
        issues.push('triggered warning.sourceEventId must match evidence.eventId');
      }
      if (summary.warning?.workspacePath !== summary.target?.workspacePath) {
        issues.push('triggered warning.workspacePath must match target.workspacePath');
      }
      if (summary.warning?.runId !== summary.target?.runId) issues.push('triggered warning.runId must match target.runId');
      if (summary.warning?.agentId !== summary.target?.agentId) issues.push('triggered warning.agentId must match target.agentId');
      if (summary.warning?.sessionId !== summary.target?.sessionId) issues.push('triggered warning.sessionId must match target.sessionId');
      if (isNonEmptyString(summary.evidence?.bundleId) && summary.warning?.bundleId !== summary.evidence.bundleId) {
        issues.push('triggered warning.bundleId must match evidence.bundleId');
      }
      if (summary.warning?.bundleSchemaVersion !== summary.evidence?.bundleSchemaVersion) {
        issues.push('triggered warning.bundleSchemaVersion must match evidence.bundleSchemaVersion');
      }
      if (summary.warning?.bundleContainsSourceEvent !== summary.evidence?.bundleContainsEvent) {
        issues.push('triggered warning.bundleContainsSourceEvent must match evidence.bundleContainsEvent');
      }
      if (summary.warning?.bundleEventCount !== summary.evidence?.bundleEventCount) {
        issues.push('triggered warning.bundleEventCount must match evidence.bundleEventCount');
      }
      if (summary.warning?.isolation?.warningRows !== 1) issues.push('triggered warning isolation.warningRows must be 1');
      if (summary.warning?.isolation?.llmPollutionCount !== 0) issues.push('triggered warning isolation.llmPollutionCount must be 0');
    } else if (summary.warning?.triggered === false) {
      if (summary.warning?.reason !== undefined) issues.push('untriggered warning.reason must be absent');
      if (summary.warning?.eventId !== undefined) issues.push('untriggered warning.eventId must be absent');
      if (summary.warning?.sourceEventId !== undefined) issues.push('untriggered warning.sourceEventId must be absent');
      if (summary.warning?.workspacePath !== undefined) issues.push('untriggered warning.workspacePath must be absent');
      if (summary.warning?.runId !== undefined) issues.push('untriggered warning.runId must be absent');
      if (summary.warning?.agentId !== undefined) issues.push('untriggered warning.agentId must be absent');
      if (summary.warning?.sessionId !== undefined) issues.push('untriggered warning.sessionId must be absent');
      if (summary.warning?.eventKind !== undefined) issues.push('untriggered warning.eventKind must be absent');
      if (summary.warning?.eventCategory !== undefined) issues.push('untriggered warning.eventCategory must be absent');
      if (summary.warning?.verdict !== undefined) issues.push('untriggered warning.verdict must be absent');
      if (summary.warning?.bundleId !== undefined) issues.push('untriggered warning.bundleId must be absent');
      if (summary.warning?.bundleSchemaVersion !== undefined) issues.push('untriggered warning.bundleSchemaVersion must be absent');
      if (summary.warning?.bundleContainsSourceEvent !== undefined) issues.push('untriggered warning.bundleContainsSourceEvent must be absent');
      if (summary.warning?.bundleEventCount !== undefined) issues.push('untriggered warning.bundleEventCount must be absent');
      if (summary.warning?.isolation !== undefined) issues.push('untriggered warning.isolation must be absent');
      if (summary.status === 'passed' && summary.warning?.failure !== undefined) {
        issues.push('passed untriggered warning.failure must be absent');
      }
      if (summary.status === 'passed') {
        if (!isFiniteNumber(summary.timings?.skill)) {
          issues.push('passed untriggered warning timings.skill must be a non-negative number');
        } else if (summary.timings.skill >= summary.warning?.thresholdMs) {
          issues.push('passed untriggered warning timings.skill must be less than warning.thresholdMs');
        }
      }
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
      schemaVersion: verifierAttributes['progressive.verifier.schema'],
      model,
      skillTimeoutMs,
      sessionCloseTimeoutMs,
      nearTimeoutRatio: nearTimeoutThresholdRatio,
      nearTimeoutThresholdMs,
      requireNearTimeoutWarning,
      node: process.version,
    },
    target: {
      apiBase,
      workspacePath,
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
      ...originalVerifier,
      ...base.verifier,
    },
    target: {
      ...base.target,
      ...originalTarget,
      apiBase,
      workspacePath,
      runId,
      agentId,
      sessionId,
    },
    failure: {
      phase: 'summary_validation',
      reason: 'verifier summary contract validation failed',
      details: {
        issues,
        originalStatus: isRecord(summary) ? summary.status : undefined,
        originalFailurePhase: isRecord(summary) ? summary.failure?.phase : undefined,
        originalVerifier: Object.keys(originalVerifier).length > 0 ? originalVerifier : undefined,
        originalTarget: Object.keys(originalTarget).length > 0 ? originalTarget : undefined,
      },
      evidence: defaultFailureEvidence('summary_validation'),
    },
    summaryValidation: {
      status: 'failed',
      issues,
    },
    timings: sanitizedTimings(summary?.timings),
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

function persistedAttributeText(value, limit = 240) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const text = typeof raw === 'string' ? raw : '';
  return text.length > limit ? text.slice(0, limit) : text;
}

function failureDetailsText(details) {
  return persistedAttributeText(details);
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
                'progressive.failure.details': failureDetailsText(details),
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
      const matches =
        list.items?.filter(
          (item) =>
            item.workspacePath === workspacePath &&
            item.runId === runId &&
            item.agentId === agentId &&
            item.sessionId === sessionId,
        ) ?? [];
      const byRecordedId = matches.find((item) => item.eventId === recordedEventId);
      if (byRecordedId) return byRecordedId;
      return matches.find(
        (item) =>
          trueAttribute(item.attributes?.['progressive.failure']) &&
          item.attributes?.['progressive.failure.reason'] === reason,
      );
    });
    if (!failureEvent?.eventId) {
      throw new Error(`failure evidence did not become queryable: ${compact({ recorded, failureEvent })}`);
    }
    const failureBindingIssues = failureEvidenceBindingIssues(failureEvent, reason, details, timings);
    if (failureBindingIssues.length > 0) {
      throw new Error(`failure evidence drifted from verifier metadata: ${compact({ failureBindingIssues, failureEvent })}`);
    }
    const failureAttrs = failureEvent.attributes ?? {};
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
      failurePhase: String(failureAttrs['progressive.verifier.failurePhase'] ?? timings.failurePhase ?? ''),
      failureReason: String(failureAttrs['progressive.failure.reason'] ?? reason),
      failureDetails: String(failureAttrs['progressive.failure.details'] ?? failureDetailsText(details)),
      workspacePath: failureEvent.workspacePath,
      runId: failureEvent.runId,
      agentId: failureEvent.agentId,
      sessionId: failureEvent.sessionId,
      eventKind: failureEvent.eventKind,
      eventCategory: failureEvent.eventCategory,
      verdict: failureEvent.verdict,
      riskCategory: failureEvent.riskCategory,
      bundleId: bundle.bundleId,
      bundleSchemaVersion: bundle.schemaVersion,
      bundleContainsEvent: bundle.events?.some((item) => item.eventId === failureEvent.eventId) === true,
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
    'progressive.warning.reason': nearTimeoutWarningReason,
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
        (item.eventId === warningEventId ||
          (item.attributes?.['progressive.warning'] === 'near_timeout' &&
            item.attributes?.['progressive.warning.eventId'] === event.eventId)) &&
        item.workspacePath === workspacePath &&
        item.runId === runId &&
        item.agentId === agentId &&
        item.sessionId === sessionId,
    );
  });
  if (!warningEvent?.eventId) {
    throw new Error(`near-timeout warning evidence did not become queryable: ${compact({ recorded, warningEvent })}`);
  }
  const warningBindingIssues = warningEvidenceBindingIssues(warningEvent, event, bundle, timings);
  if (warningBindingIssues.length > 0) {
    throw new Error(`near-timeout warning evidence drifted from verifier metadata: ${compact({ warningBindingIssues, warningEvent })}`);
  }
  const warningRows = await request('/events/list', {
    method: 'POST',
    body: JSON.stringify({ timeType: 'last_30d', runId, agentId, limit: 50 }),
  });
  const warningItems =
    warningRows.items?.filter(
      (item) =>
        item.workspacePath === workspacePath &&
        item.runId === runId &&
        item.agentId === agentId &&
        item.sessionId === sessionId &&
        item.attributes?.['progressive.warning'] === 'near_timeout',
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

function parseSkillOutputJson(result) {
  const output = String(result?.output ?? '').trim();
  if (!output) throw new Error('Skill output was empty');
  const finalLine = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!finalLine) throw new Error('Skill output was empty');
  try {
    const parsed = JSON.parse(finalLine);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    throw new Error(`Skill output final line was not a JSON object: ${compact(output)}`);
  }
  throw new Error(`Skill output final line was not a JSON object: ${compact(output)}`);
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
      workspacePath,
      runId,
      agentId,
      sessionId,
      eventKind: 'LlmCall',
      eventCategory: 'llm',
      verdict: 'allow',
      bundleId: 'evb_self_test',
      bundleSchemaVersion: 'anysentry.evidence_bundle.v1',
      bundleContainsEvent: true,
      bundleEventCount: 1,
      persistedPreflightAttributes: {
        healthOk: true,
        listed: true,
        describedOperation: expectedDescribedOperation,
      },
      skillOutput: {
        eventId: 'evt_self_test',
        workspacePath,
        runId,
        agentId,
        sessionId,
        eventKind: 'LlmCall',
        eventCategory: 'llm',
        verdict: 'allow',
        bundleId: 'evb_self_test',
        healthOk: true,
        listed: true,
        described: expectedDescribedOperation,
        bundleSchemaVersion: 'anysentry.evidence_bundle.v1',
        bundleContainsEvent: true,
        bundleEventCount: 1,
        queriedBack: true,
        timings: {
          innerHealthzMs: 1,
          innerListMs: 2,
          innerDescribeRecordMs: 3,
          innerPreRecordMs: 6,
          innerRecordMs: 4,
          innerQueryEventMs: 5,
          innerBundleMs: 6,
          innerTotalMs: 30,
        },
      },
    },
    warning: {
      required: requireNearTimeoutWarning,
      triggered: true,
      thresholdMs: nearTimeoutThresholdMs,
      reason: nearTimeoutWarningReason,
      eventId: 'evt_warning_self_test',
      sourceEventId: 'evt_self_test',
      workspacePath,
      runId,
      agentId,
      sessionId,
      eventKind: 'RuntimeEvent',
      eventCategory: 'runtime',
      verdict: 'allow',
      bundleId: 'evb_self_test',
      bundleSchemaVersion: 'anysentry.evidence_bundle.v1',
      bundleContainsSourceEvent: true,
      bundleEventCount: 1,
      isolation: {
        warningRows: 1,
        llmPollutionCount: 0,
      },
    },
    timings: {
      skill: nearTimeoutThresholdMs + 1,
      elapsed: nearTimeoutThresholdMs + 25,
    },
  };
  assert('verifier self-test accepts the passed summary contract', verifierSummaryIssues(passedSummary).length === 0, verifierSummaryIssues(passedSummary));

  assert(
    'verifier self-test accepts a Skill output bound to this verifier run',
    skillOutputEvidenceIssues(passedSummary.evidence.skillOutput).length === 0,
    skillOutputEvidenceIssues(passedSummary.evidence.skillOutput),
  );
  const emptySkillOutputEventId = {
    ...passedSummary.evidence.skillOutput,
    eventId: '',
  };
  assert(
    'verifier self-test rejects Skill outputs without a non-empty event ID',
    skillOutputEvidenceIssues(emptySkillOutputEventId).includes('skillOutput.eventId must be a non-empty string'),
    skillOutputEvidenceIssues(emptySkillOutputEventId),
  );
  const missingSkillOutputBundleCount = {
    ...passedSummary.evidence.skillOutput,
    bundleEventCount: undefined,
  };
  assert(
    'verifier self-test rejects Skill outputs without a bundle event count',
    skillOutputEvidenceIssues(missingSkillOutputBundleCount).includes('skillOutput.bundleEventCount must be a positive integer'),
    skillOutputEvidenceIssues(missingSkillOutputBundleCount),
  );
  const driftedSkillOutputDescribe = {
    ...passedSummary.evidence.skillOutput,
    described: 'buildEvidenceBundle',
  };
  assert(
    'verifier self-test rejects Skill outputs with drifted described operation',
    skillOutputEvidenceIssues(driftedSkillOutputDescribe).includes(`skillOutput.described must be ${expectedDescribedOperation}`),
    skillOutputEvidenceIssues(driftedSkillOutputDescribe),
  );
  const missingSkillOutputHealth = {
    ...passedSummary.evidence.skillOutput,
    healthOk: false,
  };
  assert(
    'verifier self-test rejects Skill outputs that did not prove healthz',
    skillOutputEvidenceIssues(missingSkillOutputHealth).includes('skillOutput.healthOk must be true'),
    skillOutputEvidenceIssues(missingSkillOutputHealth),
  );
  const passedSkillEventAttributes = {
    'progressive.runner': 'a3s-code',
    'progressive.skill': 'anysentry-api',
    'progressive.flow': expectedProgressiveFlow,
    'progressive.model': model,
    'progressive.verifier.healthOk': true,
    'progressive.verifier.listed': true,
    'progressive.verifier.describedOperation': expectedDescribedOperation,
  };
  assert(
    'verifier self-test accepts stored event Skill provenance markers',
    skillEventAttributeIssues(passedSkillEventAttributes).length === 0,
    skillEventAttributeIssues(passedSkillEventAttributes),
  );
  const driftedSkillEventFlowAttributes = {
    ...passedSkillEventAttributes,
    'progressive.flow': 'healthz,list',
  };
  assert(
    'verifier self-test rejects stored event Skill flow drift',
    skillEventAttributeIssues(driftedSkillEventFlowAttributes).includes(
      'event attribute progressive.flow must match the expected progressive flow',
    ),
    skillEventAttributeIssues(driftedSkillEventFlowAttributes),
  );
  assert(
    'verifier self-test accepts stored event Skill preflight attributes bound to the Skill output',
    eventPreflightAttributeIssues(passedSkillEventAttributes, passedSummary.evidence.skillOutput).length === 0,
    eventPreflightAttributeIssues(passedSkillEventAttributes, passedSummary.evidence.skillOutput),
  );
  const driftedPreflightDescribeAttributes = {
    ...passedSkillEventAttributes,
    'progressive.verifier.describedOperation': 'buildEvidenceBundle',
  };
  assert(
    'verifier self-test rejects stored event preflight describe drift',
    eventPreflightAttributeIssues(driftedPreflightDescribeAttributes, passedSummary.evidence.skillOutput).includes(
      `event attribute progressive.verifier.describedOperation must be ${expectedDescribedOperation}`,
    ),
    eventPreflightAttributeIssues(driftedPreflightDescribeAttributes, passedSummary.evidence.skillOutput),
  );
  const driftedPreflightHealthAttributes = {
    ...passedSkillEventAttributes,
    'progressive.verifier.healthOk': false,
  };
  assert(
    'verifier self-test rejects stored event preflight health drift',
    eventPreflightAttributeIssues(driftedPreflightHealthAttributes, passedSummary.evidence.skillOutput).includes(
      'event attribute progressive.verifier.healthOk must be true',
    ),
    eventPreflightAttributeIssues(driftedPreflightHealthAttributes, passedSummary.evidence.skillOutput),
  );

  const passedEventTimingAttributes = Object.fromEntries(
    eventInnerTimingFields.map((field) => [`progressive.verifier.${field}`, passedSummary.evidence.skillOutput.timings[field]]),
  );
  assert(
    'verifier self-test accepts stored event inner timing attributes that match the Skill output',
    eventInnerTimingAttributeIssues(passedEventTimingAttributes, passedSummary.evidence.skillOutput.timings).length === 0,
    eventInnerTimingAttributeIssues(passedEventTimingAttributes, passedSummary.evidence.skillOutput.timings),
  );
  const driftedEventTimingAttributes = {
    ...passedEventTimingAttributes,
    'progressive.verifier.innerListMs': passedSummary.evidence.skillOutput.timings.innerListMs + 1,
  };
  assert(
    'verifier self-test rejects stored event inner timing attributes that drift from the Skill output',
    eventInnerTimingAttributeIssues(driftedEventTimingAttributes, passedSummary.evidence.skillOutput.timings).includes(
      'event attributes progressive.verifier.innerListMs must match evidence.skillOutput.timings.innerListMs',
    ),
    eventInnerTimingAttributeIssues(driftedEventTimingAttributes, passedSummary.evidence.skillOutput.timings),
  );
  const passedBundle = {
    bundleId: passedSummary.evidence.bundleId,
    schemaVersion: passedSummary.evidence.bundleSchemaVersion,
    events: [{ eventId: passedSummary.evidence.eventId }],
    summary: { eventCount: passedSummary.evidence.bundleEventCount },
  };
  assert(
    'verifier self-test accepts Evidence Bundle metadata that matches the Skill output',
    evidenceBundleBindingIssues(passedBundle, passedSummary.evidence.skillOutput, passedSummary.evidence.eventId).length === 0,
    evidenceBundleBindingIssues(passedBundle, passedSummary.evidence.skillOutput, passedSummary.evidence.eventId),
  );
  const driftedBundleCount = {
    ...passedBundle,
    summary: { eventCount: passedSummary.evidence.bundleEventCount + 1 },
  };
  assert(
    'verifier self-test rejects Evidence Bundle counts that drift from the Skill output',
    evidenceBundleBindingIssues(driftedBundleCount, passedSummary.evidence.skillOutput, passedSummary.evidence.eventId).includes(
      'bundle.summary.eventCount must match skillOutput.bundleEventCount',
    ),
    evidenceBundleBindingIssues(driftedBundleCount, passedSummary.evidence.skillOutput, passedSummary.evidence.eventId),
  );
  const passedEvent = {
    eventId: passedSummary.evidence.eventId,
    workspacePath,
    runId,
    agentId,
    sessionId,
  };
  const passedWarningEvent = {
    eventId: passedSummary.warning.eventId,
    workspacePath,
    runId,
    agentId,
    sessionId,
    eventKind: 'RuntimeEvent',
    eventCategory: 'runtime',
    verdict: 'allow',
    attributes: {
      ...verifierAttributes,
      ...timingAttributes(passedSummary.timings),
      'progressive.runner': 'a3s-code',
      'progressive.skill': 'anysentry-api',
      'progressive.warning': 'near_timeout',
      'progressive.warning.reason': nearTimeoutWarningReason,
      'progressive.warning.eventId': passedSummary.evidence.eventId,
      'progressive.warning.bundleId': passedSummary.evidence.bundleId,
      'progressive.warning.thresholdMs': nearTimeoutThresholdMs,
    },
  };
  assert(
    'verifier self-test accepts near-timeout warning evidence bound to verifier metadata',
    warningEvidenceBindingIssues(passedWarningEvent, passedEvent, passedBundle, passedSummary.timings).length === 0,
    warningEvidenceBindingIssues(passedWarningEvent, passedEvent, passedBundle, passedSummary.timings),
  );
  const driftedWarningTimingEvent = {
    ...passedWarningEvent,
    attributes: {
      ...passedWarningEvent.attributes,
      'progressive.verifier.elapsedMs': passedSummary.timings.elapsed + 1,
    },
  };
  assert(
    'verifier self-test rejects near-timeout warning timing drift',
    warningEvidenceBindingIssues(driftedWarningTimingEvent, passedEvent, passedBundle, passedSummary.timings).includes(
      'warning attribute progressive.verifier.elapsedMs must match verifier timing metadata',
    ),
    warningEvidenceBindingIssues(driftedWarningTimingEvent, passedEvent, passedBundle, passedSummary.timings),
  );
  const driftedWarningReasonEvent = {
    ...passedWarningEvent,
    attributes: {
      ...passedWarningEvent.attributes,
      'progressive.warning.reason': 'other warning reason',
    },
  };
  assert(
    'verifier self-test rejects near-timeout warning reason drift',
    warningEvidenceBindingIssues(driftedWarningReasonEvent, passedEvent, passedBundle, passedSummary.timings).includes(
      'warning attribute progressive.warning.reason must match the expected warning reason',
    ),
    warningEvidenceBindingIssues(driftedWarningReasonEvent, passedEvent, passedBundle, passedSummary.timings),
  );

  const mismatchedCommitSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      commit: 'other-commit',
    },
  };
  assert(
    'verifier self-test rejects summaries from a different commit',
    verifierSummaryIssues(mismatchedCommitSummary).includes('verifier.commit must match the running verifier commit'),
    verifierSummaryIssues(mismatchedCommitSummary),
  );
  const mismatchedVerifierSchemaSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      schemaVersion: 'legacy.verifier.v0',
    },
  };
  assert(
    'verifier self-test rejects summaries from a different verifier schema',
    verifierSummaryIssues(mismatchedVerifierSchemaSummary).includes('verifier.schemaVersion must match the running verifier schema'),
    verifierSummaryIssues(mismatchedVerifierSchemaSummary),
  );
  const mismatchedVerifierTimeoutSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      skillTimeoutMs: skillTimeoutMs + 1,
    },
  };
  assert(
    'verifier self-test rejects summaries from a different verifier timeout config',
    verifierSummaryIssues(mismatchedVerifierTimeoutSummary).includes(
      'verifier.skillTimeoutMs must match the running verifier skill timeout',
    ),
    verifierSummaryIssues(mismatchedVerifierTimeoutSummary),
  );
  const mismatchedVerifierNodeSummary = {
    ...passedSummary,
    verifier: {
      ...passedSummary.verifier,
      node: 'v0.0.0',
    },
  };
  assert(
    'verifier self-test rejects summaries from a different Node.js runtime',
    verifierSummaryIssues(mismatchedVerifierNodeSummary).includes('verifier.node must match the running verifier Node.js version'),
    verifierSummaryIssues(mismatchedVerifierNodeSummary),
  );
  const mismatchedTargetSummary = {
    ...passedSummary,
    target: {
      ...passedSummary.target,
      runId: 'other-run',
    },
  };
  assert(
    'verifier self-test rejects summaries from a different run',
    verifierSummaryIssues(mismatchedTargetSummary).includes('target.runId must match the running verifier runId'),
    verifierSummaryIssues(mismatchedTargetSummary),
  );
  const mismatchedWorkspaceSummary = {
    ...passedSummary,
    target: {
      ...passedSummary.target,
      workspacePath: 'repo://other/workspace',
    },
  };
  assert(
    'verifier self-test rejects summaries from a different workspace',
    verifierSummaryIssues(mismatchedWorkspaceSummary).includes('target.workspacePath must match the running verifier workspacePath'),
    verifierSummaryIssues(mismatchedWorkspaceSummary),
  );
  const normalizedStaleIdentitySummary = normalizedVerifierSummary({
    ...mismatchedTargetSummary,
    verifier: {
      ...mismatchedTargetSummary.verifier,
      commit: 'other-commit',
    },
  });
  assert(
    'verifier self-test converts stale-identity summaries into valid summary-validation results',
    normalizedStaleIdentitySummary.status === 'failed' &&
      normalizedStaleIdentitySummary.failure?.phase === 'summary_validation' &&
      normalizedStaleIdentitySummary.verifier?.commit === verifierCommit &&
      normalizedStaleIdentitySummary.target?.runId === runId &&
      sameStringArray(normalizedStaleIdentitySummary.summaryValidation?.issues, normalizedStaleIdentitySummary.failure?.details?.issues) &&
      verifierSummaryIssues(normalizedStaleIdentitySummary).length === 0,
    { summary: normalizedStaleIdentitySummary, issues: verifierSummaryIssues(normalizedStaleIdentitySummary) },
  );
  const missingSummaryValidationSummary = {
    ...normalizedStaleIdentitySummary,
    summaryValidation: undefined,
  };
  assert(
    'verifier self-test rejects summary-validation failures without summaryValidation',
    verifierSummaryIssues(missingSummaryValidationSummary).includes('summary-validation failure must include summaryValidation'),
    verifierSummaryIssues(missingSummaryValidationSummary),
  );
  const driftedSummaryValidationStatusSummary = {
    ...normalizedStaleIdentitySummary,
    summaryValidation: {
      ...normalizedStaleIdentitySummary.summaryValidation,
      status: 'passed',
    },
  };
  assert(
    'verifier self-test rejects summary-validation status drift',
    verifierSummaryIssues(driftedSummaryValidationStatusSummary).includes('summaryValidation.status must be failed'),
    verifierSummaryIssues(driftedSummaryValidationStatusSummary),
  );
  const emptySummaryValidationIssuesSummary = {
    ...normalizedStaleIdentitySummary,
    summaryValidation: {
      ...normalizedStaleIdentitySummary.summaryValidation,
      issues: [],
    },
  };
  assert(
    'verifier self-test rejects empty summary-validation issues',
    verifierSummaryIssues(emptySummaryValidationIssuesSummary).includes('summaryValidation.issues must not be empty'),
    verifierSummaryIssues(emptySummaryValidationIssuesSummary),
  );
  const driftedSummaryValidationIssuesSummary = {
    ...normalizedStaleIdentitySummary,
    summaryValidation: {
      ...normalizedStaleIdentitySummary.summaryValidation,
      issues: ['different summary issue'],
    },
  };
  assert(
    'verifier self-test rejects summary-validation issue drift',
    verifierSummaryIssues(driftedSummaryValidationIssuesSummary).includes('summaryValidation.issues must match failure.details.issues'),
    verifierSummaryIssues(driftedSummaryValidationIssuesSummary),
  );
  const stalePassedSummaryValidationSummary = {
    ...passedSummary,
    summaryValidation: {
      status: 'failed',
      issues: ['stale issue'],
    },
  };
  assert(
    'verifier self-test rejects stale summaryValidation on passed summaries',
    verifierSummaryIssues(stalePassedSummaryValidationSummary).includes('passed summary must not include summaryValidation'),
    verifierSummaryIssues(stalePassedSummaryValidationSummary),
  );
  const driftedSkillRunSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        runId: 'other-run',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill output run identity drift',
    verifierSummaryIssues(driftedSkillRunSummary).includes('passed summary target.runId must match skillOutput.runId'),
    verifierSummaryIssues(driftedSkillRunSummary),
  );
  const driftedSkillSessionSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        sessionId: 'other-session',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill output session identity drift',
    verifierSummaryIssues(driftedSkillSessionSummary).includes('passed summary target.sessionId must match skillOutput.sessionId'),
    verifierSummaryIssues(driftedSkillSessionSummary),
  );
  const driftedSkillWorkspaceSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        workspacePath: 'repo://other/workspace',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill output workspace drift',
    verifierSummaryIssues(driftedSkillWorkspaceSummary).includes('passed summary target.workspacePath must match skillOutput.workspacePath'),
    verifierSummaryIssues(driftedSkillWorkspaceSummary),
  );
  const mismatchedWarningRequirementSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      required: !requireNearTimeoutWarning,
    },
  };
  assert(
    'verifier self-test rejects warning requirements from a different verifier config',
    verifierSummaryIssues(mismatchedWarningRequirementSummary).includes('warning.required must match the running verifier requirement'),
    verifierSummaryIssues(mismatchedWarningRequirementSummary),
  );
  const mismatchedWarningThresholdSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      thresholdMs: nearTimeoutThresholdMs + 1,
    },
  };
  assert(
    'verifier self-test rejects warning thresholds from a different verifier config',
    verifierSummaryIssues(mismatchedWarningThresholdSummary).includes('warning.thresholdMs must match the running verifier threshold'),
    verifierSummaryIssues(mismatchedWarningThresholdSummary),
  );
  const underThresholdTriggeredWarningSummary = {
    ...passedSummary,
    timings: {
      ...passedSummary.timings,
      skill: nearTimeoutThresholdMs - 1,
    },
  };
  assert(
    'verifier self-test rejects triggered warnings below the timing threshold',
    verifierSummaryIssues(underThresholdTriggeredWarningSummary).includes(
      'triggered warning timings.skill must be greater than or equal to warning.thresholdMs',
    ),
    verifierSummaryIssues(underThresholdTriggeredWarningSummary),
  );
  const missingWarningReasonSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      reason: undefined,
    },
  };
  assert(
    'verifier self-test rejects triggered warning summaries without a reason',
    verifierSummaryIssues(missingWarningReasonSummary).includes('triggered warning.reason must match the expected warning reason'),
    verifierSummaryIssues(missingWarningReasonSummary),
  );
  const driftedWarningReasonSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      reason: 'other warning reason',
    },
  };
  assert(
    'verifier self-test rejects triggered warning reason drift in summaries',
    verifierSummaryIssues(driftedWarningReasonSummary).includes('triggered warning.reason must match the expected warning reason'),
    verifierSummaryIssues(driftedWarningReasonSummary),
  );
  const untriggeredAboveThresholdSummary = {
    ...passedSummary,
    warning: {
      required: requireNearTimeoutWarning,
      triggered: false,
      thresholdMs: nearTimeoutThresholdMs,
    },
  };
  assert(
    'verifier self-test rejects passed untriggered warnings at or above the timing threshold',
    verifierSummaryIssues(untriggeredAboveThresholdSummary).includes(
      'passed untriggered warning timings.skill must be less than warning.thresholdMs',
    ),
    verifierSummaryIssues(untriggeredAboveThresholdSummary),
  );
  if (!requireNearTimeoutWarning) {
    const untriggeredBelowThresholdSummary = {
      ...untriggeredAboveThresholdSummary,
      timings: {
        ...passedSummary.timings,
        skill: nearTimeoutThresholdMs - 1,
      },
    };
    assert(
      'verifier self-test accepts passed untriggered warnings below the timing threshold',
      verifierSummaryIssues(untriggeredBelowThresholdSummary).length === 0,
      verifierSummaryIssues(untriggeredBelowThresholdSummary),
    );
  }

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
      required: true,
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
  const staleUntriggeredWarningSummary = {
    ...passedSummary,
    warning: {
      required: false,
      triggered: false,
      thresholdMs: nearTimeoutThresholdMs,
      eventId: 'evt_stale_warning',
      bundleId: 'evb_stale_warning',
      isolation: {
        warningRows: 1,
        llmPollutionCount: 0,
      },
    },
  };
  assert(
    'verifier self-test rejects stale warning evidence fields when warning is not triggered',
    verifierSummaryIssues(staleUntriggeredWarningSummary).includes('untriggered warning.eventId must be absent'),
    verifierSummaryIssues(staleUntriggeredWarningSummary),
  );
  const staleUntriggeredWarningKindSummary = {
    ...passedSummary,
    warning: {
      required: false,
      triggered: false,
      thresholdMs: nearTimeoutThresholdMs,
      reason: nearTimeoutWarningReason,
      sourceEventId: 'evt_self_test',
      workspacePath,
      runId,
      eventKind: 'RuntimeEvent',
      eventCategory: 'runtime',
      verdict: 'allow',
    },
  };
  assert(
    'verifier self-test rejects stale warning contract fields when warning is not triggered',
    verifierSummaryIssues(staleUntriggeredWarningKindSummary).includes('untriggered warning.reason must be absent'),
    verifierSummaryIssues(staleUntriggeredWarningKindSummary),
  );
  const triggeredWarningFailureSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      failure: {
        evidence: { recorded: false, error: 'stale failure' },
      },
    },
  };
  assert(
    'verifier self-test rejects failure payloads on triggered warnings',
    verifierSummaryIssues(triggeredWarningFailureSummary).includes('triggered warning.failure must be absent'),
    verifierSummaryIssues(triggeredWarningFailureSummary),
  );
  const driftedWarningEventKindSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      eventKind: 'LlmCall',
    },
  };
  assert(
    'verifier self-test rejects triggered warnings with drifted event kind',
    verifierSummaryIssues(driftedWarningEventKindSummary).includes('triggered warning.eventKind must be RuntimeEvent'),
    verifierSummaryIssues(driftedWarningEventKindSummary),
  );
  const driftedWarningEventCategorySummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      eventCategory: 'llm',
    },
  };
  assert(
    'verifier self-test rejects triggered warnings with drifted event category',
    verifierSummaryIssues(driftedWarningEventCategorySummary).includes('triggered warning.eventCategory must be runtime'),
    verifierSummaryIssues(driftedWarningEventCategorySummary),
  );
  const reusedWarningEventSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      eventId: passedSummary.evidence.eventId,
    },
  };
  assert(
    'verifier self-test rejects warnings that reuse the success event ID',
    verifierSummaryIssues(reusedWarningEventSummary).includes('triggered warning.eventId must differ from evidence.eventId'),
    verifierSummaryIssues(reusedWarningEventSummary),
  );
  const driftedWarningSourceSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      sourceEventId: 'evt_other_success',
    },
  };
  assert(
    'verifier self-test rejects warning source event drift',
    verifierSummaryIssues(driftedWarningSourceSummary).includes('triggered warning.sourceEventId must match evidence.eventId'),
    verifierSummaryIssues(driftedWarningSourceSummary),
  );
  const driftedWarningWorkspaceSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      workspacePath: 'repo://other/workspace',
    },
  };
  assert(
    'verifier self-test rejects warning workspace drift',
    verifierSummaryIssues(driftedWarningWorkspaceSummary).includes('triggered warning.workspacePath must match target.workspacePath'),
    verifierSummaryIssues(driftedWarningWorkspaceSummary),
  );
  const driftedWarningRunSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      runId: 'other-run',
    },
  };
  assert(
    'verifier self-test rejects warning run identity drift',
    verifierSummaryIssues(driftedWarningRunSummary).includes('triggered warning.runId must match target.runId'),
    verifierSummaryIssues(driftedWarningRunSummary),
  );
  const driftedWarningAgentSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      agentId: 'other-agent',
    },
  };
  assert(
    'verifier self-test rejects warning agent identity drift',
    verifierSummaryIssues(driftedWarningAgentSummary).includes('triggered warning.agentId must match target.agentId'),
    verifierSummaryIssues(driftedWarningAgentSummary),
  );
  const driftedWarningSessionSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      sessionId: 'other-session',
    },
  };
  assert(
    'verifier self-test rejects warning session identity drift',
    verifierSummaryIssues(driftedWarningSessionSummary).includes('triggered warning.sessionId must match target.sessionId'),
    verifierSummaryIssues(driftedWarningSessionSummary),
  );

  const negativeTimingSummary = {
    ...passedSummary,
    timings: {
      ...passedSummary.timings,
      skill: -1,
    },
  };
  assert(
    'verifier self-test rejects negative timing values',
    verifierSummaryIssues(negativeTimingSummary).includes('timings.skill must be a non-negative number or non-empty string'),
    verifierSummaryIssues(negativeTimingSummary),
  );
  const normalizedNegativeTiming = normalizedVerifierSummary(negativeTimingSummary);
  assert(
    'verifier self-test sanitizes invalid timings in summary-validation failures',
    normalizedNegativeTiming.status === 'failed' &&
      normalizedNegativeTiming.failure?.phase === 'summary_validation' &&
      verifierSummaryIssues(normalizedNegativeTiming).length === 0,
    { summary: normalizedNegativeTiming, issues: verifierSummaryIssues(normalizedNegativeTiming) },
  );

  const failedTimings = { elapsed: 10, failurePhase: 'skill_output' };
  const failedReason = 'skill output JSON was invalid';
  const failedSummary = failureSummary(
    'skill_output',
    failedReason,
    'invalid JSON',
    failedTimings,
    {
      recorded: true,
      eventId: 'evt_failure_self_test',
      failurePhase: 'skill_output',
      failureReason: failedReason,
      failureDetails: failureDetailsText('invalid JSON'),
      workspacePath,
      runId,
      agentId,
      sessionId,
      eventKind: 'SecurityAction',
      eventCategory: 'security',
      verdict: 'block',
      riskCategory: 'runtime_failure',
      bundleId: 'evb_failure_self_test',
      bundleSchemaVersion: 'anysentry.evidence_bundle.v1',
      bundleContainsEvent: true,
      bundleEventCount: 1,
    },
  );
  assert('verifier self-test accepts the failed summary contract', verifierSummaryIssues(failedSummary).length === 0, verifierSummaryIssues(failedSummary));
  const staleFailedSummaryValidationSummary = {
    ...failedSummary,
    summaryValidation: {
      status: 'failed',
      issues: ['stale issue'],
    },
  };
  assert(
    'verifier self-test rejects stale summaryValidation on non-summary-validation failures',
    verifierSummaryIssues(staleFailedSummaryValidationSummary).includes('non-summary-validation failure must not include summaryValidation'),
    verifierSummaryIssues(staleFailedSummaryValidationSummary),
  );

  const passedFailureEvent = {
    eventId: failedSummary.failure.evidence.eventId,
    workspacePath,
    runId,
    agentId,
    sessionId,
    eventKind: 'SecurityAction',
    eventCategory: 'security',
    verdict: 'block',
    riskCategory: 'runtime_failure',
    attributes: {
      ...verifierAttributes,
      ...timingAttributes(failedTimings),
      'progressive.runner': 'a3s-code',
      'progressive.skill': 'anysentry-api',
      'progressive.failure': true,
      'progressive.failure.reason': failedReason,
      'progressive.failure.details': 'invalid JSON',
    },
  };
  assert(
    'verifier self-test accepts failure evidence bound to verifier metadata',
    failureEvidenceBindingIssues(passedFailureEvent, failedReason, 'invalid JSON', failedTimings).length === 0,
    failureEvidenceBindingIssues(passedFailureEvent, failedReason, 'invalid JSON', failedTimings),
  );
  const longFailureDetails = `long failure details ${'x'.repeat(300)}`;
  assert(
    'verifier self-test truncates failure details to the persisted attribute budget',
    failureDetailsText(longFailureDetails).length === 240 && failureDetailsText(longFailureDetails) === longFailureDetails.slice(0, 240),
    failureDetailsText(longFailureDetails),
  );
  const driftedFailureReasonEvent = {
    ...passedFailureEvent,
    attributes: {
      ...passedFailureEvent.attributes,
      'progressive.failure.reason': 'other failure reason',
    },
  };
  assert(
    'verifier self-test rejects failure evidence reason metadata drift',
    failureEvidenceBindingIssues(driftedFailureReasonEvent, failedReason, 'invalid JSON', failedTimings).includes(
      'failure attribute progressive.failure.reason must match the failure reason',
    ),
    failureEvidenceBindingIssues(driftedFailureReasonEvent, failedReason, 'invalid JSON', failedTimings),
  );
  const driftedFailureDetailsEvent = {
    ...passedFailureEvent,
    attributes: {
      ...passedFailureEvent.attributes,
      'progressive.failure.details': 'different details',
    },
  };
  assert(
    'verifier self-test rejects failure evidence details metadata drift',
    failureEvidenceBindingIssues(driftedFailureDetailsEvent, failedReason, 'invalid JSON', failedTimings).includes(
      'failure attribute progressive.failure.details must match the failure details',
    ),
    failureEvidenceBindingIssues(driftedFailureDetailsEvent, failedReason, 'invalid JSON', failedTimings),
  );

  const driftedFailureSummary = failureSummary(
    'skill_output',
    failedReason,
    'invalid JSON',
    failedTimings,
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

  const driftedFailureEvidencePhaseSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      failurePhase: 'skill',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence phase drift',
    verifierSummaryIssues(driftedFailureEvidencePhaseSummary).includes(
      'recorded failure evidence.failurePhase must match failure.phase',
    ),
    verifierSummaryIssues(driftedFailureEvidencePhaseSummary),
  );
  const driftedFailureEvidenceReasonSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      failureReason: 'other failure reason',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence reason drift',
    verifierSummaryIssues(driftedFailureEvidenceReasonSummary).includes(
      'recorded failure evidence.failureReason must match failure.reason',
    ),
    verifierSummaryIssues(driftedFailureEvidenceReasonSummary),
  );
  const missingFailureEvidenceDetailsSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      failureDetails: undefined,
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence without details',
    verifierSummaryIssues(missingFailureEvidenceDetailsSummary).includes(
      'recorded failure evidence.failureDetails must be a non-empty string',
    ),
    verifierSummaryIssues(missingFailureEvidenceDetailsSummary),
  );
  const driftedFailureEvidenceDetailsSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      failureDetails: 'different details',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence details drift',
    verifierSummaryIssues(driftedFailureEvidenceDetailsSummary).includes(
      'recorded failure evidence.failureDetails must match failure.details',
    ),
    verifierSummaryIssues(driftedFailureEvidenceDetailsSummary),
  );

  const driftedFailureWorkspaceSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      workspacePath: 'repo://other/workspace',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence workspace drift',
    verifierSummaryIssues(driftedFailureWorkspaceSummary).includes(
      'recorded failure evidence.workspacePath must match target.workspacePath',
    ),
    verifierSummaryIssues(driftedFailureWorkspaceSummary),
  );
  const driftedFailureRunSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      runId: 'other-run',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence run drift',
    verifierSummaryIssues(driftedFailureRunSummary).includes('recorded failure evidence.runId must match target.runId'),
    verifierSummaryIssues(driftedFailureRunSummary),
  );
  const driftedFailureAgentSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      agentId: 'other-agent',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence agent drift',
    verifierSummaryIssues(driftedFailureAgentSummary).includes('recorded failure evidence.agentId must match target.agentId'),
    verifierSummaryIssues(driftedFailureAgentSummary),
  );
  const driftedFailureSessionSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      sessionId: 'other-session',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence session drift',
    verifierSummaryIssues(driftedFailureSessionSummary).includes('recorded failure evidence.sessionId must match target.sessionId'),
    verifierSummaryIssues(driftedFailureSessionSummary),
  );
  const driftedFailureBundleSchemaSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      bundleSchemaVersion: 'legacy.bundle.v0',
    },
  );
  assert(
    'verifier self-test rejects recorded failure evidence bundle schema drift',
    verifierSummaryIssues(driftedFailureBundleSchemaSummary).includes(
      'recorded failure evidence.bundleSchemaVersion must be anysentry.evidence_bundle.v1',
    ),
    verifierSummaryIssues(driftedFailureBundleSchemaSummary),
  );
  const missingFailureBundleEventSummary = failureSummary(
    'skill_output',
    'skill output JSON was invalid',
    'invalid JSON',
    { elapsed: 10, failurePhase: 'skill_output' },
    {
      ...failedSummary.failure.evidence,
      bundleContainsEvent: false,
    },
  );
  assert(
    'verifier self-test rejects recorded failure bundles that omit the failure event',
    verifierSummaryIssues(missingFailureBundleEventSummary).includes('recorded failure evidence.bundleContainsEvent must be true'),
    verifierSummaryIssues(missingFailureBundleEventSummary),
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

  const requiredWarningFailureEvidence = {
    ...failedSummary.failure.evidence,
    failurePhase: 'near_timeout_warning',
    failureReason: 'required near-timeout warning was not emitted',
  };
  const requiredWarningFailureSummary = {
    ...failedSummary,
    failure: {
      ...failedSummary.failure,
      phase: 'near_timeout_warning',
      reason: 'required near-timeout warning was not emitted',
      evidence: requiredWarningFailureEvidence,
    },
    timings: {
      ...failedSummary.timings,
      failurePhase: 'near_timeout_warning',
    },
    warning: {
      required: true,
      triggered: false,
      thresholdMs: nearTimeoutThresholdMs,
      failure: {
        evidence: requiredWarningFailureEvidence,
      },
    },
  };
  if (requireNearTimeoutWarning) {
    assert(
      'verifier self-test accepts required-warning failures bound to top-level evidence',
      verifierSummaryIssues(requiredWarningFailureSummary).length === 0,
      verifierSummaryIssues(requiredWarningFailureSummary),
    );

    const driftedFailedEvidenceSummary = {
      ...requiredWarningFailureSummary,
      evidence: {
        ...requiredWarningFailureSummary.evidence,
        eventKind: 'RuntimeEvent',
      },
    };
    assert(
      'verifier self-test rejects failed summaries with drifted top-level evidence',
      verifierSummaryIssues(driftedFailedEvidenceSummary).includes('failed summary evidence.eventKind must be LlmCall'),
      verifierSummaryIssues(driftedFailedEvidenceSummary),
    );
    const driftedFailurePhaseSummary = {
      ...requiredWarningFailureSummary,
      timings: {
        ...requiredWarningFailureSummary.timings,
        failurePhase: 'skill_output',
      },
    };
    assert(
      'verifier self-test rejects failure phase timing drift',
      verifierSummaryIssues(driftedFailurePhaseSummary).includes('failed summary timings.failurePhase must match failure.phase'),
      verifierSummaryIssues(driftedFailurePhaseSummary),
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
  }

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
  const missingUnrecordedFailureDetailsSummary = {
    ...unrecordedFailureSummary,
    failure: {
      ...unrecordedFailureSummary.failure,
      details: undefined,
    },
  };
  assert(
    'verifier self-test rejects unrecorded failures without details',
    verifierSummaryIssues(missingUnrecordedFailureDetailsSummary).includes('failed summary failure.details must be present'),
    verifierSummaryIssues(missingUnrecordedFailureDetailsSummary),
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
  const driftedEvidenceRunSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      runId: 'other-run',
    },
  };
  assert(
    'verifier self-test rejects stored evidence run identity drift',
    verifierSummaryIssues(driftedEvidenceRunSummary).includes('passed summary target.runId must match evidence.runId'),
    verifierSummaryIssues(driftedEvidenceRunSummary),
  );
  const driftedEvidenceWorkspaceSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      workspacePath: 'repo://other/workspace',
    },
  };
  assert(
    'verifier self-test rejects stored evidence workspace drift',
    verifierSummaryIssues(driftedEvidenceWorkspaceSummary).includes('passed summary target.workspacePath must match evidence.workspacePath'),
    verifierSummaryIssues(driftedEvidenceWorkspaceSummary),
  );
  const driftedEvidenceAgentSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      agentId: 'other-agent',
    },
  };
  assert(
    'verifier self-test rejects stored evidence agent identity drift',
    verifierSummaryIssues(driftedEvidenceAgentSummary).includes('passed summary target.agentId must match evidence.agentId'),
    verifierSummaryIssues(driftedEvidenceAgentSummary),
  );
  const driftedEvidenceSessionSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      sessionId: 'other-session',
    },
  };
  assert(
    'verifier self-test rejects stored evidence session identity drift',
    verifierSummaryIssues(driftedEvidenceSessionSummary).includes('passed summary target.sessionId must match evidence.sessionId'),
    verifierSummaryIssues(driftedEvidenceSessionSummary),
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
  const driftedEvidenceCategorySummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      eventCategory: 'runtime',
    },
  };
  assert(
    'verifier self-test rejects passed summaries with drifted evidence category',
    verifierSummaryIssues(driftedEvidenceCategorySummary).includes('passed summary evidence.eventCategory must be llm'),
    verifierSummaryIssues(driftedEvidenceCategorySummary),
  );
  const missingPersistedPreflightSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      persistedPreflightAttributes: undefined,
    },
  };
  assert(
    'verifier self-test rejects passed summaries without persisted preflight attributes',
    verifierSummaryIssues(missingPersistedPreflightSummary).includes(
      'passed summary evidence.persistedPreflightAttributes must be an object',
    ),
    verifierSummaryIssues(missingPersistedPreflightSummary),
  );
  const driftedPersistedPreflightSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      persistedPreflightAttributes: {
        ...passedSummary.evidence.persistedPreflightAttributes,
        describedOperation: 'buildEvidenceBundle',
      },
    },
  };
  assert(
    'verifier self-test rejects persisted preflight attributes with describe drift',
    verifierSummaryIssues(driftedPersistedPreflightSummary).includes(
      `passed summary evidence.persistedPreflightAttributes.describedOperation must be ${expectedDescribedOperation}`,
    ),
    verifierSummaryIssues(driftedPersistedPreflightSummary),
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
  const driftedSkillOutputDescribeSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        described: 'buildEvidenceBundle',
      },
    },
  };
  assert(
    'verifier self-test rejects passed summaries with drifted Skill describe evidence',
    verifierSummaryIssues(driftedSkillOutputDescribeSummary).includes(
      `passed summary evidence.skillOutput.described must be ${expectedDescribedOperation}`,
    ),
    verifierSummaryIssues(driftedSkillOutputDescribeSummary),
  );
  const driftedSkillOutputHealthSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        healthOk: false,
      },
    },
  };
  assert(
    'verifier self-test rejects passed summaries without Skill health evidence',
    verifierSummaryIssues(driftedSkillOutputHealthSummary).includes('passed summary evidence.skillOutput.healthOk must be true'),
    verifierSummaryIssues(driftedSkillOutputHealthSummary),
  );
  const driftedSkillOutputListSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        listed: false,
      },
    },
  };
  assert(
    'verifier self-test rejects passed summaries without Skill list evidence',
    verifierSummaryIssues(driftedSkillOutputListSummary).includes('passed summary evidence.skillOutput.listed must be true'),
    verifierSummaryIssues(driftedSkillOutputListSummary),
  );
  const driftedSkillOutputCategorySummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        eventCategory: 'runtime',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill outputs with drifted evidence category',
    verifierSummaryIssues(driftedSkillOutputCategorySummary).includes('passed summary evidence.skillOutput.eventCategory must be llm'),
    verifierSummaryIssues(driftedSkillOutputCategorySummary),
  );
  const driftedSkillOutputKindSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        eventKind: 'RuntimeEvent',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill outputs with event kind drift from stored evidence',
    verifierSummaryIssues(driftedSkillOutputKindSummary).includes('passed summary eventKind must match skillOutput.eventKind'),
    verifierSummaryIssues(driftedSkillOutputKindSummary),
  );
  const driftedSkillOutputVerdictSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        verdict: 'block',
      },
    },
  };
  assert(
    'verifier self-test rejects Skill outputs with verdict drift from stored evidence',
    verifierSummaryIssues(driftedSkillOutputVerdictSummary).includes('passed summary verdict must match skillOutput.verdict'),
    verifierSummaryIssues(driftedSkillOutputVerdictSummary),
  );
  const missingSkillOutputTimingsSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        timings: undefined,
      },
    },
  };
  assert(
    'verifier self-test rejects Skill outputs without inner timings',
    verifierSummaryIssues(missingSkillOutputTimingsSummary).includes(
      'passed summary evidence.skillOutput.timings must be an object',
    ),
    verifierSummaryIssues(missingSkillOutputTimingsSummary),
  );
  const negativeSkillOutputTimingSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        timings: {
          ...passedSummary.evidence.skillOutput.timings,
          innerRecordMs: -1,
        },
      },
    },
  };
  assert(
    'verifier self-test rejects negative Skill output inner timings',
    verifierSummaryIssues(negativeSkillOutputTimingSummary).includes(
      'passed summary evidence.skillOutput.timings.innerRecordMs must be a non-negative number',
    ),
    verifierSummaryIssues(negativeSkillOutputTimingSummary),
  );
  const driftedSkillOutputTotalTimingSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        timings: {
          ...passedSummary.evidence.skillOutput.timings,
          innerTotalMs: 1,
        },
      },
    },
  };
  assert(
    'verifier self-test rejects Skill output total timing drift',
    verifierSummaryIssues(driftedSkillOutputTotalTimingSummary).includes(
      'passed summary evidence.skillOutput.timings.innerTotalMs must be greater than or equal to innerDescribeRecordMs',
    ),
    verifierSummaryIssues(driftedSkillOutputTotalTimingSummary),
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
  const driftedBundleSchemaSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      bundleSchemaVersion: 'legacy.bundle.v0',
    },
  };
  assert(
    'verifier self-test rejects success evidence with drifted bundle schema',
    verifierSummaryIssues(driftedBundleSchemaSummary).includes(
      'passed summary evidence.bundleSchemaVersion must be anysentry.evidence_bundle.v1',
    ),
    verifierSummaryIssues(driftedBundleSchemaSummary),
  );
  const missingBundleEventSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      bundleContainsEvent: false,
    },
  };
  assert(
    'verifier self-test rejects success bundles that do not include the event',
    verifierSummaryIssues(missingBundleEventSummary).includes('passed summary evidence.bundleContainsEvent must be true'),
    verifierSummaryIssues(missingBundleEventSummary),
  );
  const driftedSkillBundleContainsSummary = {
    ...passedSummary,
    evidence: {
      ...passedSummary.evidence,
      skillOutput: {
        ...passedSummary.evidence.skillOutput,
        bundleContainsEvent: false,
      },
    },
  };
  assert(
    'verifier self-test rejects Skill output bundles that do not include the event',
    verifierSummaryIssues(driftedSkillBundleContainsSummary).includes(
      'passed summary evidence.skillOutput.bundleContainsEvent must be true',
    ),
    verifierSummaryIssues(driftedSkillBundleContainsSummary),
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
  const driftedWarningBundleSchemaSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      bundleSchemaVersion: 'legacy.bundle.v0',
    },
  };
  assert(
    'verifier self-test rejects warning bundle schema drift',
    verifierSummaryIssues(driftedWarningBundleSchemaSummary).includes(
      'triggered warning.bundleSchemaVersion must be anysentry.evidence_bundle.v1',
    ),
    verifierSummaryIssues(driftedWarningBundleSchemaSummary),
  );
  const missingWarningSourceEventSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      bundleContainsSourceEvent: false,
    },
  };
  assert(
    'verifier self-test rejects warning bundles that omit the source event',
    verifierSummaryIssues(missingWarningSourceEventSummary).includes(
      'triggered warning.bundleContainsSourceEvent must be true',
    ),
    verifierSummaryIssues(missingWarningSourceEventSummary),
  );
  const driftedWarningBundleCountSummary = {
    ...passedSummary,
    warning: {
      ...passedSummary.warning,
      bundleEventCount: 2,
    },
  };
  assert(
    'verifier self-test rejects warning bundle count drift',
    verifierSummaryIssues(driftedWarningBundleCountSummary).includes(
      'triggered warning.bundleEventCount must match evidence.bundleEventCount',
    ),
    verifierSummaryIssues(driftedWarningBundleCountSummary),
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
    'verifier self-test rejects failed summaries without details',
    verifierSummaryIssues(invalidFailureSummary).includes('failed summary failure.details must be present'),
    verifierSummaryIssues(invalidFailureSummary),
  );

  assert(
    'verifier self-test rejects failed summaries without evidence status',
    verifierSummaryIssues(invalidFailureSummary).includes('failed summary failure.evidence must be an object'),
    verifierSummaryIssues(invalidFailureSummary),
  );

  const directSkillOutput = parseSkillOutputJson({ output: '{"eventId":"evt_a","bundleId":"evb_a"}' });
  assert('verifier self-test parses compact Skill JSON output', directSkillOutput.eventId === 'evt_a' && directSkillOutput.bundleId === 'evb_a', directSkillOutput);
  const finalLineSkillOutput = parseSkillOutputJson({ output: 'log line {"ignored":true}\n{"eventId":"evt_b","bundleId":"evb_b"}' });
  assert(
    'verifier self-test parses only the final Skill output line as JSON',
    finalLineSkillOutput.eventId === 'evt_b' && finalLineSkillOutput.bundleId === 'evb_b',
    finalLineSkillOutput,
  );
  try {
    parseSkillOutputJson({ output: '{"eventId":"evt_stale","bundleId":"evb_stale"}\nVERDICT: PASS' });
    fail('verifier self-test rejects JSON objects that are not the final output line');
  } catch (error) {
    assert(
      'verifier self-test rejects JSON objects that are not the final output line',
      error instanceof Error && error.message.includes('Skill output final line was not a JSON object'),
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    parseSkillOutputJson({ output: 'not json' });
    fail('verifier self-test rejects non-JSON Skill output');
  } catch (error) {
    assert(
      'verifier self-test rejects non-JSON Skill output',
      error instanceof Error && error.message.includes('Skill output final line was not a JSON object'),
      error instanceof Error ? error.message : String(error),
    );
  }
  const source = innerVerifierSource();
  const missingSourceTimingFields = skillOutputTimingFields.filter((field) => !source.includes(field));
  assert(
    'verifier self-test keeps all Skill inner timing fields in the inner verifier source',
    missingSourceTimingFields.length === 0,
    missingSourceTimingFields,
  );
  const missingSourceEventTimingAttributes = eventInnerTimingFields.filter(
    (field) => !source.includes(`progressive.verifier.${field}`),
  );
  assert(
    'verifier self-test keeps all stored event inner timing attributes in the inner verifier source',
    missingSourceEventTimingAttributes.length === 0,
    missingSourceEventTimingAttributes,
  );
  const missingSourceEventPreflightAttributes = skillOutputPreflightBindings
    .filter(({ attribute }) => !source.includes(attribute))
    .map(({ attribute }) => attribute);
  assert(
    'verifier self-test keeps all stored event preflight attributes in the inner verifier source',
    missingSourceEventPreflightAttributes.length === 0,
    missingSourceEventPreflightAttributes,
  );
  const skillCommand = buildSkillCommand();
  const expectedIdentityJson = JSON.stringify({ runId, agentId, sessionId, workspacePath });
  assert(
    'verifier self-test binds Skill command identity through typed JSON',
    skillCommand.includes(`ANYSENTRY_A3S_CODE_IDENTITY_JSON=${shellQuote(expectedIdentityJson)}`) &&
      skillCommand.includes('node scripts/verify-a3s-code-skill-inner.mjs'),
    skillCommand,
  );

  if (process.exitCode) process.exit(process.exitCode);
  console.log('a3s-code Skill verifier self-test passed');
}

function innerVerifierSource() {
  return fs.readFileSync(innerVerifierScript, 'utf8');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, `'"'"'`)}'`;
}

function buildSkillCommand() {
  return [
    `ANYSENTRY_API_BASE=${shellQuote(apiBase)}`,
    `A3S_TEST_MODEL=${shellQuote(model)}`,
    `ANYSENTRY_A3S_CODE_IDENTITY_JSON=${shellQuote(JSON.stringify({ runId, agentId, sessionId, workspacePath }))}`,
    `ANYSENTRY_A3S_CODE_VERIFIER_ATTRIBUTES_JSON=${shellQuote(JSON.stringify(verifierAttributes))}`,
    `ANYSENTRY_A3S_CODE_EXPECTED_PROGRESSIVE_FLOW=${shellQuote(expectedProgressiveFlow)}`,
    'node scripts/verify-a3s-code-skill-inner.mjs',
  ].join(' ');
}

function buildSkillPrompt() {
  return `
Use the anysentry-api Skill instructions to verify the progressive API at ${apiBase}.

Constraints:
- Do not deploy services.
- Do not edit files.
- Use bash to run exactly one verification command.
- Follow the progressive flow: healthz, list, describe, execute, events/list, buildEvidenceBundle.
- Return only the final stdout line printed by the command, copied byte-for-byte.
- Do not reconstruct, rewrite, or summarize the JSON yourself.
- If the command succeeds, any markdown, bullets, prose, or rewritten JSON makes this verification fail.

Run this command:

\`\`\`sh
${buildSkillCommand()}
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
  assert('a3s-code Skill inner verifier exists', fs.existsSync(innerVerifierScript), innerVerifierScript);
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
    const skillOutputIssues = skillOutputEvidenceIssues(skillOutput);
    assert('Skill output reports the recorded LlmCall allow event and bundle for this run', skillOutputIssues.length === 0, {
      skillOutputIssues,
      skillOutput,
    });
    if (skillOutputIssues.length > 0) {
      timings.elapsed = durationMs(verifierStartedAt);
      const reason = 'skill output did not match the verifier run';
      const details = { skillOutputIssues, skillOutput, workspacePath, runId, agentId, sessionId };
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
      return list.items?.find(
        (item) =>
          item.eventId === skillOutput.eventId &&
          item.workspacePath === workspacePath &&
          item.runId === runId &&
          item.agentId === agentId &&
          item.sessionId === sessionId,
      );
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
      event?.eventKind === 'LlmCall' && event?.eventCategory === 'llm' && event?.verdict === 'allow',
      'event_contract',
      'stored event was not LlmCall llm allow evidence',
      event,
    );
    await requireVerification(
      'stored event carries the verifier target identity',
      event?.workspacePath === workspacePath && event?.runId === runId && event?.agentId === agentId && event?.sessionId === sessionId,
      'event_contract',
      'stored event lost verifier target identity',
      event,
    );
    const skillEventIssues = skillEventAttributeIssues(event?.attributes);
    await requireVerification(
      'stored event carries the a3s-code Skill evidence markers',
      skillEventIssues.length === 0,
      'event_contract',
      'stored event lost or drifted a3s-code Skill evidence markers',
      { skillEventIssues, event },
    );
    const eventPreflightIssues = eventPreflightAttributeIssues(event?.attributes, skillOutput);
    await requireVerification(
      'stored event binds Skill preflight proof attributes to the Skill output',
      eventPreflightIssues.length === 0,
      'event_contract',
      'stored event lost or drifted Skill preflight proof attributes',
      { eventPreflightIssues, event, skillOutput },
    );
    const eventAuditIssues = verifierAttributeIssues(event?.attributes);
    await requireVerification(
      'stored event carries verifier audit metadata',
      eventAuditIssues.length === 0,
      'event_contract',
      'stored event lost verifier audit metadata',
      { missingOrMismatchedVerifierAttributes: eventAuditIssues, event },
    );
    const eventInnerTimingIssues = eventInnerTimingAttributeIssues(event?.attributes, skillOutput.timings);
    await requireVerification(
      'stored event binds pre-record inner API timing metadata to the Skill output',
      eventInnerTimingIssues.length === 0,
      'event_contract',
      'stored event lost or drifted pre-record inner API timing metadata',
      { eventInnerTimingIssues, event, skillOutputTimings: skillOutput.timings },
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
    const bundleBindingIssues = evidenceBundleBindingIssues(bundle, skillOutput, event.eventId);
    await requireVerification(
      'Evidence Bundle metadata matches the Skill output',
      bundleBindingIssues.length === 0,
      'evidence_bundle',
      'evidence bundle metadata did not match the Skill output',
      { bundleBindingIssues, eventId: event.eventId, bundle, skillOutput },
    );
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
      timings.failurePhase = 'near_timeout_warning';
      const failureTimings = {
        ...timings,
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

    const summaryBase = verifierSummaryBase(process.exitCode ? 'failed' : 'passed');
    printVerifierSummary({
      ...summaryBase,
      verifier: {
        ...summaryBase.verifier,
        skill: metadata.skill_name,
        toolCalls: Number(metadata.tool_calls ?? 0),
      },
      evidence: {
        eventId: event.eventId,
        workspacePath: event.workspacePath,
        runId: event.runId,
        agentId: event.agentId,
        sessionId: event.sessionId,
        eventKind: event.eventKind,
        eventCategory: event.eventCategory,
        verdict: event.verdict,
        bundleId: bundle.bundleId,
        bundleSchemaVersion: bundle.schemaVersion,
        bundleContainsEvent: bundle.events?.some((item) => item.eventId === event.eventId) === true,
        bundleEventCount: bundle.summary?.eventCount,
        persistedPreflightAttributes: persistedPreflightAttributeEvidence(event.attributes),
        skillOutput: {
          eventId: skillOutput.eventId,
          workspacePath: skillOutput.workspacePath,
          runId: skillOutput.runId,
          agentId: skillOutput.agentId,
          sessionId: skillOutput.sessionId,
          eventKind: skillOutput.eventKind,
          eventCategory: skillOutput.eventCategory,
          verdict: skillOutput.verdict,
          bundleId: skillOutput.bundleId,
          healthOk: skillOutput.healthOk,
          listed: skillOutput.listed,
          described: skillOutput.described,
          bundleSchemaVersion: skillOutput.bundleSchemaVersion,
          bundleContainsEvent: skillOutput.bundleContainsEvent,
          bundleEventCount: skillOutput.bundleEventCount,
          queriedBack: skillOutput.queriedBack,
          timings: skillOutput.timings,
        },
      },
      warning: {
        required: requireNearTimeoutWarning,
        triggered: Boolean(warningEvent),
        thresholdMs: nearTimeoutThresholdMs,
        reason: warningEvent?.attributes?.['progressive.warning.reason'],
        eventId: warningEvent?.eventId,
        sourceEventId: warningEvent?.attributes?.['progressive.warning.eventId'],
        workspacePath: warningEvent?.workspacePath,
        runId: warningEvent?.runId,
        agentId: warningEvent?.agentId,
        sessionId: warningEvent?.sessionId,
        eventKind: warningEvent?.eventKind,
        eventCategory: warningEvent?.eventCategory,
        verdict: warningEvent?.verdict,
        bundleId: warningEvent?.attributes?.['progressive.warning.bundleId'],
        bundleSchemaVersion: warningEvent ? bundle.schemaVersion : undefined,
        bundleContainsSourceEvent: warningEvent ? bundle.events?.some((item) => item.eventId === event.eventId) === true : undefined,
        bundleEventCount: warningEvent ? bundle.summary?.eventCount : undefined,
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
      lastVerifierTimings.failurePhase = 'uncaught';
      printVerifierSummary(failureSummary('uncaught', 'verification threw', message, lastVerifierTimings));
    }
    process.exit(process.exitCode || 1);
  });
}
