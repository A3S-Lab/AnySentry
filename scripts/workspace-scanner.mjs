#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, opendir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiBase = (process.env.ANYSENTRY_API_BASE || 'http://127.0.0.1:29653/security-center').replace(/\/$/, '');
let scannerToken = process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKEN || '';
const scannerTokenFile = process.env.ANYSENTRY_WORKSPACE_SCANNER_TOKEN_FILE;
const configPath = process.env.ANYSENTRY_WORKSPACE_SCANNER_CONFIG;
const scannerBinary = process.env.ANYSENTRY_OSV_SCANNER_BIN || 'osv-scanner';
const dockerBinary = process.env.ANYSENTRY_DOCKER_BIN || 'docker';
const scannerVersion = process.env.ANYSENTRY_OSV_SCANNER_VERSION || '2.3.8';
const pollIntervalMs = Math.max(1_000, Number(process.env.ANYSENTRY_WORKSPACE_SCANNER_POLL_MS || 10_000));
const scanTimeoutMs = Math.max(10_000, Number(process.env.ANYSENTRY_WORKSPACE_SCAN_TIMEOUT_MS || 5 * 60_000));
const maxOutputBytes = Math.max(1_000_000, Number(process.env.ANYSENTRY_WORKSPACE_SCAN_MAX_BYTES || 64 * 1024 * 1024));
const descriptorPollMs = Math.max(5_000, Number(process.env.ANYSENTRY_DEPENDENCY_DESCRIPTOR_POLL_MS || 30_000));
const maxInstalledPackages = Math.max(
  1_000,
  Number(process.env.ANYSENTRY_WORKSPACE_MAX_INSTALLED_PACKAGES || 50_000),
);
let stopping = false;

