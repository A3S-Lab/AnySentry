#!/usr/bin/env node

/**
 * Read-only Kubernetes provenance gate for a locally deployed service.
 *
 * The image digest and the PodTemplate annotation are the rollout-authoritative pair. The
 * Deployment metadata copy is checked as well so imperative metadata/image updates cannot leave
 * an apparently healthy Pod pointing at a different source revision. No credentials are read or
 * emitted and no Kubernetes mutation is performed.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const args = process.argv.slice(2);
const valueFor = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const namespace = valueFor('--namespace', process.env.ANYSENTRY_NAMESPACE || 'anysentry');
const deploymentName = valueFor('--deployment', process.env.ANYSENTRY_DEPLOYMENT || 'anysentry');
const expectedDigest = valueFor('--expected-digest', process.env.ANYSENTRY_EXPECTED_IMAGE_DIGEST || '');
const expectedSource = valueFor('--expected-source', process.env.ANYSENTRY_EXPECTED_SOURCE_REVISION || '');

function kubectl(...commandArgs) {
  return JSON.parse(execFileSync('kubectl', commandArgs, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

const deployment = kubectl('-n', namespace, 'get', 'deployment', deploymentName, '-o', 'json');
const container = (deployment.spec?.template?.spec?.containers || [])
  .find((entry) => entry.name === deploymentName)
  || deployment.spec?.template?.spec?.containers?.[0];
const image = String(container?.image || '');
const digest = image.match(/@(?<digest>sha256:[0-9a-f]{64})$/u)?.groups?.digest || '';
const metadata = deployment.metadata?.annotations || {};
const template = deployment.spec?.template?.metadata?.annotations || {};
const selector = Object.entries(deployment.spec?.selector?.matchLabels || {})
  .map(([key, value]) => `${key}=${value}`).join(',');
const replicaSets = kubectl(
  '-n', namespace, 'get', 'replicasets', ...(selector ? ['-l', selector] : []), '-o', 'json',
).items || [];
const active = replicaSets
  .filter((set) => (set.status?.readyReplicas || 0) > 0)
  .sort((a, b) => String(b.metadata?.creationTimestamp || '').localeCompare(String(a.metadata?.creationTimestamp || '')))[0];
const activeTemplate = active?.spec?.template?.metadata?.annotations || {};
const activeContainer = active?.spec?.template?.spec?.containers?.find((entry) => entry.name === deploymentName)
  || active?.spec?.template?.spec?.containers?.[0];
const activeImage = String(activeContainer?.image || '');
const activeDigest = activeImage.match(/@(?<digest>sha256:[0-9a-f]{64})$/u)?.groups?.digest || '';

const report = {
  namespace,
  deployment: deploymentName,
  image,
  digest,
  metadata: {
    overlay: metadata['anysentry.io/local-overlay-manifest'] || '',
    source: metadata['anysentry.io/local-source-revision'] || '',
  },
  template: {
    overlay: template['anysentry.io/local-overlay-manifest'] || '',
    source: template['anysentry.io/local-source-revision'] || '',
  },
  activeReplicaSet: active ? {
    name: active.metadata?.name || '',
    readyReplicas: active.status?.readyReplicas || 0,
    image: activeImage,
    digest: activeDigest,
    overlay: activeTemplate['anysentry.io/local-overlay-manifest'] || '',
    source: activeTemplate['anysentry.io/local-source-revision'] || '',
  } : null,
};

const checks = [
  ['image_has_digest', Boolean(digest)],
  ['metadata_digest_matches_image', report.metadata.overlay === digest],
  ['template_digest_matches_image', report.template.overlay === digest],
  ['metadata_source_matches_template', report.metadata.source === report.template.source],
  ['active_replicaset_present', Boolean(report.activeReplicaSet)],
  ['active_replicaset_digest_matches_image', report.activeReplicaSet?.digest === digest],
  ['active_replicaset_overlay_matches_image', report.activeReplicaSet?.overlay === digest],
  ['active_replicaset_source_matches_template', report.activeReplicaSet?.source === report.template.source],
  ...(expectedDigest ? [['expected_digest_matches', digest === expectedDigest]] : []),
  ...(expectedSource ? [['expected_source_matches', report.template.source === expectedSource]] : []),
];
report.checks = Object.fromEntries(checks);
report.status = checks.every(([, passed]) => passed) ? 'pass' : 'fail';
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'pass') process.exitCode = 1;
