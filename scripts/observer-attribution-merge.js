'use strict';

const MAX_EVIDENCE = 16;

const DECISION_FIELDS = new Set([
  'monitored',
  'classification',
  'confidence',
  'source',
  'reason',
]);

const IDENTITY_FIELDS = new Set([
  'agentScopeId',
  'agentDisplayName',
  'agentInstanceId',
  'rootPid',
  'rootKey',
  'rootGeneration',
]);

const CONTAINER_FIELDS = new Set(['physicalWorkloadId', 'workloadRef']);
const SPECIAL_ATTRIBUTION_FIELDS = new Set([
  ...DECISION_FIELDS,
  ...IDENTITY_FIELDS,
  ...CONTAINER_FIELDS,
  'evidence',
  'conflict',
]);

const SPECIAL_RESULT_FIELDS = new Set([
  'state',
  'attribution',
  // This is a Forwarder-resolved rollout view. Never inherit a producer/classifier copy through a
  // merge because a later, more authoritative layer may change any of its three axes.
  'classificationSemantics',
  'workspacePath',
  'workspaceSource',
  'workspaceConflict',
]);

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (object(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
  }
  return value;
}

function inferredClassification(result, attribution) {
  const classification = text(attribution.classification).toLowerCase();
  if (['confirmed_agent', 'probable_agent', 'non_agent', 'unknown'].includes(classification)) {
    return classification;
  }
  if (result.state === 'agent') return 'probable_agent';
  if (result.state === 'non_agent') return 'non_agent';
  return 'unknown';
}

function defaultConfidence(classification) {
  if (classification === 'confirmed_agent' || classification === 'non_agent') return 1;
  if (classification === 'probable_agent') return 0.5;
  return 0;
}

function confidence(attribution, classification) {
  const value = Number(attribution.confidence);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : defaultConfidence(classification);
}

function defaultReason(classification) {
  if (classification === 'confirmed_agent') return 'authoritative_anchor';
  if (classification === 'non_agent') return 'not_agent';
  if (classification === 'probable_agent') return 'hint_only';
  return 'not_evaluated';
}

function defaultSource(layer) {
  if (layer === 'template') return 'self_register';
  if (layer === 'workload') return 'workload_identity';
  return 'process_graph';
}

function candidate(layer, result, layerPriority) {
  const normalizedResult = object(result);
  if (!normalizedResult) return undefined;
  const rawAttribution = object(normalizedResult.attribution) || {};
  const infrastructure = normalizedResult.state === 'infrastructure';
  const attribution = infrastructure
    ? {
        ...rawAttribution,
        monitored: false,
        classification: 'non_agent',
        confidence: 1,
        source: text(rawAttribution.source) || text(normalizedResult.source) || 'configured_root',
        reason: 'platform_infrastructure',
        evidence: Array.isArray(rawAttribution.evidence)
          ? rawAttribution.evidence
          : [`infrastructure:${text(normalizedResult.serviceName) || 'configured-root'}`],
      }
    : rawAttribution;
  const classification = infrastructure
    ? 'non_agent'
    : inferredClassification(normalizedResult, attribution);
  return {
    layer,
    layerPriority,
    result: normalizedResult,
    attribution,
    classification,
    confidence: confidence(attribution, classification),
    infrastructure,
  };
}

function classificationStrength(classification) {
  if (classification === 'confirmed_agent') return 4;
  if (classification === 'probable_agent') return 3;
  // Unknown container/template identity is a boundary, so a host PID-to-init conclusion must not
  // turn it into non-Agent. A positive process signature can still identify an unlabeled Agent.
  if (classification === 'unknown') return 2;
  return 1;
}

