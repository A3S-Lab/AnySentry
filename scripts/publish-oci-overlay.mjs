#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const registry = required('OCI_REGISTRY').replace(/\/+$/u, '');
const repository = required('OCI_REPOSITORY');
const baseDigest = required('OCI_BASE_DIGEST');
const tag = required('OCI_TAG');
const layerPath = required('OCI_LAYER_GZIP');
const diffId = required('OCI_LAYER_DIFF_ID');
const revision = process.env.OCI_REVISION?.trim();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
if (!digestPattern.test(baseDigest) || !digestPattern.test(diffId)) {
  throw new Error('OCI_BASE_DIGEST and OCI_LAYER_DIFF_ID must be SHA-256 digests');
}
if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u.test(tag)) throw new Error('OCI_TAG is invalid');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const endpoint = (suffix) => `${registry}/v2/${repository}/${suffix}`;
const manifestAccept = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const checked = async (response, operation) => {
  if (response.ok) return response;
  const body = await response.text().catch(() => '');
  throw new Error(`${operation} failed: ${response.status} ${body.slice(0, 500)}`);
};
const json = async (url, operation, headers = {}) => {
  const response = await checked(await fetch(url, { headers }), operation);
  return response.json();
};
const uploadBlob = async (bytes, digest) => {
  const present = await fetch(endpoint(`blobs/${digest}`), { method: 'HEAD' });
  if (present.ok) return;
  if (present.status !== 404) await checked(present, `check blob ${digest}`);
  const start = await checked(
    await fetch(endpoint('blobs/uploads/'), { method: 'POST' }),
    `start blob upload ${digest}`,
  );
  const location = start.headers.get('location');
  if (!location) throw new Error('registry did not return a blob upload location');
  const target = new URL(location, `${registry}/`);
  target.searchParams.set('digest', digest);
  await checked(await fetch(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  }), `upload blob ${digest}`);
};

const baseManifest = await json(
  endpoint(`manifests/${baseDigest}`),
  'read base manifest',
  { accept: manifestAccept },
);
if (!baseManifest.config || !Array.isArray(baseManifest.layers)) {
  throw new Error('base reference is not a single-platform OCI/Docker image manifest');
}
const configResponse = await checked(
  await fetch(endpoint(`blobs/${baseManifest.config.digest}`)),
  'read base config',
);
const config = await configResponse.json();
if (!Array.isArray(config.rootfs?.diff_ids)) throw new Error('base config has no rootfs.diff_ids');
if (config.rootfs.diff_ids.length !== baseManifest.layers.length) {
  throw new Error('base config diff IDs do not match manifest layers');
}

const layer = await readFile(layerPath);
const layerDigest = sha256(layer);
await uploadBlob(layer, layerDigest);

const created = new Date().toISOString();
config.rootfs.diff_ids.push(diffId);
config.history ??= [];
config.history.push({
  created,
  created_by: `AnySentry runtime artifact overlay ${revision ?? tag}`,
  comment: 'Compiled API and Web assets; production dependencies inherited from digest-pinned base',
});
config.config ??= {};
config.config.Labels ??= {};
if (revision) config.config.Labels['org.opencontainers.image.revision'] = revision;
config.config.Labels['io.anysentry.runtime-overlay.base'] = baseDigest;
const configBytes = Buffer.from(JSON.stringify(config));
const configDigest = sha256(configBytes);
await uploadBlob(configBytes, configDigest);

const mediaType = baseManifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json';
const manifest = {
  ...baseManifest,
  mediaType,
  config: {
    ...baseManifest.config,
    digest: configDigest,
    size: configBytes.length,
  },
  layers: [
    ...baseManifest.layers,
    {
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: layerDigest,
      size: layer.length,
      annotations: { 'org.opencontainers.image.title': `anysentry-runtime-overlay-${revision ?? tag}.tar.gz` },
    },
  ],
  ...(revision
    ? { annotations: { ...(baseManifest.annotations ?? {}), 'org.opencontainers.image.revision': revision } }
    : {}),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest));
const expectedDigest = sha256(manifestBytes);
const publish = await checked(await fetch(endpoint(`manifests/${tag}`), {
  method: 'PUT',
  headers: { 'content-type': mediaType },
  body: manifestBytes,
}), `publish manifest ${tag}`);
const publishedDigest = publish.headers.get('docker-content-digest') ?? expectedDigest;
if (publishedDigest !== expectedDigest) {
  throw new Error(`registry digest mismatch: expected ${expectedDigest}, received ${publishedDigest}`);
}

console.log(JSON.stringify({
  repository,
  tag,
  digest: publishedDigest,
  baseDigest,
  layerDigest,
  diffId,
  layerBytes: layer.length,
  layerCount: manifest.layers.length,
}, null, 2));
