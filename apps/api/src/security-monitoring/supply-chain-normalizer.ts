import { createHash } from 'node:crypto';
import {
  DependencyComponent,
  DependencyScope,
  DeploymentImageEvidence,
  InstalledEnvironmentEvidence,
  OsvVulnerabilitySummary,
} from './supply-chain.types';

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function workspacePathFingerprint(value: string): string {
  const normalized = value.trim().replaceAll('\\', '/').replace(/\/+$/, '') || '/';
  if (!normalized.startsWith('/')) throw new Error('workspace path must be absolute');
  return sha256(normalized);
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? '').trim().slice(0, maxLength);
}

function relativeSourcePath(value: unknown): string {
  const path = cleanText(value, 1_024).replaceAll('\\', '/').replace(/^\.\/+/, '');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('component relativeSourcePath must be a safe relative path');
  }
  return path;
}

function dependencyScope(value: unknown): DependencyScope {
  const normalized = cleanText(value, 32).toLowerCase();
  if (normalized === 'runtime' || normalized === 'development' || normalized === 'optional' || normalized === 'build') {
    return normalized;
  }
  return 'unknown';
}

export function normalizeComponent(input: Partial<DependencyComponent>): DependencyComponent {
  const ecosystem = cleanText(input.ecosystem, 128);
  const packageName = cleanText(input.packageName, 512);
  const version = cleanText(input.version, 256);
  if (!ecosystem || !packageName || !version) {
    throw new Error('component ecosystem, packageName, and version are required');
  }
  return {
    relativeSourcePath: relativeSourcePath(input.relativeSourcePath),
    ecosystem,
    packageName,
    version,
    dependencyScope: dependencyScope(input.dependencyScope),
    direct: typeof input.direct === 'boolean' ? input.direct : null,
    ...(cleanText(input.purl, 1_024) ? { purl: cleanText(input.purl, 1_024) } : {}),
    ...(Array.isArray(input.deploymentImages) && input.deploymentImages.length > 0 ? {
      deploymentImages: [...new Map(input.deploymentImages.map((image) => {
        const reference = cleanText(image?.reference, 1_024);
        const digest = cleanText(image?.digest, 512);
        const componentSource: DeploymentImageEvidence['componentSource'] = image?.componentSource === 'production_manifest'
          ? 'production_manifest'
          : 'osv_image';
        if (!reference || !digest) throw new Error('deployment image reference and digest are required');
        return [`${reference}\u0000${digest}\u0000${componentSource}`, {
          reference,
          digest,
          componentSource,
        }];
      })).values()],
    } : {}),
    ...(Array.isArray(input.installedEnvironments) && input.installedEnvironments.length > 0 ? {
      installedEnvironments: [...new Map(input.installedEnvironments.map((environment) => {
        const kind: InstalledEnvironmentEvidence['kind'] = environment?.kind === 'python_environment'
          ? 'python_environment'
          : 'node_modules';
        const path = relativeSourcePath(environment?.relativePath);
        return [`${kind}\u0000${path}`, { kind, relativePath: path }];
      })).values()],
    } : {}),
  };
}

export function normalizeComponents(inputs: Array<Partial<DependencyComponent>>): DependencyComponent[] {
  const unique = new Map<string, DependencyComponent>();
  for (const input of inputs) {
    const component = normalizeComponent(input);
    const key = [
      component.relativeSourcePath,
      component.ecosystem.toLowerCase(),
      component.packageName,
      component.version,
      component.dependencyScope,
      component.direct === null ? 'unknown' : String(component.direct),
      JSON.stringify(component.deploymentImages ?? []),
      JSON.stringify(component.installedEnvironments ?? []),
    ].join('\u0000');
    unique.set(key, component);
  }
  return [...unique.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function componentSetDigest(components: DependencyComponent[]): string {
  return sha256(normalizeComponents(components).map((component) => [
    component.relativeSourcePath,
    component.ecosystem,
    component.packageName,
    component.version,
    component.dependencyScope,
    component.direct === null ? 'unknown' : String(component.direct),
    JSON.stringify(component.deploymentImages ?? []),
    JSON.stringify(component.installedEnvironments ?? []),
  ].join('\u0000')).join('\n'));
}

export function dependencySnapshotId(
  workspaceId: string,
  componentsDigest: string,
  extractionPolicyVersion: string,
): string {
  return `deps_${sha256([workspaceId, componentsDigest, extractionPolicyVersion].join('\u0000')).slice(7, 31)}`;
}

export function vulnerabilityAssessmentId(
  dependencySnapshot: string,
  assessedAt: number,
  nonce: string,
): string {
  return `va_${sha256([dependencySnapshot, String(assessedAt), nonce].join('\u0000')).slice(7, 31)}`;
}

export function findingId(
  workspaceId: string,
  component: DependencyComponent,
  vulnerabilityId: string,
): string {
  return `scf_${sha256([
    workspaceId,
    component.ecosystem,
    component.packageName,
    component.version,
    vulnerabilityId,
  ].join('\u0000')).slice(7, 31)}`;
}

export function findingSetDigest(findings: Array<{ findingId: string }>): string {
  return sha256(findings.map((finding) => finding.findingId).sort().join('\n'));
}

export function intelligenceRevision(vulnerabilities: OsvVulnerabilitySummary[]): string {
  return sha256(vulnerabilities
    .map((vulnerability) => `${vulnerability.id}\u0000${vulnerability.modified}`)
    .sort()
    .join('\n'));
}

export function queryCoverageDigest(
  planned: DependencyComponent[],
  successful: DependencyComponent[],
  failed: DependencyComponent[],
): string {
  const componentKey = (component: DependencyComponent) => [
    component.ecosystem,
    component.packageName,
    component.version,
  ].join('\u0000');
  return sha256(JSON.stringify({
    planned: planned.map(componentKey).sort(),
    successful: successful.map(componentKey).sort(),
    failed: failed.map(componentKey).sort(),
  }));
}

export function failedComponentDigest(components: DependencyComponent[]): string {
  return sha256(components.map((component) => [
    component.ecosystem,
    component.packageName,
    component.version,
  ].join('\u0000')).sort().join('\n'));
}
