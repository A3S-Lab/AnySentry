import {
  DependencyComponent,
  OsvVulnerabilitySummary,
  VulnerabilityFinding,
  VulnerabilityPriorityFactor,
  VulnerabilityRemediation,
} from './supply-chain.types';

function candidateFixedVersion(vulnerability: OsvVulnerabilitySummary): string | undefined {
  return [...new Set(vulnerability.fixedVersions ?? [])]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))[0];
}

function remediation(
  component: DependencyComponent,
  vulnerability: OsvVulnerabilitySummary,
): VulnerabilityRemediation {
  const candidate = candidateFixedVersion(vulnerability);
  const imageDeployed = Boolean(component.deploymentImages?.length);
  if (candidate && imageDeployed) {
    return {
      action: 'update_deployed_artifact',
      summary: `Upgrade the affected component to a compatible fixed release (candidate ${candidate}), rebuild the image, and rescan the resulting digest.`,
      candidateFixedVersion: candidate,
      requiresArtifactRebuild: true,
    };
  }
  if (candidate && component.direct === true) {
    return {
      action: 'upgrade_direct_dependency',
      summary: `Upgrade the direct dependency to a compatible fixed release (candidate ${candidate}) and refresh the dependency snapshot.`,
      candidateFixedVersion: candidate,
      requiresArtifactRebuild: false,
    };
  }
  if (candidate && component.direct === false) {
    return {
      action: 'upgrade_parent_dependency',
      summary: `Upgrade or override the parent dependency that introduces this transitive component; OSV reports ${candidate} as a fixed-release candidate.`,
      candidateFixedVersion: candidate,
      requiresArtifactRebuild: false,
    };
  }
  if (candidate) {
    return {
      action: 'upgrade_component',
      summary: `Move this component to a compatible fixed release (candidate ${candidate}) and confirm the result with a complete rescan.`,
      candidateFixedVersion: candidate,
      requiresArtifactRebuild: false,
    };
  }
  if (imageDeployed) {
    return {
      action: 'update_deployed_artifact',
      summary: 'No fixed release is present in the current OSV record. Update the base image or vendor package when a patched build is available, rebuild, and rescan the image digest.',
      requiresArtifactRebuild: true,
    };
  }
  return {
    action: 'monitor_advisory',
    summary: 'No fixed release is present in the current OSV record. Track the advisory, reduce exposure, and reassess when updated intelligence is published.',
    requiresArtifactRebuild: false,
  };
}

export function staticFindingPriority(
  component: DependencyComponent,
  vulnerability: OsvVulnerabilitySummary,
): Pick<
  VulnerabilityFinding,
  'priority' | 'priorityScore' | 'priorityFactors' | 'deploymentStatus' | 'remediation'
> {
  const deploymentStatus = component.deploymentImages?.length || component.installedEnvironments?.length
    ? 'confirmed'
    : 'unknown';
  const severityScore = {
    critical: 80,
    high: 60,
    medium: 40,
    low: 20,
    unknown: 10,
  }[vulnerability.severityLevel ?? 'unknown'];
  const factors: VulnerabilityPriorityFactor[] = [{
    code: 'severity',
    score: severityScore,
    reason: `${vulnerability.severityLevel ?? 'unknown'} vulnerability severity`,
  }];
  if (deploymentStatus === 'confirmed') {
    factors.push({
      code: 'deployed',
      score: 15,
      reason: component.deploymentImages?.length
        ? 'component confirmed in a deployed image'
        : 'component confirmed in an installed workspace environment',
    });
  }
  if (component.direct === true) {
    factors.push({
      code: 'direct_dependency',
      score: 5,
      reason: 'direct dependency',
    });
  }
  if (component.dependencyScope === 'runtime') {
    factors.push({
      code: 'runtime_scope',
      score: 5,
      reason: 'runtime dependency scope',
    });
  }
  const score = Math.min(100, factors.reduce((total, factor) => total + factor.score, 0));
  return {
    priorityScore: score,
    priority: score >= 90 ? 'P0' : score >= 60 ? 'P1' : score >= 35 ? 'P2' : 'P3',
    priorityFactors: factors,
    deploymentStatus,
    remediation: remediation(component, vulnerability),
  };
}
