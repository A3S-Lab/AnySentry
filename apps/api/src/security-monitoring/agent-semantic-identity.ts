import type { JudgedEvent } from './types';

export const AGENT_SEMANTIC_IDENTITY_VERSION = 'agent_semantic_identity.v1' as const;

type IdentityEvent = Pick<
  JudgedEvent,
  'agentId' | 'workspacePath' | 'sessionId' | 'attributes' | 'process' | 'attribution'
>;

export interface AgentSemanticIdentityProjection {
  schemaVersion: typeof AGENT_SEMANTIC_IDENTITY_VERSION;
  canonicalIdentityKey: string;
  identityAliases: string[];
  canonicalRuntimeInstanceId: string;
  runtimeInstanceAliases: string[];
  normalizedPhysicalWorkloadId?: string;
  agentRootInstanceId?: string;
  agentProduct?: string;
  bindingQuality: 'exact' | 'weak';
  reasonCode:
    | 'exact_kubernetes_container'
    | 'exact_docker_container'
    | 'exact_host_root'
    | 'attributed_instance'
    | 'physical_workload'
    | 'workload_scope'
    | 'process_generation'
    | 'legacy_session';
}

/**
 * Strong identity atoms shared by the event projection and the independent Runtime Snapshot
 * read model. Existing producer fields remain untouched; consumers use the returned aliases to
 * compare equivalent representations of the same concrete Runtime generation.
 */
export interface AgentRuntimeIdentityAtoms {
  agentInstanceId?: string;
  physicalWorkloadId?: string;
  hostId?: string;
  bootId?: string;
  rootPid?: number;
  rootStartTime?: string;
}

function text(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || undefined;
}

function lower(value: unknown): string | undefined {
  return text(value)?.toLowerCase();
}