function decisionCandidate(candidates) {
  // A positive Agent decision is fail-safe and always wins an Infrastructure/non-Agent match.
  // The losing negative decision remains explicit conflict evidence below.
  const agent = [...candidates]
    .filter((entry) => entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent')
    .sort(
      (left, right) =>
        classificationStrength(right.classification) - classificationStrength(left.classification) ||
        right.confidence - left.confidence ||
        right.layerPriority - left.layerPriority,
    )[0];
  if (agent) return agent;

  // A template or workload confirmed/non-agent classification is an explicit deployment
  // decision. Infrastructure roots are also authoritative only after Agent candidates are ruled
  // out. Keep the existing template-before-workload tie break when both are negative decisions.
  const authoritative = candidates.find(
    (entry) =>
      (entry.infrastructure || entry.layer === 'template' || entry.layer === 'workload') &&
      (entry.classification === 'confirmed_agent' || entry.classification === 'non_agent'),
  );
  if (authoritative) return authoritative;

  return [...candidates].sort(
    (left, right) =>
      classificationStrength(right.classification) - classificationStrength(left.classification) ||
      right.confidence - left.confidence ||
      right.layerPriority - left.layerPriority,
  )[0];
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((entry) => {
    if (!entry || seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
}

function preferredValue(candidates, field, predicate = () => true) {
  for (const entry of candidates) {
    const value = entry?.attribution?.[field];
    if (present(value) && predicate(entry, value)) return cloneValue(value);
  }
  return undefined;
}

function describedConflict(field, candidates) {
  const entries = candidates
    .map((entry) => ({ layer: entry.layer, value: text(entry.attribution[field]) }))
    .filter((entry) => entry.value)
    .map((entry) => `${entry.layer}=${entry.value.slice(0, 128)}`);
  return `identity_conflict:${field}:${entries.join('|')}`.slice(0, 512);
}

function distinctTextValues(candidates, field, caseInsensitive = false) {
  const values = new Map();
  for (const entry of candidates) {
    const value = text(entry.attribution[field]);
    if (!value) continue;
    const key = caseInsensitive ? value.toLowerCase() : value;
    if (!values.has(key)) values.set(key, value);
  }
  return [...values.values()];
}

function boundedEvidence(conflictEvidence, candidates) {
  const evidence = [];
  const seen = new Set();
  const add = (value) => {
    const normalized = text(value);
    if (!normalized || seen.has(normalized) || evidence.length >= MAX_EVIDENCE) return;
    seen.add(normalized);
    evidence.push(normalized);
  };
  // Conflict evidence is operationally important and must not disappear when a producer already
  // supplied a full evidence array.
  conflictEvidence.forEach(add);
  for (const entry of candidates) {
    const values = Array.isArray(entry.attribution.evidence) ? entry.attribution.evidence : [];
    values.forEach(add);
  }
  return evidence;
}

function classificationState(classification) {
  if (classification === 'confirmed_agent' || classification === 'probable_agent') return 'agent';
  if (classification === 'non_agent') return 'non_agent';
  return 'unknown';
}

function mergeAttributionClassifications(processClassification, workloadClassification, templateClassification) {
  const process = candidate('process', processClassification, 1);
  const workload = candidate('workload', workloadClassification, 2);
  const template = candidate('template', templateClassification, 3);
  const candidates = [template, workload, process].filter(Boolean);
  if (candidates.length === 0) return undefined;

  const decision = decisionCandidate(candidates);
  const generalPriority = uniqueCandidates([decision, template, workload, process]);
  // Logical Agent identity and physical placement are different axes. A self-registered template
  // owns the most specific identity; otherwise an exact Agent process root is narrower than its
  // container or Pod. The workload can still supply the authoritative classification decision and
  // always remains the sole owner of physicalWorkloadId/workloadRef below. This ordering lets one
  // container host Codex, Claude and other Agent roots without collapsing every conversation into
  // the container name.
  const identityPriority = uniqueCandidates([template, process, workload, decision]);
  const attribution = {};

  // Preserve forward-compatible supplemental fields without allowing them to overwrite the
  // categories whose provenance and conflict behavior are defined below.
  for (const entry of generalPriority) {
    for (const [field, value] of Object.entries(entry.attribution)) {
      if (SPECIAL_ATTRIBUTION_FIELDS.has(field) || !present(value) || present(attribution[field])) continue;
      attribution[field] = cloneValue(value);
    }
  }

  attribution.monitored =
    decision.classification === 'confirmed_agent' || decision.classification === 'probable_agent';
  attribution.classification = decision.classification;
  attribution.confidence = decision.confidence;
  attribution.source = text(decision.attribution.source) || defaultSource(decision.layer);
  attribution.reason = text(decision.attribution.reason) || defaultReason(decision.classification);

  const scopes = distinctTextValues(candidates, 'agentScopeId');
  const displayNames = distinctTextValues(candidates, 'agentDisplayName', true);
  const scopeConflict = scopes.length > 1;
  const displayNameConflict = displayNames.length > 1;
  const conflictEvidence = [];
  const agentNegativeConflict = candidates.some(
    (entry) => entry.classification === 'confirmed_agent' || entry.classification === 'probable_agent',
  ) && candidates.some((entry) => entry.classification === 'non_agent');
  if (scopeConflict) conflictEvidence.push(describedConflict('agentScopeId', candidates));
  if (displayNameConflict) conflictEvidence.push(describedConflict('agentDisplayName', candidates));
  if (agentNegativeConflict) {
    conflictEvidence.push('identity_conflict:agent_keep_vs_infrastructure_or_non_agent');
  }

  const outputScope = preferredValue(identityPriority, 'agentScopeId');
  if (present(outputScope)) attribution.agentScopeId = outputScope;

  const displayName = preferredValue(
    identityPriority,
    'agentDisplayName',
    (entry) => {
      const entryScope = text(entry.attribution.agentScopeId);
      return !outputScope || !entryScope || entryScope === outputScope;
    },
  );
  if (present(displayName)) attribution.agentDisplayName = displayName;

  // The logical runtime instance follows the selected Agent Scope. Physical container/Pod identity
  // is retained separately below; it must not replace a process-root instance when multiple Agent
  // roots share one workload. During a Scope conflict, accept only an instance explicitly owned by
  // the selected Scope.
  const instanceId = preferredValue(
    identityPriority,
    'agentInstanceId',
    (entry) => {
      const entryScope = text(entry.attribution.agentScopeId);
      if (scopeConflict) return Boolean(entryScope && entryScope === outputScope);
      return !outputScope || !entryScope || entryScope === outputScope;
    },
  );
  if (present(instanceId)) attribution.agentInstanceId = instanceId;

  for (const field of ['rootPid', 'rootKey', 'rootGeneration']) {
    const value = preferredValue([process, template, workload].filter(Boolean), field);
    if (present(value)) attribution[field] = value;
  }

  // Container placement is only accepted from the workload classifier. A process/template value
  // cannot impersonate a Docker or Kubernetes physical identity.
  if (workload) {
    if (present(workload.attribution.physicalWorkloadId)) {
      attribution.physicalWorkloadId = cloneValue(workload.attribution.physicalWorkloadId);
    }
    if (object(workload.attribution.workloadRef)) {
      attribution.workloadRef = cloneValue(workload.attribution.workloadRef);
    }
  }

  const workspaceOwner = [process, template, workload].find(
    (entry) =>
      entry &&
      (present(entry.result.workspacePath) ||
        present(entry.result.workspaceSource) ||
        Object.prototype.hasOwnProperty.call(entry.result, 'workspaceConflict')),
  );
  const workspaceConflict = [process, template, workload].some(
    (entry) => entry?.result?.workspaceConflict === true,
  );
  const inheritedConflict = candidates.some((entry) => entry.attribution.conflict === true);
  if (scopeConflict || displayNameConflict || workspaceConflict || inheritedConflict || agentNegativeConflict) {
    attribution.conflict = true;
  }
  attribution.evidence = boundedEvidence(conflictEvidence, generalPriority);

  const result = {};
  for (const entry of generalPriority) {
    for (const [field, value] of Object.entries(entry.result)) {
      if (SPECIAL_RESULT_FIELDS.has(field) || !present(value) || present(result[field])) continue;
      result[field] = cloneValue(value);
    }
  }
  result.state = decision.infrastructure ? 'infrastructure' : classificationState(decision.classification);
  result.attribution = attribution;
  if (workspaceOwner) {
    if (present(workspaceOwner.result.workspacePath)) {
      result.workspacePath = cloneValue(workspaceOwner.result.workspacePath);
    }
    if (present(workspaceOwner.result.workspaceSource)) {
      result.workspaceSource = cloneValue(workspaceOwner.result.workspaceSource);
    }
  }
  if ([process, template, workload].some(
    (entry) => entry && Object.prototype.hasOwnProperty.call(entry.result, 'workspaceConflict'),
  )) {
    result.workspaceConflict = workspaceConflict;
  }
  return result;
}

module.exports = { mergeAttributionClassifications };
