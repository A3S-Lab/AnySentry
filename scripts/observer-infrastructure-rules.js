'use strict';

const INFRASTRUCTURE_RULES_SCHEMA = 'anysentry.infrastructure_rules.v1';
const INFRASTRUCTURE_POLICY_SCHEMA = 'anysentry.infrastructure_policy_snapshot.v1';
const INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA = 'anysentry.infrastructure_capture_intent.v1';
const RULE_ROLES = new Set(['infrastructure', 'agent']);
const RULE_AUTHORITIES = new Set(['candidate', 'authoritative']);
const RULE_STAGES = new Set(['candidate', 'shadow', 'canary', 'enforce', 'disabled']);
const FILTER_ACTIONS = new Set(['keep', 'sample', 'drop']);
const CAPTURE_INTENT_ACTIONS = new Set(['full', 'aggregate', 'sample', 'drop']);
const SELECTOR_TYPES = new Set(['kubernetes', 'docker', 'host']);
const EVENT_POLICY_KEYS = new Set([
  'default',
  'FileAccess',
  'FileDelete',
  'ToolExec',
  'ProcessExit',
  'Egress',
  'Dns',
  'SslContent',
  'LlmCall',
  'SecurityAction',
  'CollectorHeartbeat',
  'RuntimeSnapshot',
  'ContainerLifecycle',
  'PodLifecycle',
]);
const ALWAYS_KEEP_EVENT_KINDS = new Set([
  'CollectorHeartbeat',
  'RuntimeSnapshot',
  'ContainerLifecycle',
  'PodLifecycle',
  'SecurityAction',
  // These are structural facts, not ordinary Agent activity. Forward them so the API can update
  // the durable Process generation/tombstone before omitting the large non-Agent raw payload.
  'ToolExec',
  'ProcessExit',
]);
const DEFAULT_INFRASTRUCTURE_EVENT_POLICY = Object.freeze({
  default: 'drop',
  FileAccess: 'drop',
  FileDelete: 'drop',
  Egress: 'drop',
  Dns: 'drop',
  SslContent: 'drop',
  LlmCall: 'drop',
});

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function text(value, limit = 500) {
  const normalized = typeof value === 'string'
    ? value.trim()
    : value == null
      ? ''
      : String(value).trim();
  return normalized.slice(0, limit);
}

function exactText(value, field, limit = 500) {
  const normalized = text(value, limit);
  if (!normalized) throw new Error(`${field} must be a non-empty string`);
  if (/[?*\[\]{}]/u.test(normalized)) {
    throw new Error(`${field} must be an exact value, not a pattern`);
  }
  return normalized.toLowerCase();
}

function optionalExactText(value, field, limit = 500) {
  return value == null || text(value, limit) === '' ? undefined : exactText(value, field, limit);
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return parsed;
}

function isoTimestamp(value, field) {
  const normalized = text(value, 80);
  const timestamp = Date.parse(normalized);
  if (!normalized || !Number.isFinite(timestamp)) throw new Error(`${field} must be an ISO timestamp`);
  return { value: new Date(timestamp).toISOString(), timestamp };
}

function normalizedCgroupId(value) {
  const normalized = text(value, 20);
  if (!/^\d{1,20}$/u.test(normalized)) return '';
  try {
    return BigInt(normalized) > 0n ? normalized : '';
  } catch {
    return '';
  }
}