function distinct(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizedAgentProduct(value: unknown): string | undefined {
  const normalized = lower(value)
    ?.replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  return normalized || undefined;
}

function stringAttribute(event: IdentityEvent, key: string): string | undefined {
  return text(event.attributes?.[key]);
}

interface KubernetesContainerIdentity {
  clusterId?: string;
  podUid: string;
  containerId: string;
}

const POD_UID = '[a-f0-9][a-f0-9-]{19,159}';
const FULL_CONTAINER_ID = '[a-f0-9]{64}';
const KUBERNETES_PHYSICAL = new RegExp(
  `^k8s:([^:]+):(${POD_UID}):(${FULL_CONTAINER_ID})$`,
  'u',
);
const KUBERNETES_INSTANCE = new RegExp(`^(${POD_UID})/(${FULL_CONTAINER_ID})$`, 'u');
const CONTAINER_CGROUP = /(?:cri-containerd|docker|crio|libpod)[-/]([a-f0-9]{64})(?:\.scope)?/iu;
const POD_CGROUP = /kubepods[^/]*[-/]pod([a-f0-9_-]{20,160})/iu;

function kubernetesContainerIdentity(event: IdentityEvent): KubernetesContainerIdentity | undefined {
  const physical = lower(event.attribution?.physicalWorkloadId);
  const physicalMatch = physical?.match(KUBERNETES_PHYSICAL);
  if (physicalMatch) {
    return {
      clusterId: physicalMatch[1],
      podUid: physicalMatch[2],
      containerId: physicalMatch[3],
    };
  }

  const attributed = lower(event.attribution?.agentInstanceId);
  const instanceMatch = attributed?.match(KUBERNETES_INSTANCE);
  if (instanceMatch) {
    return {
      podUid: instanceMatch[1],
      containerId: instanceMatch[2],
    };
  }

  const cgroup = lower(event.process?.cgroup);
  const containerId = cgroup?.match(CONTAINER_CGROUP)?.[1];
  const cgroupPodUid = cgroup?.match(POD_CGROUP)?.[1]?.replaceAll('_', '-');
  const workloadPodUid = lower(event.attribution?.workloadRef?.podUid);
  const podUid = workloadPodUid ?? cgroupPodUid;
  if (!podUid || !containerId) return undefined;
  return { podUid, containerId };
}

interface DockerContainerIdentity {
  physicalWorkloadId: string;
  containerId: string;
}

function dockerContainerIdentity(event: IdentityEvent): DockerContainerIdentity | undefined {
  const physical = lower(event.attribution?.physicalWorkloadId);
  if (physical?.startsWith('docker:')) {
    const containerId = physical.split(':').at(-1);
    if (containerId && new RegExp(`^${FULL_CONTAINER_ID}$`, 'u').test(containerId)) {
      return { physicalWorkloadId: physical, containerId };
    }
  }
  if (physical?.startsWith('container:')) {
    const containerId = physical.slice('container:'.length);
    if (new RegExp(`^${FULL_CONTAINER_ID}$`, 'u').test(containerId)) {
      return { physicalWorkloadId: physical, containerId };
    }
  }
  const cgroupContainer = lower(event.process?.cgroup)?.match(CONTAINER_CGROUP)?.[1];
  if (!cgroupContainer || event.attribution?.workloadRef?.environment === 'kubernetes') return undefined;
  const host = lower(event.process?.hostId) ?? 'host';
  return {
    physicalWorkloadId: `docker:${host}:${cgroupContainer}`,
    containerId: cgroupContainer,
  };
}

export function hostRootInstanceIdFromAtoms(atoms: AgentRuntimeIdentityAtoms): string | undefined {
  if (!atoms.rootPid || !text(atoms.rootStartTime)) return undefined;
  return [
    'host-root',
    text(atoms.hostId) ?? 'host',
    text(atoms.bootId) ?? 'boot',
    atoms.rootPid,
    text(atoms.rootStartTime),
  ].join(':');
}

/**
 * Produce only strong Runtime-equivalence aliases. Product name, workspace, trace and temporal
 * proximity are deliberately excluded so multiple roots of the same Agent product stay split.
 */
export function agentRuntimeIdentityAliasesFromAtoms(atoms: AgentRuntimeIdentityAtoms): string[] {
  const attributedInstance = text(atoms.agentInstanceId);
  const physical = text(atoms.physicalWorkloadId);
  const normalizedPhysical = lower(physical);
  const aliases: Array<string | undefined> = [
    attributedInstance,
    physical,
    normalizedPhysical,
    hostRootInstanceIdFromAtoms(atoms),
  ];

  const physicalKubernetes = normalizedPhysical?.match(KUBERNETES_PHYSICAL);
  if (physicalKubernetes) aliases.push(`${physicalKubernetes[2]}/${physicalKubernetes[3]}`);

  const attributedKubernetes = lower(attributedInstance)?.match(KUBERNETES_INSTANCE);
  if (attributedKubernetes) aliases.push(`${attributedKubernetes[1]}/${attributedKubernetes[2]}`);

  return distinct(aliases);
}

function hostRootInstanceId(event: IdentityEvent): string | undefined {
  const rootPid = event.attribution?.rootPid;
  if (!rootPid) return undefined;
  const rootStart = text(event.attribution?.rootStartTime)
    ?? (event.process?.pid === rootPid
      ? text(event.process.startTimeNs) ?? text(event.process.startTimeTicks)
      : undefined);
  return hostRootInstanceIdFromAtoms({
    hostId: event.process?.hostId,
    bootId: event.process?.bootId,
    rootPid,
    rootStartTime: rootStart,
  });
}

function processGenerationId(event: IdentityEvent): string | undefined {
  if (!event.process?.pid) return undefined;
  return [
    'host-process',
    event.process.hostId ?? 'host',
    event.process.bootId ?? 'boot',
    event.process.pid,
    event.process.startTimeNs ?? event.process.startTimeTicks ?? 'start-unknown',
  ].join(':');
}

function agentProduct(event: IdentityEvent): string | undefined {
  const adapterRuntime = stringAttribute(event, 'anysentry.adapter.runtime')
    ?? stringAttribute(event, 'agent.product')
    ?? stringAttribute(event, 'agent.runtime.family');
  if (adapterRuntime) return normalizedAgentProduct(adapterRuntime);
  if (event.attribution?.source === 'process_signature') {
    return normalizedAgentProduct(
      event.attribution.agentScopeId
      ?? event.attribution.agentDisplayName
      ?? event.agentId,
    );
  }
  return undefined;
}

function authoritativeAgentScope(event: IdentityEvent): string | undefined {
  const scope = lower(event.attribution?.agentScopeId);
  if (!scope) return undefined;
  const source = event.attribution?.source;
  const evidence = event.attribution?.evidence ?? [];
  const authoritative = [
    'kubernetes',
    'docker_label',
    'manual_review',
    'self_register',
    'platform_registration',
  ].includes(source ?? '') || evidence.some((item) =>
    item.startsWith('label:anysentry.io/agent-id=')
    || item === 'server:authenticated-agent-adapter'
    || item.startsWith('manual_review:'),
  );
  return authoritative ? scope : undefined;
}

function identityPart(value: unknown, fallback = 'unknown'): string {
  return encodeURIComponent(lower(value) ?? fallback);
}

function kubernetesLogicalIdentity(
  event: IdentityEvent,
  kubernetes: KubernetesContainerIdentity,
  logicalScope?: string,
): string | undefined {
  const workload = event.attribution?.workloadRef;
  const namespace = lower(workload?.namespace);
  // A stable Agent label is authoritative only inside a typed cluster/namespace domain. Without
  // both boundaries we retain the physical Runtime key and expose a weak relation for review.
  if (!logicalScope || !kubernetes.clusterId || !namespace) return undefined;
  return [
    'k8s-agent-logical:v1',
    identityPart(kubernetes.clusterId),
    identityPart(namespace),
    identityPart(logicalScope),
  ].join(':');
}

/**
 * Produce a typed, deterministic identity projection without changing any producer field.
 *
 * A Kubernetes full container is deliberately represented by the existing
 * `<podUid>/<fullContainerId>` shape. Both Adapter physical IDs and Observer cgroup facts can
 * derive that shape, so current `agent_f3...` assets remain stable while `agent_7fc...` becomes a
 * compatibility alias instead of creating a third canonical ID.
 */
export function projectAgentSemanticIdentity(event: IdentityEvent): AgentSemanticIdentityProjection {
  const attribution = event.attribution;
  const physical = text(attribution?.physicalWorkloadId);
  const attributedInstance = text(attribution?.agentInstanceId);
  const workload = attribution?.workloadRef;
  const root = hostRootInstanceId(event);
  const product = agentProduct(event);
  const logicalScope = authoritativeAgentScope(event);

  const kubernetes = kubernetesContainerIdentity(event);
  if (kubernetes) {
    const runtimeCanonical = `${kubernetes.podUid}/${kubernetes.containerId}`;
    const legacyLogicalRuntime = logicalScope ? `k8s-agent:${runtimeCanonical}:${logicalScope}` : undefined;
    const logicalIdentity = kubernetesLogicalIdentity(event, kubernetes, logicalScope);
    const canonical = logicalIdentity
      ? logicalIdentity
      : root
        ? `${runtimeCanonical}:${root}`
        : runtimeCanonical;
    const normalizedPhysical = kubernetes.clusterId
      ? `k8s:${kubernetes.clusterId}:${kubernetes.podUid}:${kubernetes.containerId}`
      : physical;
    const workloadAlias = workload?.podUid
      ? `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`
      : undefined;
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: canonical,
      identityAliases: distinct([
        canonical,
        logicalIdentity,
        legacyLogicalRuntime,
        runtimeCanonical,
        physical,
        attributedInstance,
        normalizedPhysical,
        `container:${kubernetes.containerId}`,
        workloadAlias,
        root,
      ]),
      canonicalRuntimeInstanceId: runtimeCanonical,
      runtimeInstanceAliases: distinct([
        runtimeCanonical,
        physical,
        attributedInstance,
        normalizedPhysical,
        workloadAlias,
        root,
      ]),
      normalizedPhysicalWorkloadId: normalizedPhysical,
      agentRootInstanceId: root,
      agentProduct: product,
      bindingQuality: 'exact',
      reasonCode: 'exact_kubernetes_container',
    };
  }

  const docker = dockerContainerIdentity(event);
  if (docker) {
    const dockerParts = docker.physicalWorkloadId.split(':');
    const dockerHost = dockerParts.length >= 3 ? dockerParts.slice(1, -1).join(':') : undefined;
    const logicalIdentity = logicalScope && dockerHost
      ? ['docker-agent-logical:v1', identityPart(dockerHost), identityPart(logicalScope)].join(':')
      : undefined;
    const canonical = logicalIdentity ?? docker.physicalWorkloadId;
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: canonical,
      identityAliases: distinct([
        canonical,
        docker.physicalWorkloadId,
        physical,
        attributedInstance,
        `container:${docker.containerId}`,
        root,
      ]),
      canonicalRuntimeInstanceId: docker.physicalWorkloadId,
      runtimeInstanceAliases: distinct([
        docker.physicalWorkloadId,
        physical,
        attributedInstance,
        root,
      ]),
      normalizedPhysicalWorkloadId: docker.physicalWorkloadId,
      agentRootInstanceId: root,
      agentProduct: product,
      bindingQuality: 'exact',
      reasonCode: 'exact_docker_container',
    };
  }

  if (root) {
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: physical ?? root,
      identityAliases: distinct([physical, attributedInstance, root]),
      canonicalRuntimeInstanceId: root,
      runtimeInstanceAliases: distinct([root, attributedInstance, physical]),
      normalizedPhysicalWorkloadId: physical,
      agentRootInstanceId: root,
      agentProduct: product,
      bindingQuality: 'exact',
      reasonCode: 'exact_host_root',
    };
  }

  if (attributedInstance) {
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: attributedInstance,
      identityAliases: distinct([attributedInstance, physical]),
      canonicalRuntimeInstanceId: attributedInstance,
      runtimeInstanceAliases: distinct([attributedInstance, physical]),
      normalizedPhysicalWorkloadId: physical,
      agentProduct: product,
      bindingQuality: 'weak',
      reasonCode: 'attributed_instance',
    };
  }

  if (physical) {
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: physical,
      identityAliases: [physical],
      canonicalRuntimeInstanceId: physical,
      runtimeInstanceAliases: [physical],
      normalizedPhysicalWorkloadId: physical,
      agentProduct: product,
      bindingQuality: 'weak',
      reasonCode: 'physical_workload',
    };
  }

  if (workload?.podUid) {
    const workloadKey = `k8s:${workload.podUid}:${workload.containerName ?? workload.name ?? 'container'}`;
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: workloadKey,
      identityAliases: [workloadKey],
      canonicalRuntimeInstanceId: workloadKey,
      runtimeInstanceAliases: [workloadKey],
      agentProduct: product,
      bindingQuality: 'weak',
      reasonCode: 'workload_scope',
    };
  }

  const process = processGenerationId(event);
  if (process) {
    return {
      schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
      canonicalIdentityKey: process,
      identityAliases: [process],
      canonicalRuntimeInstanceId: process,
      runtimeInstanceAliases: [process],
      agentProduct: product,
      bindingQuality: event.process?.startTimeNs || event.process?.startTimeTicks ? 'exact' : 'weak',
      reasonCode: 'process_generation',
    };
  }

  const legacy = ['logical', event.workspacePath, attribution?.agentScopeId ?? attribution?.agentDisplayName ?? event.agentId].join(':');
  const runtime = `session:${event.sessionId}:${event.agentId}`;
  return {
    schemaVersion: AGENT_SEMANTIC_IDENTITY_VERSION,
    canonicalIdentityKey: legacy,
    identityAliases: [legacy],
    canonicalRuntimeInstanceId: runtime,
    runtimeInstanceAliases: [runtime],
    agentProduct: product,
    bindingQuality: 'weak',
    reasonCode: 'legacy_session',
  };
}