const DESCRIPTOR_NAMES = new Set([
  'Cargo.lock',
  'bun.lock',
  'bun.lockb',
  'cabal.project.freeze',
  'composer.lock',
  'conan.lock',
  'deps.json',
  'Gemfile.lock',
  'go.mod',
  'gradle.lockfile',
  'mix.lock',
  'package-lock.json',
  'packages.config',
  'packages.lock.json',
  'pdm.lock',
  'Pipfile.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'pom.xml',
  'pubspec.lock',
  'pylock.toml',
  'renv.lock',
  'requirements.txt',
  'stack.yaml.lock',
  'uv.lock',
  'yarn.lock',
]);
const SKIP_DIRECTORIES = new Set([
  '.git',
  '.gradle',
  '.idea',
  '.next',
  '.venv',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function workspacePathFingerprint(value) {
  return digest(value.replaceAll('\\', '/').replace(/\/+$/, '') || '/');
}

async function loadScannerToken() {
  if (scannerToken) return scannerToken;
  if (!scannerTokenFile || !isAbsolute(scannerTokenFile)) {
    throw new Error('ANYSENTRY_WORKSPACE_SCANNER_TOKEN or an absolute ANYSENTRY_WORKSPACE_SCANNER_TOKEN_FILE is required');
  }
  const tokenPath = await realpath(scannerTokenFile);
  const tokenStat = await stat(tokenPath);
  if (!tokenStat.isFile()) throw new Error('Workspace Scanner token path must be a regular file');
  if ((tokenStat.mode & 0o077) !== 0) {
    throw new Error('Workspace Scanner token file must not be readable or writable by group or others');
  }
  if (typeof process.getuid === 'function' && tokenStat.uid !== process.getuid()) {
    throw new Error('Workspace Scanner token file must be owned by the Scanner user');
  }
  if (tokenStat.size > 4_096) throw new Error('Workspace Scanner token file is unexpectedly large');
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (token.length < 32) throw new Error('Workspace Scanner token must contain at least 32 characters');
  return token;
}

function scannerEnvironment() {
  const allowed = [
    'HOME',
    'PATH',
    'TMPDIR',
    'XDG_CACHE_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  return Object.fromEntries(allowed
    .map((key) => [key, process.env[key]])
    .filter((entry) => entry[1]));
}

async function verifyScannerVersion() {
  const child = spawn(scannerBinary, ['--version'], {
    env: scannerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', resolvePromise);
  });
  const output = Buffer.concat([...stdout, ...stderr]).toString('utf8').trim();
  if (exitCode !== 0 || !new RegExp(`(^|\\D)${scannerVersion.replaceAll('.', '\\.')}(\\D|$)`).test(output)) {
    throw new Error(`expected OSV-Scanner ${scannerVersion}, received: ${output || `exit ${exitCode}`}`);
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(scannerToken ? { 'x-anysentry-scanner-token': scannerToken } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`AnySentry ${path} returned HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload?.data ?? payload;
}

function withinRoot(path, root) {
  return path === root || path.startsWith(`${root}${sep}`);
}

async function loadConfig() {
  if (!configPath) throw new Error('ANYSENTRY_WORKSPACE_SCANNER_CONFIG is required');
  const parsed = JSON.parse(await readFile(configPath, 'utf8'));
  if (!parsed.scannerId || !Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) {
    throw new Error('scanner config requires scannerId and at least one workspace');
  }
  const allowedRoots = await Promise.all((parsed.allowedRoots || []).map((root) => realpath(root)));
  if (allowedRoots.length === 0) throw new Error('scanner config requires at least one allowedRoots entry');
  const workspaces = new Map();
  for (const workspace of parsed.workspaces) {
    if (!workspace.workspaceId || !workspace.repositoryId || !workspace.localPath) {
      throw new Error('each workspace requires workspaceId, repositoryId, and localPath');
    }
    if (!isAbsolute(workspace.localPath)) throw new Error('workspace localPath must be absolute');
    const localPath = await realpath(workspace.localPath);
    if (!(await stat(localPath)).isDirectory()) throw new Error(`workspace is not a directory: ${workspace.workspaceId}`);
    if (!allowedRoots.some((root) => withinRoot(localPath, root))) {
      throw new Error(`workspace escapes allowed roots: ${workspace.workspaceId}`);
    }
    const deploymentImages = (workspace.deploymentImages ?? []).map((image) => {
      const reference = String(image?.reference || '').trim();
      if (!reference || reference.length > 1_024 || /\s/u.test(reference)) {
        throw new Error(`workspace ${workspace.workspaceId} has an invalid deployment image reference`);
      }
      const componentManifestPath = String(
        image?.componentManifestPath || '/app/anysentry-production-components.json',
      ).trim();
      if (!isAbsolute(componentManifestPath) || componentManifestPath.split('/').includes('..')) {
        throw new Error(`workspace ${workspace.workspaceId} has an invalid image component manifest path`);
      }
      return {
        reference,
        componentManifestPath,
      };
    });
    workspaces.set(workspace.workspaceId, {
      ...workspace,
      scannerId: String(parsed.scannerId),
      localPath,
      deploymentImages,
      descriptorDigest: undefined,
      requestedDescriptorDigest: undefined,
    });
  }
  return { scannerId: String(parsed.scannerId), allowedRoots, workspaces };
}

async function runDocker(args, options = {}) {
  const child = spawn(dockerBinary, args, {
    env: scannerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let bytes = 0;
  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= (options.maxBytes || 4 * 1024 * 1024)) stdout.push(chunk);
    else child.kill('SIGKILL');
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.reduce((total, value) => total + value.length, 0) < 1_000_000) stderr.push(chunk);
  });
  const exit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  const error = Buffer.concat(stderr).toString('utf8').trim();
  if (exit.signal || exit.code !== 0) {
    throw new Error(`docker ${args[0]} failed: ${error || exit.signal || `exit ${exit.code}`}`);
  }
  return Buffer.concat(stdout).toString('utf8').trim();
}

async function imageIdentity(reference) {
  return await runDocker(['image', 'inspect', '--format={{.Id}}', reference]);
}

async function dependencyDescriptorDigest(workspace) {
  const workspacePath = workspace.localPath;
  const entries = [];
  const visit = async (directory) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !DESCRIPTOR_NAMES.has(entry.name)) continue;
      if (entries.length >= 10_000) throw new Error('dependency descriptor count exceeds 10000');
      const path = resolve(directory, entry.name);
      const actual = await realpath(path);
      if (!withinRoot(actual, workspacePath)) {
        throw new Error('dependency descriptor resolves outside the registered workspace');
      }
      const metadata = await stat(actual);
      if (metadata.size > 20 * 1024 * 1024) {
        throw new Error(`dependency descriptor exceeds 20 MiB: ${relative(workspacePath, path)}`);
      }
      const relativePath = relative(workspacePath, path).replaceAll('\\', '/');
      entries.push(`${relativePath}\u0000${digest(await readFile(actual))}`);
    }
  };
  await visit(workspacePath);
  for (const image of workspace.deploymentImages) {
    entries.push(`deployment-image:${image.reference}\u0000${await imageIdentity(image.reference)}`);
  }
  return digest(entries.sort().join('\n'));
}

function packageScope(pkg) {
  const value = String(pkg?.group || pkg?.scope || '').toLowerCase();
  if (value.includes('dev') || value.includes('test')) return 'development';
  if (value.includes('optional')) return 'optional';
  if (value.includes('build')) return 'build';
  if (value.includes('runtime') || value.includes('prod')) return 'runtime';
  return 'unknown';
}

function normalizeSourcePath(sourcePath, workspacePath) {
  const source = String(sourcePath || workspacePath);
  const absolute = isAbsolute(source) ? resolve(source) : resolve(workspacePath, source);
  if (!withinRoot(absolute, workspacePath)) {
    throw new Error('OSV-Scanner returned a source path outside the registered workspace');
  }
  const relativePath = relative(workspacePath, absolute).replaceAll('\\', '/') || '.';
  return relativePath === '.' ? 'workspace-root' : relativePath;
}

function extractComponents(output, workspacePath) {
  const components = [];
  for (const result of Array.isArray(output?.results) ? output.results : []) {
    const sourcePath = normalizeSourcePath(result?.source?.path || workspacePath, workspacePath);
    for (const entry of Array.isArray(result?.packages) ? result.packages : []) {
      const pkg = entry?.package || entry;
      const name = String(pkg?.name || '').trim();
      const version = String(pkg?.version || '').trim();
      const ecosystem = String(pkg?.ecosystem || '').trim();
      if (!name || !version || !ecosystem) continue;
      components.push({
        relativeSourcePath: sourcePath,
        ecosystem,
        packageName: name,
        version,
        dependencyScope: packageScope(pkg),
        direct: typeof pkg?.direct === 'boolean' ? pkg.direct : null,
        ...(pkg?.purl ? { purl: String(pkg.purl) } : {}),
      });
    }
  }
  return components;
}

function imageSourcePath(reference, value) {
  const imageId = digest(reference).slice(7, 19);
  const source = String(value || 'image-package')
    .replaceAll('\\', '/')
    .replace(/^\/+/u, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
  return `container-images/${imageId}/${source || 'image-package'}`.slice(0, 1_024);
}

function imageEvidence(reference, imageDigest, componentSource) {
  return [{
    reference,
    digest: imageDigest,
    componentSource,
  }];
}

function installedEvidence(kind, relativePath) {
  return [{
    kind,
    relativePath: relativePath.replaceAll('\\', '/'),
  }];
}

async function readPackageJson(packageRoot, workspacePath) {
  const path = resolve(packageRoot, 'package.json');
  try {
    const actual = await realpath(path);
    if (!withinRoot(actual, workspacePath)) return undefined;
    const metadata = await stat(actual);
    if (!metadata.isFile() || metadata.size > 1024 * 1024) return undefined;
    const parsed = JSON.parse(await readFile(actual, 'utf8'));
    const packageName = String(parsed?.name || '').trim();
    const version = String(parsed?.version || '').trim();
    if (!packageName || !version) return undefined;
    const sourcePath = relative(workspacePath, path).replaceAll('\\', '/');
    return {
      relativeSourcePath: sourcePath,
      ecosystem: 'npm',
      packageName,
      version,
      dependencyScope: 'runtime',
      direct: null,
      installedEnvironments: installedEvidence('node_modules', sourcePath),
    };
  } catch {
    return undefined;
  }
}

async function scanNodeModules(nodeModulesPath, workspacePath, components, visited) {
  let actual;
  try {
    actual = await realpath(nodeModulesPath);
  } catch {
    return;
  }
  if (!withinRoot(actual, workspacePath) || visited.has(actual)) return;
  visited.add(actual);
  const handle = await opendir(nodeModulesPath);
  for await (const entry of handle) {
    if (components.length >= maxInstalledPackages) {
      throw new Error(`installed package count exceeds ${maxInstalledPackages}`);
    }
    if (entry.name === '.bin') continue;
    const entryPath = resolve(nodeModulesPath, entry.name);
    if (entry.name === '.pnpm') {
      const stores = await opendir(entryPath).catch(() => undefined);
      if (!stores) continue;
      for await (const store of stores) {
        if (!store.isDirectory()) continue;
        await scanNodeModules(resolve(entryPath, store.name, 'node_modules'), workspacePath, components, visited);
      }
      continue;
    }
    if (entry.name.startsWith('@')) {
      const scope = await opendir(entryPath).catch(() => undefined);
      if (!scope) continue;
      for await (const packageEntry of scope) {
        const packageRoot = resolve(entryPath, packageEntry.name);
        const component = await readPackageJson(packageRoot, workspacePath);
        if (component) components.push(component);
        await scanNodeModules(resolve(packageRoot, 'node_modules'), workspacePath, components, visited);
      }
      continue;
    }
    const component = await readPackageJson(entryPath, workspacePath);
    if (component) components.push(component);
    await scanNodeModules(resolve(entryPath, 'node_modules'), workspacePath, components, visited);
  }
}

function pythonMetadataValue(content, name) {
  const prefix = `${name}:`;
  const line = content.split(/\r?\n/u).find((value) => value.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

async function scanPythonEnvironment(environmentPath, workspacePath, components, visited) {
  let actual;
  try {
    actual = await realpath(environmentPath);
  } catch {
    return;
  }
  if (!withinRoot(actual, workspacePath) || visited.has(actual)) return;
  visited.add(actual);
  const visit = async (directory, depth) => {
    if (depth > 8) return;
    const handle = await opendir(directory).catch(() => undefined);
    if (!handle) return;
    for await (const entry of handle) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'METADATA' || !directory.endsWith('.dist-info')) continue;
      if (components.length >= maxInstalledPackages) {
        throw new Error(`installed package count exceeds ${maxInstalledPackages}`);
      }
      const metadata = await stat(path);
      if (metadata.size > 1024 * 1024) continue;
      const content = await readFile(path, 'utf8');
      const packageName = pythonMetadataValue(content, 'Name');
      const version = pythonMetadataValue(content, 'Version');
      if (!packageName || !version) continue;
      const sourcePath = relative(workspacePath, path).replaceAll('\\', '/');
      components.push({
        relativeSourcePath: sourcePath,
        ecosystem: 'PyPI',
        packageName,
        version,
        dependencyScope: 'runtime',
        direct: null,
        installedEnvironments: installedEvidence('python_environment', sourcePath),
      });
    }
  };
  await visit(environmentPath, 0);
}

export async function scanInstalledEnvironments(workspacePath) {
  const components = [];
  const visitedNodeModules = new Set();
  const visitedPython = new Set();
  const visit = async (directory) => {
    const handle = await opendir(directory);
    for await (const entry of handle) {
      if (!entry.isDirectory()) continue;
      const path = resolve(directory, entry.name);
      if (entry.name === 'node_modules') {
        await scanNodeModules(path, workspacePath, components, visitedNodeModules);
        continue;
      }
      if (entry.name === '.venv' || entry.name === 'venv' || entry.name.endsWith('.venv')) {
        await scanPythonEnvironment(path, workspacePath, components, visitedPython);
        continue;
      }
      if (entry.name === 'site-packages') {
        await scanPythonEnvironment(path, workspacePath, components, visitedPython);
        continue;
      }
      if (!SKIP_DIRECTORIES.has(entry.name)) await visit(path);
    }
  };
  await visit(workspacePath);
  return components;
}

function extractImageComponents(output, reference, imageDigest) {
  const components = [];
  for (const result of Array.isArray(output?.results) ? output.results : []) {
    const sourcePath = imageSourcePath(reference, result?.source?.path);
    for (const entry of Array.isArray(result?.packages) ? result.packages : []) {
      const pkg = entry?.package || entry;
      const name = String(pkg?.name || '').trim();
      const version = String(pkg?.version || '').trim();
      const ecosystem = String(pkg?.ecosystem || '').trim();
      if (!name || !version || !ecosystem) continue;
      components.push({
        relativeSourcePath: sourcePath,
        ecosystem,
        packageName: name,
        version,
        dependencyScope: 'runtime',
        direct: typeof pkg?.direct === 'boolean' ? pkg.direct : null,
        ...(pkg?.purl ? { purl: String(pkg.purl) } : {}),
        deploymentImages: imageEvidence(reference, imageDigest, 'osv_image'),
      });
    }
  }
  return components;
}

async function runOsv(args, cwd) {
  const child = spawn(scannerBinary, args, {
    cwd,
    env: scannerEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let outputBytes = 0;
  let killedForSize = false;
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes) {
      killedForSize = true;
      child.kill('SIGKILL');
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => {
    if (stderr.reduce((total, value) => total + value.length, 0) < 1_000_000) stderr.push(chunk);
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), scanTimeoutMs);
  const exit = await new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (killedForSize) throw new Error(`OSV-Scanner output exceeded ${maxOutputBytes} bytes`);
  if (exit.signal) throw new Error(`OSV-Scanner terminated by ${exit.signal}`);
  if (exit.code === 127) throw new Error('OSV-Scanner reported a general error');
  if (exit.code !== 0 && exit.code !== 1 && exit.code !== 128) {
    throw new Error(`OSV-Scanner exited ${exit.code}: ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`);
  }
  return {
    output: exit.code === 128 ? { results: [] } : JSON.parse(Buffer.concat(stdout).toString('utf8')),
    warnings: [
      ...(exit.code === 128 ? ['OSV-Scanner found no supported packages'] : []),
      ...Buffer.concat(stderr).toString('utf8').split('\n').filter(Boolean).slice(0, 100),
    ],
  };
}

export function extractionStatusFromWarnings(warnings) {
  return warnings.some((warning) => (
    /(?:error during extraction|failed resolution)/iu.test(warning)
  )) ? 'partial' : 'complete';
}

async function runScanner(workspacePath) {
  const args = [
    'scan',
    'source',
    '--recursive',
    '--all-packages',
    '--format=json',
    workspacePath,
  ];
  const result = await runOsv(args, workspacePath);
  return {
    components: extractComponents(result.output, workspacePath),
    warnings: result.warnings,
    extractionStatus: extractionStatusFromWarnings(result.warnings),
  };
}

async function readProductionManifest(image, imageDigest) {
  const directory = await mkdtemp(join(tmpdir(), 'anysentry-image-manifest-'));
  let containerId = '';
  try {
    containerId = await runDocker(['create', '--entrypoint', '/bin/true', image.reference]);
    const destination = join(directory, 'components.json');
    await runDocker(['cp', `${containerId}:${image.componentManifestPath}`, destination]);
    const entries = JSON.parse(await readFile(destination, 'utf8'));
    if (!Array.isArray(entries)) throw new Error('production component manifest must be an array');
    return entries.map((entry) => ({
      relativeSourcePath: imageSourcePath(image.reference, entry.relativeSourcePath || 'app/node_modules'),
      ecosystem: String(entry.ecosystem || 'npm'),
      packageName: String(entry.packageName || ''),
      version: String(entry.version || ''),
      dependencyScope: 'runtime',
      direct: typeof entry.direct === 'boolean' ? entry.direct : null,
      ...(entry.purl ? { purl: String(entry.purl) } : {}),
      deploymentImages: imageEvidence(image.reference, imageDigest, 'production_manifest'),
    })).filter((entry) => entry.packageName && entry.version && entry.ecosystem);
  } finally {
    if (containerId) await runDocker(['rm', '-f', containerId]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

async function runImageScan(image, workspacePath) {
  const imageDigest = await imageIdentity(image.reference);
  const result = await runOsv([
    'scan',
    'image',
    '--all-packages',
    '--format=json',
    image.reference,
  ], workspacePath);
  let manifestComponents = [];
  const warnings = [...result.warnings];
  try {
    manifestComponents = await readProductionManifest(image, imageDigest);
  } catch (error) {
    warnings.push(
      `production component manifest unavailable for ${image.reference}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return {
    components: [
      ...extractImageComponents(result.output, image.reference, imageDigest),
      ...manifestComponents,
    ],
    warnings,
  };
}

function mergeDeploymentComponents(sourceComponents, imageComponents) {
  const result = sourceComponents.map((component) => ({ ...component }));
  const sourceMatches = new Map();
  for (const component of result) {
    const key = `${component.ecosystem.toLowerCase()}\u0000${component.packageName}\u0000${component.version}`;
    const matches = sourceMatches.get(key) ?? [];
    matches.push(component);
    sourceMatches.set(key, matches);
  }
  for (const component of imageComponents) {
    const key = `${component.ecosystem.toLowerCase()}\u0000${component.packageName}\u0000${component.version}`;
    const matches = sourceMatches.get(key);
    if (!matches?.length) {
      result.push(component);
      continue;
    }
    for (const match of matches) {
      match.deploymentImages = [...new Map([
        ...(match.deploymentImages ?? []),
        ...(component.deploymentImages ?? []),
      ].map((image) => [
        `${image.reference}\u0000${image.digest}\u0000${image.componentSource}`,
        image,
      ])).values()];
    }
  }
  return result;
}

function mergeInstalledComponents(sourceComponents, installedComponents) {
  const result = sourceComponents.map((component) => ({ ...component }));
  const sourceMatches = new Map();
  for (const component of result) {
    const key = `${component.ecosystem.toLowerCase()}\u0000${component.packageName.toLowerCase()}\u0000${component.version}`;
    const matches = sourceMatches.get(key) ?? [];
    matches.push(component);
    sourceMatches.set(key, matches);
  }
  for (const component of installedComponents) {
    const key = `${component.ecosystem.toLowerCase()}\u0000${component.packageName.toLowerCase()}\u0000${component.version}`;
    const matches = sourceMatches.get(key);
    if (!matches?.length) {
      result.push(component);
      continue;
    }
    for (const match of matches) {
      match.installedEnvironments = [...new Map([
        ...(match.installedEnvironments ?? []),
        ...(component.installedEnvironments ?? []),
      ].map((environment) => [
        `${environment.kind}\u0000${environment.relativePath}`,
        environment,
      ])).values()];
    }
  }
  return result;
}

async function runWorkspaceScan(workspace) {
  const source = await runScanner(workspace.localPath);
  const warnings = [...source.warnings];
  let extractionStatus = source.extractionStatus;
  let installedComponents = [];
  try {
    installedComponents = await scanInstalledEnvironments(workspace.localPath);
  } catch (error) {
    extractionStatus = 'partial';
    warnings.push(
      `installed environment inventory incomplete: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const imageResults = [];
  for (const image of workspace.deploymentImages) {
    imageResults.push(await runImageScan(image, workspace.localPath));
  }
  return {
    components: mergeDeploymentComponents(
      mergeInstalledComponents(source.components, installedComponents),
      imageResults.flatMap((result) => result.components),
    ),
    warnings: [...warnings, ...imageResults.flatMap((result) => result.warnings)],
    extractionStatus,
  };
}

async function register(config) {
  for (const workspace of config.workspaces.values()) {
    const currentDescriptorDigest = await dependencyDescriptorDigest(workspace);
    const registration = await api('/supply-chain/workspaces/register', {
      method: 'POST',
      body: JSON.stringify({
        repositoryId: workspace.repositoryId,
        workspaceId: workspace.workspaceId,
        scannerId: config.scannerId,
        workspacePathFingerprint: workspacePathFingerprint(workspace.localPath),
        displayName: workspace.displayName || workspace.repositoryId,
        sourceId: workspace.sourceId,
        environmentId: workspace.environmentId,
      }),
    });
    workspace.descriptorDigest = currentDescriptorDigest;
    workspace.requestedDescriptorDigest = registration?.activeDescriptorDigest;
    if (registration?.activeDependencySnapshotId
      && registration.activeDescriptorDigest !== currentDescriptorDigest) {
      await requestChangedScan(workspace, currentDescriptorDigest);
    }
  }
}

async function requestChangedScan(workspace, currentDescriptorDigest) {
  if (workspace.requestedDescriptorDigest === currentDescriptorDigest) return;
  await api(`/supply-chain/workspaces/${encodeURIComponent(workspace.workspaceId)}/dependency-change`, {
    method: 'POST',
    body: JSON.stringify({ scannerId: workspace.scannerId }),
  });
  workspace.requestedDescriptorDigest = currentDescriptorDigest;
  console.log('[workspace-scanner] dependency descriptor change queued', {
    workspaceId: workspace.workspaceId,
  });
}

async function detectDescriptorChanges(config) {
  for (const workspace of config.workspaces.values()) {
    const current = await dependencyDescriptorDigest(workspace);
    if (workspace.descriptorDigest === current) continue;
    workspace.descriptorDigest = current;
    await requestChangedScan(workspace, current);
  }
}

async function handleTask(config, task) {
  const workspace = config.workspaces.get(task.workspaceId);
  if (!workspace) throw new Error(`claimed task references an unconfigured workspace: ${task.workspaceId}`);
  const heartbeat = setInterval(() => {
    void api(`/supply-chain/tasks/${encodeURIComponent(task.taskId)}/heartbeat`, {
      method: 'PUT',
      body: JSON.stringify({ scannerId: config.scannerId, leaseToken: task.leaseToken }),
    }).catch((error) => console.error('[workspace-scanner] heartbeat failed', error.message));
  }, 30_000);
  try {
    const descriptorDigest = await dependencyDescriptorDigest(workspace);
    const result = await runWorkspaceScan(workspace);
    await api(`/supply-chain/tasks/${encodeURIComponent(task.taskId)}/result`, {
      method: 'POST',
      body: JSON.stringify({
        scannerId: config.scannerId,
        leaseToken: task.leaseToken,
        extractionStatus: result.extractionStatus,
        extractionPolicyVersion: 'osv-source-image-installed-v3',
        scannerName: 'osv-scanner',
        scannerVersion,
        descriptorDigest,
        observedChangeAt: task.createdAt,
        components: result.components,
        warnings: result.warnings,
      }),
    });
    console.log('[workspace-scanner] scan completed', {
      taskId: task.taskId,
      workspaceId: task.workspaceId,
      components: result.components.length,
      extractionStatus: result.extractionStatus,
    });
    workspace.descriptorDigest = descriptorDigest;
    workspace.requestedDescriptorDigest = descriptorDigest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api(`/supply-chain/tasks/${encodeURIComponent(task.taskId)}/result`, {
      method: 'POST',
      body: JSON.stringify({
        scannerId: config.scannerId,
        leaseToken: task.leaseToken,
        extractionStatus: 'failed',
        extractionPolicyVersion: 'osv-source-image-installed-v3',
        scannerName: 'osv-scanner',
        scannerVersion,
        components: [],
        error: message,
      }),
    }).catch((submitError) => console.error('[workspace-scanner] failure report failed', submitError.message));
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Workspace Scanner must run as an unprivileged user');
  }
  scannerToken = await loadScannerToken();
  const config = await loadConfig();
  await verifyScannerVersion();
  await register(config);
  console.log('[workspace-scanner] started', {
    scannerId: config.scannerId,
    workspaces: config.workspaces.size,
  });
  let lastDescriptorPoll = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastDescriptorPoll >= descriptorPollMs) {
        await detectDescriptorChanges(config);
        lastDescriptorPoll = Date.now();
      }
      const response = await api('/supply-chain/tasks/claim', {
        method: 'POST',
        body: JSON.stringify({ scannerId: config.scannerId }),
      });
      if (response?.task) await handleTask(config, response.task);
      else await sleep(pollIntervalMs);
    } catch (error) {
      console.error('[workspace-scanner] poll failed', error instanceof Error ? error.message : String(error));
      await sleep(pollIntervalMs);
    }
  }
}

process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  void main().catch((error) => {
    console.error('[workspace-scanner] fatal', error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