function boundedStrings(value, field, max = 16, limit = 240) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  if (value.length > max) throw new Error(`${field} exceeds ${max} entries`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = text(item, limit);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeAudit(value, ruleId) {
  const audit = object(value);
  if (!audit) throw new Error(`rule ${ruleId} audit must be an object`);
  const createdBy = text(audit.createdBy, 160);
  const changeReason = text(audit.changeReason, 500);
  if (!createdBy) throw new Error(`rule ${ruleId} audit.createdBy is required`);
  if (!changeReason) throw new Error(`rule ${ruleId} audit.changeReason is required`);
  return {
    createdBy,
    changeReason,
    evidenceRefs: boundedStrings(audit.evidenceRefs, `rule ${ruleId} audit.evidenceRefs`),
    ...(text(audit.ticketId, 160) ? { ticketId: text(audit.ticketId, 160) } : {}),
  };
}

function normalizeEventPolicy(value, ruleId) {
  const policy = object(value) ?? {};
  const result = {};
  for (const [eventKind, action] of Object.entries(policy)) {
    if (!EVENT_POLICY_KEYS.has(eventKind)) {
      throw new Error(`rule ${ruleId} eventPolicy contains unsupported key ${eventKind}`);
    }
    if (!FILTER_ACTIONS.has(action)) {
      throw new Error(`rule ${ruleId} eventPolicy.${eventKind} must be keep, sample, or drop`);
    }
    result[eventKind] = action;
  }
  return result;
}

function normalizeCaptureIntent(value, ruleId) {
  if (value == null) return undefined;
  const intent = object(value);
  if (
    !intent
    || intent.schemaVersion !== INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA
    || !CAPTURE_INTENT_ACTIONS.has(intent.action)
    || Object.keys(intent).some((field) => field !== 'schemaVersion' && field !== 'action')
  ) {
    throw new Error(
      `rule ${ruleId} captureIntent must use ${INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA} with full, aggregate, sample, or drop`,
    );
  }
  return {
    schemaVersion: INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA,
    action: intent.action,
  };
}

function captureIntentFilterAction(captureIntent) {
  if (captureIntent.action === 'full') return 'keep';
  if (captureIntent.action === 'drop') return 'drop';
  // The legacy post-Ring filter vocabulary has no aggregate action. SAMPLE keeps that layer
  // conservative while the Ring-before compiler retains the exact versioned intent.
  return 'sample';
}

function captureIntentEventPolicy(captureIntent) {
  const action = captureIntentFilterAction(captureIntent);
  return Object.fromEntries(Object.keys(DEFAULT_INFRASTRUCTURE_EVENT_POLICY).map((eventKind) => [eventKind, action]));
}

function normalizeSelector(value, ruleId) {
  const selector = object(value);
  if (!selector || !SELECTOR_TYPES.has(selector.type)) {
    throw new Error(`rule ${ruleId} selector.type must be kubernetes, docker, or host`);
  }
  const allowedFields = selector.type === 'kubernetes'
    ? new Set(['type', 'clusterId', 'namespace', 'ownerKind', 'ownerName', 'containerName', 'imageDigest'])
    : selector.type === 'docker'
      ? new Set(['type', 'hostGroup', 'composeProject', 'composeService', 'containerName', 'imageDigest'])
      : new Set(['type', 'hostGroup', 'systemdUnit', 'executable']);
  const unsupported = Object.keys(selector).find((field) => !allowedFields.has(field));
  if (unsupported) throw new Error(`rule ${ruleId} selector contains unsupported field ${unsupported}`);
  if (selector.type === 'kubernetes') {
    const result = {
      type: 'kubernetes',
      clusterId: exactText(selector.clusterId, `rule ${ruleId} selector.clusterId`, 240),
      namespace: exactText(selector.namespace, `rule ${ruleId} selector.namespace`, 160),
      ownerKind: exactText(selector.ownerKind, `rule ${ruleId} selector.ownerKind`, 120),
      ownerName: exactText(selector.ownerName, `rule ${ruleId} selector.ownerName`, 240),
      containerName: exactText(selector.containerName, `rule ${ruleId} selector.containerName`, 240),
    };
    const imageDigest = optionalExactText(
      selector.imageDigest,
      `rule ${ruleId} selector.imageDigest`,
      500,
    );
    if (imageDigest) result.imageDigest = imageDigest;
    return result;
  }
  if (selector.type === 'docker') {
    const result = {
      type: 'docker',
      hostGroup: exactText(selector.hostGroup, `rule ${ruleId} selector.hostGroup`, 240),
    };
    const composeProject = optionalExactText(
      selector.composeProject,
      `rule ${ruleId} selector.composeProject`,
      240,
    );
    const composeService = optionalExactText(
      selector.composeService,
      `rule ${ruleId} selector.composeService`,
      240,
    );
    const containerName = optionalExactText(
      selector.containerName,
      `rule ${ruleId} selector.containerName`,
      240,
    );
    const imageDigest = optionalExactText(
      selector.imageDigest,
      `rule ${ruleId} selector.imageDigest`,
      500,
    );
    const composeIdentity = Boolean(composeProject && composeService);
    const standaloneIdentity = Boolean(containerName && imageDigest);
    if (!composeIdentity && !standaloneIdentity) {
      throw new Error(
        `rule ${ruleId} Docker selector requires composeProject+composeService or containerName+imageDigest`,
      );
    }
    if (composeProject) result.composeProject = composeProject;
    if (composeService) result.composeService = composeService;
    if (containerName) result.containerName = containerName;
    if (imageDigest) result.imageDigest = imageDigest;
    return result;
  }
  const result = {
    type: 'host',
    hostGroup: exactText(selector.hostGroup, `rule ${ruleId} selector.hostGroup`, 240),
    systemdUnit: exactText(selector.systemdUnit, `rule ${ruleId} selector.systemdUnit`, 240),
  };
  const executable = optionalExactText(selector.executable, `rule ${ruleId} selector.executable`, 500);
  if (executable) result.executable = executable;
  return result;
}

function normalizeRule(value) {
  const rule = object(value);
  if (!rule) throw new Error('rule must be an object');
  const id = exactText(rule.id, 'rule.id', 160);
  const revision = positiveInteger(rule.revision, `rule ${id} revision`);
  if (!RULE_ROLES.has(rule.role)) throw new Error(`rule ${id} has invalid role`);
  if (!RULE_AUTHORITIES.has(rule.authority)) throw new Error(`rule ${id} has invalid authority`);
  if (!RULE_STAGES.has(rule.stage)) throw new Error(`rule ${id} has invalid stage`);
  const createdAt = isoTimestamp(rule.createdAt, `rule ${id} createdAt`);
  const updatedAt = isoTimestamp(rule.updatedAt, `rule ${id} updatedAt`);
  const expiresAt = isoTimestamp(rule.expiresAt, `rule ${id} expiresAt`);
  if (createdAt.timestamp > updatedAt.timestamp || updatedAt.timestamp >= expiresAt.timestamp) {
    throw new Error(`rule ${id} timestamps must satisfy createdAt <= updatedAt < expiresAt`);
  }
  const source = text(rule.source, 120);
  const reasonCode = text(rule.reasonCode, 160);
  if (!source) throw new Error(`rule ${id} source is required`);
  if (!reasonCode) throw new Error(`rule ${id} reasonCode is required`);
  const captureIntent = normalizeCaptureIntent(rule.captureIntent, id);
  const eventPolicy = normalizeEventPolicy(rule.eventPolicy, id);
  const projectedIntentPolicy = captureIntent ? captureIntentEventPolicy(captureIntent) : undefined;
  if (
    projectedIntentPolicy
    && Object.entries(eventPolicy).some(([eventKind, action]) => projectedIntentPolicy[eventKind] !== action)
  ) {
    throw new Error(`rule ${id} eventPolicy conflicts with its versioned captureIntent`);
  }
  return {
    id,
    revision,
    role: rule.role,
    authority: rule.authority,
    stage: rule.stage,
    selector: normalizeSelector(rule.selector, id),
    ...(captureIntent ? { captureIntent } : {}),
    eventPolicy: projectedIntentPolicy ?? eventPolicy,
    source,
    reasonCode,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
    expiresAt: expiresAt.value,
    expiresAtMs: expiresAt.timestamp,
    audit: normalizeAudit(rule.audit, id),
  };
}

function validateInfrastructureRuleDocument(value) {
  const document = object(value);
  if (!document || document.schemaVersion !== INFRASTRUCTURE_RULES_SCHEMA) {
    throw new Error(`schemaVersion must be ${INFRASTRUCTURE_RULES_SCHEMA}`);
  }
  const version = positiveInteger(document.version, 'document.version');
  const generatedAt = isoTimestamp(document.generatedAt, 'document.generatedAt');
  if (!Array.isArray(document.rules)) throw new Error('document.rules must be an array');
  if (document.rules.length > 10_000) throw new Error('document.rules exceeds 10000 entries');
  const ids = new Set();
  const rules = document.rules.map((rule) => {
    const normalized = normalizeRule(rule);
    if (ids.has(normalized.id)) throw new Error(`duplicate rule id ${normalized.id}`);
    ids.add(normalized.id);
    return normalized;
  });
  return {
    schemaVersion: INFRASTRUCTURE_RULES_SCHEMA,
    version,
    generatedAt: generatedAt.value,
    rules,
  };
}

function parseClusterId(physicalWorkloadId) {
  const normalized = text(physicalWorkloadId);
  return normalized.startsWith('k8s:') ? normalized.split(':')[1] : '';
}

function imageDigest(value, explicit) {
  const direct = text(explicit).toLowerCase();
  if (direct) return direct;
  const image = text(value).toLowerCase();
  const marker = image.indexOf('@sha256:');
  return marker >= 0 ? image.slice(marker + 1) : '';
}

function normalizeWorkloadFacts(value) {
  const input = object(value) ?? {};
  const workload = object(input.workloadRef) ?? {};
  const processInfo = object(input.process) ?? {};
  const labels = object(input.labels) ?? object(workload.labels) ?? {};
  const type = text(
    input.type ?? input.deployment ?? input.environment ?? workload.environment,
  ).toLowerCase();
  const physicalWorkloadId = text(input.physicalWorkloadId);
  return {
    type,
    clusterId: text(input.clusterId ?? parseClusterId(physicalWorkloadId)).toLowerCase(),
    namespace: text(input.namespace ?? workload.namespace).toLowerCase(),
    ownerKind: text(input.ownerKind ?? workload.ownerKind).toLowerCase(),
    ownerName: text(input.ownerName ?? workload.ownerName).toLowerCase(),
    containerName: text(input.containerName ?? workload.containerName).toLowerCase(),
    imageDigest: imageDigest(
      input.containerImage ?? workload.containerImage,
      input.imageDigest,
    ),
    hostGroup: text(input.hostGroup ?? input.nodeGroup ?? input.fleetId).toLowerCase(),
    composeProject: text(
      input.composeProject ?? labels['com.docker.compose.project'],
    ).toLowerCase(),
    composeService: text(
      input.composeService ?? labels['com.docker.compose.service'],
    ).toLowerCase(),
    systemdUnit: text(
      input.systemdUnit ?? workload.systemdUnit ?? processInfo.systemdUnit ?? processInfo.systemd_unit,
    ).toLowerCase(),
    executable: text(
      input.executable ?? workload.executable ?? processInfo.exe,
    ).toLowerCase(),
    physicalWorkloadId,
    agentInstanceId: text(input.agentInstanceId),
  };
}

function selectorMatches(selector, factsInput) {
  const facts = normalizeWorkloadFacts(factsInput);
  if (selector.type !== facts.type) return false;
  const fields = selector.type === 'kubernetes'
    ? ['clusterId', 'namespace', 'ownerKind', 'ownerName', 'containerName', 'imageDigest']
    : selector.type === 'docker'
      ? ['hostGroup', 'composeProject', 'composeService', 'containerName', 'imageDigest']
      : ['hostGroup', 'systemdUnit', 'executable'];
  return fields.every((field) => !selector[field] || selector[field] === facts[field]);
}

function selectorSpecificity(selector) {
  return Object.entries(selector).filter(([key, value]) => key !== 'type' && Boolean(value)).length;
}

function authorityRank(authority) {
  return authority === 'authoritative' ? 2 : 1;
}

function stageRank(stage) {
  if (stage === 'enforce') return 4;
  if (stage === 'canary') return 3;
  if (stage === 'shadow') return 2;
  if (stage === 'candidate') return 1;
  return 0;
}

function ruleRank(left, right) {
  return authorityRank(right.authority) - authorityRank(left.authority)
    || selectorSpecificity(right.selector) - selectorSpecificity(left.selector)
    || stageRank(right.stage) - stageRank(left.stage)
    || right.revision - left.revision
    || left.id.localeCompare(right.id);
}

function rolloutActive(rule, options) {
  return rule.stage === 'enforce' || (rule.stage === 'canary' && options.canaryEnabled === true);
}

function alwaysKeepEventKind(eventKind) {
  return ALWAYS_KEEP_EVENT_KINDS.has(eventKind)
    || /(?:Heartbeat|Snapshot|Lease|Lifecycle|RuleAck|SecurityAction)$/u.test(eventKind);
}

function policyRuleDocument(value, options = {}) {
  const policy = object(value);
  if (!policy || policy.schemaVersion !== INFRASTRUCTURE_POLICY_SCHEMA) {
    throw new Error(`schemaVersion must be ${INFRASTRUCTURE_POLICY_SCHEMA}`);
  }
  const policyVersion = Number(policy.policyVersion);
  if (!Number.isSafeInteger(policyVersion) || policyVersion < 0) {
    throw new Error('policyVersion must be a non-negative safe integer');
  }
  if (!Array.isArray(policy.rules)) throw new Error('policy.rules must be an array');
  const generatedAt = isoTimestamp(policy.generatedAt, 'policy.generatedAt');
  const expiresAt = isoTimestamp(policy.expiresAt, 'policy.expiresAt');
  if (generatedAt.timestamp >= expiresAt.timestamp) {
    throw new Error('policy timestamps must satisfy generatedAt < expiresAt');
  }
  const hostGroup = exactText(
    options.hostGroup || options.nodeId || 'local',
    'policy materializer hostGroup',
    240,
  );
  const rules = policy.rules.map((rawRule) => {
    const rule = object(rawRule);
    if (!rule) throw new Error('policy rule must be an object');
    const ruleId = exactText(rule.ruleId, 'policy ruleId', 160);
    const selector = object(rule.selector);
    if (!selector) throw new Error(`policy rule ${ruleId} selector must be an object`);
    let mappedSelector;
    if (selector.placement === 'docker') {
      mappedSelector = {
        type: 'docker',
        hostGroup,
        composeProject: selector.composeProject,
        composeService: selector.serviceName,
        ...(selector.containerName ? { containerName: selector.containerName } : {}),
        ...(selector.imageDigest ? { imageDigest: selector.imageDigest } : {}),
      };
    } else if (selector.placement === 'kubernetes') {
      mappedSelector = {
        type: 'kubernetes',
        clusterId: selector.clusterId,
        namespace: selector.namespace,
        ownerKind: selector.ownerKind,
        ownerName: selector.ownerName,
        containerName: selector.containerName,
        ...(selector.imageDigest ? { imageDigest: selector.imageDigest } : {}),
      };
    } else if (selector.placement === 'host') {
      mappedSelector = {
        type: 'host',
        hostGroup: selector.nodeId || hostGroup,
        systemdUnit: selector.systemdUnit,
        ...(selector.configuredRoot ? { executable: selector.configuredRoot } : {}),
      };
    } else {
      throw new Error(`policy rule ${ruleId} has unsupported placement`);
    }
    const lifecycleStage = text(rule.lifecycleStage).toLowerCase();
    const stage = lifecycleStage === 'enforced'
      ? 'enforce'
      : lifecycleStage === 'shadow'
        ? 'shadow'
        : lifecycleStage === 'revoked'
          ? 'disabled'
          : 'candidate';
    const createdAtMs = Number(rule.createdAt);
    const updatedAtMs = Number(rule.updatedAt);
    const safeCreatedAt = Number.isFinite(createdAtMs) ? createdAtMs : generatedAt.timestamp;
    const safeUpdatedAt = Number.isFinite(updatedAtMs) ? updatedAtMs : safeCreatedAt;
    const captureIntent = normalizeCaptureIntent(rule.captureIntent, ruleId);
    if (captureIntent && Object.keys(object(rule.eventPolicies) ?? {}).length > 0) {
      throw new Error(`policy rule ${ruleId} cannot combine captureIntent with legacy eventPolicies`);
    }
    return {
      id: ruleId,
      revision: rule.revision,
      role: 'infrastructure',
      authority: rule.authority,
      stage,
      selector: mappedSelector,
      ...(captureIntent ? { captureIntent } : {}),
      eventPolicy: captureIntent
        ? captureIntentEventPolicy(captureIntent)
        : {
            default: 'drop',
            FileAccess: 'drop',
            FileDelete: 'drop',
            Egress: 'drop',
            Dns: 'drop',
            SslContent: 'drop',
            LlmCall: 'drop',
            ...(object(rule.eventPolicies) ?? {}),
          },
      source: text(rule.source?.type, 120) || 'platform_inventory',
      reasonCode: text(rule.reasonCode, 160) || 'platform_infrastructure',
      createdAt: new Date(Math.min(safeCreatedAt, safeUpdatedAt)).toISOString(),
      updatedAt: new Date(Math.max(safeCreatedAt, safeUpdatedAt)).toISOString(),
      expiresAt: expiresAt.value,
      audit: {
        createdBy: text(rule.source?.issuer, 160) || text(rule.createdBy, 160) || 'infrastructure-rule-service',
        changeReason: `central policy ${policyVersion}, rule revision ${rule.revision}`,
        evidenceRefs: [
          `policy:${policyVersion}`,
          `rule:${ruleId}:${rule.revision}`,
          ...(rule.contentHash ? [`sha256:${text(rule.contentHash, 80)}`] : []),
        ],
        ...(rule.changeTicket ? { ticketId: text(rule.changeTicket, 160) } : {}),
      },
    };
  });
  return {
    schemaVersion: INFRASTRUCTURE_RULES_SCHEMA,
    // The local resolver requires a positive epoch while the central service legitimately starts
    // at policyVersion=0. Version 1 with zero rules remains a no-op and cannot authorize a drop.
    version: Math.max(1, policyVersion),
    generatedAt: generatedAt.value,
    rules,
  };
}

function desiredAction(rule, eventKind) {
  if (rule.role === 'agent') return 'keep';
  if (alwaysKeepEventKind(eventKind)) return 'keep';
  return rule.eventPolicy[eventKind]
    ?? rule.eventPolicy.default
    ?? DEFAULT_INFRASTRUCTURE_EVENT_POLICY[eventKind]
    ?? DEFAULT_INFRASTRUCTURE_EVENT_POLICY.default;
}

function effectiveAction(rule, eventKind, options) {
  const desired = desiredAction(rule, eventKind);
  if (desired !== 'drop') return { action: desired, wouldAction: desired };
  if (rule.authority !== 'authoritative' || !rolloutActive(rule, options)) {
    return { action: 'sample', wouldAction: 'drop' };
  }
  return { action: 'drop', wouldAction: 'drop' };
}

function conservativeAction(actions) {
  if (actions.includes('keep')) return 'keep';
  if (actions.includes('sample')) return 'sample';
  return 'drop';
}

function activeRules(rules, facts, now) {
  return rules.filter((rule) =>
    rule.stage !== 'disabled'
    && rule.expiresAtMs > now
    && selectorMatches(rule.selector, facts));
}

function resolveInfrastructureRules(rules, documentVersion, factsInput, eventKind, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Number(options.now ?? Date.now());
  const facts = normalizeWorkloadFacts(factsInput);
  const matched = activeRules(rules, facts, now);
  if (!matched.length) return undefined;
  const agentRules = matched.filter((rule) => rule.role === 'agent').sort(ruleRank);
  const infrastructureRules = matched.filter((rule) => rule.role === 'infrastructure').sort(ruleRank);
  const conflict = agentRules.length > 0 && infrastructureRules.length > 0;
  const roleRules = agentRules.length > 0 ? agentRules : infrastructureRules;
  const highestAuthority = Math.max(...roleRules.map((rule) => authorityRank(rule.authority)));
  const effectiveRules = roleRules.filter((rule) => authorityRank(rule.authority) === highestAuthority);
  const primary = effectiveRules[0];
  const decisions = effectiveRules.map((rule) => effectiveAction(rule, eventKind, options));
  const action = primary.role === 'agent'
    ? 'keep'
    : conservativeAction(decisions.map((decision) => decision.action));
  const wouldAction = primary.role === 'agent'
    ? 'keep'
    : conservativeAction(decisions.map((decision) => decision.wouldAction));
  const rollout = rolloutActive(primary, options);
  const classification = primary.role === 'agent'
    ? primary.authority === 'authoritative' && rollout
      ? 'confirmed_agent'
      : 'probable_agent'
    : primary.authority === 'authoritative' && rollout
      ? 'non_agent'
      : 'unknown';
  const wouldClassification = primary.role === 'agent'
    ? primary.authority === 'authoritative' ? 'confirmed_agent' : 'probable_agent'
    : 'non_agent';
  const expiresAtMs = Math.min(...effectiveRules.map((rule) => rule.expiresAtMs));
  return {
    eventKind,
    role: primary.role,
    candidateRole: primary.role,
    classification,
    wouldClassification,
    authority: primary.authority,
    stage: primary.stage,
    ...(primary.captureIntent ? { captureIntent: { ...primary.captureIntent } } : {}),
    action,
    wouldAction,
    reasonCode: conflict ? 'agent_keep_conflict' : primary.reasonCode,
    source: primary.source,
    conflict,
    documentVersion,
    matchedRuleIds: matched.map((rule) => rule.id).sort(),
    effectiveRuleIds: effectiveRules.map((rule) => rule.id).sort(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    audit: {
      decidedAt: new Date(now).toISOString(),
      primaryRuleId: primary.id,
      primaryRuleRevision: primary.revision,
      evidenceRefs: [...new Set(effectiveRules.flatMap((rule) => rule.audit.evidenceRefs))].slice(0, 16),
      changeReasons: [...new Set(effectiveRules.map((rule) => rule.audit.changeReason))].slice(0, 8),
    },
    facts,
  };
}

function eventKindOf(observerEvent) {
  return Object.keys(object(observerEvent?.event) ?? {})[0] || '';
}

function eventCgroupId(observerEvent) {
  const processInfo = object(observerEvent?.process) ?? {};
  return normalizedCgroupId(processInfo.cgroupId ?? processInfo.cgroup_id);
}

function materializeCgroupFilterDecision(observerEvent, resolution, options = {}) {
  if (!resolution) return undefined;
  const facts = object(resolution.facts) ?? {};
  const cgroupId = normalizedCgroupId(options.cgroupId ?? eventCgroupId(observerEvent));
  if (!cgroupId) return undefined;
  const observedEventKind = text(options.eventKind ?? eventKindOf(observerEvent), 120);
  const eventKind = text(resolution.eventKind ?? observedEventKind, 120);
  if (observedEventKind && eventKind && observedEventKind !== eventKind) {
    throw new Error('resolution eventKind does not match the materialized event');
  }
  let action = resolution.action;
  let wouldAction = resolution.wouldAction;
  if (resolution.role === 'agent' || alwaysKeepEventKind(eventKind)) {
    action = 'keep';
    wouldAction = 'keep';
  } else if (resolution.authority !== 'authoritative' && action === 'drop') {
    action = 'sample';
    wouldAction = 'drop';
  }
  return {
    scopeType: 'cgroup',
    scopeKey: `cgroup:${cgroupId}`,
    cgroupId,
    eventKind,
    role: resolution.role,
    candidateRole: resolution.candidateRole,
    classification: resolution.classification,
    wouldClassification: resolution.wouldClassification,
    authority: resolution.authority,
    stage: resolution.stage,
    ...(resolution.captureIntent ? { captureIntent: { ...resolution.captureIntent } } : {}),
    action,
    wouldAction,
    reasonCode: resolution.reasonCode,
    source: resolution.source,
    conflict: resolution.conflict,
    documentVersion: resolution.documentVersion,
    matchedRuleIds: [...resolution.matchedRuleIds],
    effectiveRuleIds: [...resolution.effectiveRuleIds],
    expiresAt: resolution.expiresAt,
    ...(facts.physicalWorkloadId
      ? { physicalWorkloadId: facts.physicalWorkloadId }
      : {}),
    ...(facts.agentInstanceId
      ? { agentInstanceId: facts.agentInstanceId }
      : {}),
    audit: { ...resolution.audit },
  };
}

class InfrastructureRuleSet {
  constructor(document) {
    this.document = validateInfrastructureRuleDocument(document);
  }

  resolve(facts, eventKind, options = {}) {
    return resolveInfrastructureRules(
      this.document.rules,
      this.document.version,
      facts,
      eventKind,
      options,
    );
  }

  materialize(observerEvent, facts, options = {}) {
    const eventKind = text(options.eventKind ?? eventKindOf(observerEvent), 120);
    const resolution = this.resolve(facts, eventKind, options);
    return materializeCgroupFilterDecision(observerEvent, resolution, { ...options, eventKind });
  }

  snapshot() {
    return {
      schemaVersion: this.document.schemaVersion,
      version: this.document.version,
      generatedAt: this.document.generatedAt,
      rules: this.document.rules.map((rule) => {
        const { expiresAtMs: _expiresAtMs, ...publicRule } = rule;
        return {
          ...publicRule,
          selector: { ...rule.selector },
          eventPolicy: { ...rule.eventPolicy },
          audit: { ...rule.audit, evidenceRefs: [...rule.audit.evidenceRefs] },
        };
      }),
    };
  }
}

module.exports = {
  ALWAYS_KEEP_EVENT_KINDS,
  DEFAULT_INFRASTRUCTURE_EVENT_POLICY,
  INFRASTRUCTURE_CAPTURE_INTENT_SCHEMA,
  INFRASTRUCTURE_RULES_SCHEMA,
  INFRASTRUCTURE_POLICY_SCHEMA,
  InfrastructureRuleSet,
  alwaysKeepEventKind,
  eventCgroupId,
  materializeCgroupFilterDecision,
  normalizeWorkloadFacts,
  policyRuleDocument,
  resolveInfrastructureRules,
  selectorMatches,
  validateInfrastructureRuleDocument,
};
