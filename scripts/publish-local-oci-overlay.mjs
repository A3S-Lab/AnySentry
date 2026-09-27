#!/usr/bin/env node

/**
 * Publish a small, immutable OCI layer to a loopback registry without invoking Docker BuildKit.
 *
 * This is a local-delivery escape hatch for a busy Docker daemon: a digest-pinned base manifest is
 * copied verbatim and one deterministic layer replaces only explicitly named build artifacts. The
 * registry is deliberately restricted to loopback addresses so an accidental invocation cannot
 * publish to a remote registry. No credentials or source tree outside the supplied paths enter the
 * layer.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const MAX_LAYER_BYTES = 512 * 1024 * 1024;
const MAX_LABEL_LENGTH = 240;
const ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

function usage() {
  return [
    'Usage:',
    '  node scripts/publish-local-oci-overlay.mjs --registry http://127.0.0.1:5000',
    '    --repository anysentry --base-tag goal-current --tag goal-head',
    '    --source apps/api/dist=/app/dist --source apps/web/dist=/app/web',
    '    [--label key=value]...',
    '',
    'Only loopback registries are accepted. Each source replaces/adds files below its absolute',
    'destination in one deterministic layer; the base manifest/config/layers remain unchanged.',
  ].join('\n');
}

function argumentValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function parseArgs(argv) {
  const options = { registry: undefined, repository: undefined, baseTag: undefined, tag: undefined, sources: [], labels: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--registry') options.registry = argumentValue(argv, index++, arg);
    else if (arg === '--repository') options.repository = argumentValue(argv, index++, arg);
    else if (arg === '--base-tag') options.baseTag = argumentValue(argv, index++, arg);
    else if (arg === '--tag') options.tag = argumentValue(argv, index++, arg);
    else if (arg === '--source') options.sources.push(argumentValue(argv, index++, arg));
    else if (arg === '--label') {
      const value = argumentValue(argv, index++, arg);
      const separator = value.indexOf('=');
      if (separator <= 0) throw new Error('--label must be key=value');
      const key = value.slice(0, separator).trim();
      const label = value.slice(separator + 1).trim();
      if (!key || key.length > MAX_LABEL_LENGTH || label.length > MAX_LABEL_LENGTH) {
        throw new Error('--label key/value is too long or empty');
      }
      options.labels[key] = label;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.registry || !options.repository || !options.baseTag || !options.tag || options.sources.length === 0) {
    throw new Error('--registry, --repository, --base-tag, --tag and at least one --source are required');
  }
  const url = new URL(options.registry);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('registry must be an http(s) loopback URL');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  options.registry = url;
  options.repository = options.repository.replace(/^\/+|\/+$/gu, '');
  if (!/^[A-Za-z0-9._/-]+$/u.test(options.repository) || !options.repository) throw new Error('repository is invalid');
  for (const tag of [options.baseTag, options.tag]) {
    if (!/^[A-Za-z0-9._-]+$/u.test(tag)) throw new Error(`tag is invalid: ${tag}`);
  }
  options.sources = options.sources.map((value) => {
    const separator = value.indexOf('=');
    if (separator <= 0) throw new Error(`--source must be path=/absolute/destination: ${value}`);
    const source = path.resolve(value.slice(0, separator));
    const destination = value.slice(separator + 1);
    if (!destination.startsWith('/') || destination.includes('\0') || destination.includes('..')) {
      throw new Error(`source destination must be an absolute path without ..: ${destination}`);
    }
    return { source, destination: path.posix.normalize(destination) };
  });
  return options;
}

async function request(url, init = {}) {
  const response = await fetch(url, init);
  return response;
}

async function fetchJson(url, init = {}) {
  const response = await request(url, init);
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${response.status}`);
  try { return { value: JSON.parse(text), bytes: Buffer.byteLength(text), headers: response.headers }; }
  catch { throw new Error(`registry returned invalid JSON for ${url}`); }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code !== 0) reject(new Error(`${command} failed (${signal ?? code}): ${Buffer.concat(stderr).toString('utf8').slice(-2_000)}`));
      else resolve();
    });
  });
}

async function uploadBlob(base, repository, file, digest) {
  const head = await request(`${base}/v2/${repository}/blobs/${digest}`, { method: 'HEAD' });
  if (head.ok) return;
  const start = await request(`${base}/v2/${repository}/blobs/uploads/`, { method: 'POST' });
  if (!start.ok) throw new Error(`registry blob upload start -> ${start.status}`);
  const location = start.headers.get('location');
  if (!location) throw new Error('registry blob upload did not return Location');
  const target = new URL(location, base);
  target.searchParams.set('digest', digest);
  const bytes = await readFile(file);
  const put = await request(target, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
    body: bytes,
  });
  if (!put.ok) throw new Error(`registry blob upload -> ${put.status}`);
}

async function main(argv) {
  const options = parseArgs(argv);
  const base = options.registry.toString().replace(/\/$/u, '');
  const manifestUrl = `${base}/v2/${options.repository}/manifests/${encodeURIComponent(options.baseTag)}`;
  const manifestResponse = await request(manifestUrl, { headers: { accept: ACCEPT } });
  const manifestText = await manifestResponse.text();
  if (!manifestResponse.ok) throw new Error(`base manifest -> ${manifestResponse.status}`);
  const baseManifest = JSON.parse(manifestText);
  if (!Array.isArray(baseManifest.layers) || !baseManifest.config?.digest) throw new Error('base manifest is not a single OCI/Docker image manifest');
  const configUrl = `${base}/v2/${options.repository}/blobs/${baseManifest.config.digest}`;
  const { value: config } = await fetchJson(configUrl);
  const temporary = await mkdtemp(path.join(tmpdir(), 'anysentry-oci-overlay-'));
  try {
    for (const { source, destination } of options.sources) {
      const metadata = await stat(source).catch(() => undefined);
      if (!metadata) throw new Error(`source does not exist: ${source}`);
      const target = path.join(temporary, destination.replace(/^\//u, ''));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target, { recursive: true, force: true, dereference: false });
    }
    const tarPath = path.join(temporary, 'layer.tar');
    const gzipPath = path.join(temporary, 'layer.tar.gz');
    await run('tar', [
      '--sort=name', '--mtime=UTC 1970-01-01T00:00:00Z', '--owner=0', '--group=0', '--numeric-owner',
      '-C', temporary, '-cf', tarPath, '--exclude=layer.tar', '--exclude=layer.tar.gz', '.',
    ]);
    // Write the compressed layer to a private temporary path; the source tar is retained so its
    // uncompressed digest can be used as the OCI rootfs diff ID.
    await run('sh', ['-c', 'gzip -n -c "$1" > "$2"', 'overlay-gzip', tarPath, gzipPath]);
    const compressedStat = await stat(gzipPath);
    if (compressedStat.size <= 0 || compressedStat.size > MAX_LAYER_BYTES) throw new Error('overlay layer size is outside bounds');
    const [layerDigest, uncompressedDigest] = await Promise.all([
      sha256File(gzipPath),
      new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        const stream = createReadStream(tarPath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.once('error', reject);
        stream.once('end', () => resolve(`sha256:${hash.digest('hex')}`));
      }),
    ]);
    const created = new Date().toISOString();
    const labels = {
      ...(config.config?.Labels ?? {}),
      ...options.labels,
      'io.anysentry.local-overlay.base-manifest': `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
      'io.anysentry.local-overlay.created': created,
    };
    const nextConfig = {
      ...config,
      created,
      config: { ...(config.config ?? {}), Labels: labels },
      rootfs: { ...(config.rootfs ?? { type: 'layers', diff_ids: [] }), diff_ids: [...(config.rootfs?.diff_ids ?? []), uncompressedDigest] },
      history: [...(config.history ?? []), { created, created_by: 'local deterministic OCI artifact overlay' }],
    };
    const configBytes = Buffer.from(JSON.stringify(nextConfig));
    const configDigest = `sha256:${createHash('sha256').update(configBytes).digest('hex')}`;
    const configPath = path.join(temporary, 'config.json');
    await writeFile(configPath, configBytes, { mode: 0o600 });
    await uploadBlob(base, options.repository, gzipPath, layerDigest);
    await uploadBlob(base, options.repository, configPath, configDigest);
    const nextManifest = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: {
        mediaType: 'application/vnd.oci.image.config.v1+json',
        digest: configDigest,
        size: configBytes.length,
      },
      layers: [...baseManifest.layers, {
        mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
        digest: layerDigest,
        size: compressedStat.size,
        annotations: { 'org.opencontainers.image.title': 'anysentry-local-overlay' },
      }],
    };
    const nextManifestBytes = Buffer.from(JSON.stringify(nextManifest));
    const putManifest = await request(`${base}/v2/${options.repository}/manifests/${encodeURIComponent(options.tag)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/vnd.oci.image.manifest.v1+json', 'content-length': String(nextManifestBytes.length) },
      body: nextManifestBytes,
    });
    if (!putManifest.ok) throw new Error(`registry manifest upload -> ${putManifest.status}`);
    const publishedDigest = `sha256:${createHash('sha256').update(nextManifestBytes).digest('hex')}`;
    console.log(JSON.stringify({
      schemaVersion: 'anysentry.local_oci_overlay.v1',
      repository: options.repository,
      baseTag: options.baseTag,
      tag: options.tag,
      baseManifestDigest: `sha256:${createHash('sha256').update(manifestText).digest('hex')}`,
      manifestDigest: publishedDigest,
      configDigest,
      layerDigest,
      layerBytes: compressedStat.size,
      sources: options.sources,
    }));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(`local OCI overlay failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
