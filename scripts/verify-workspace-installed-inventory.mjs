#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractionStatusFromWarnings,
  osvScannerGeneralError,
  scanInstalledEnvironments,
  sourceScanArguments,
} from './workspace-scanner.mjs';

const sourceArgs = sourceScanArguments('/workspace/AnySentry');
assert.deepEqual(sourceArgs.slice(0, 5), [
  'scan',
  'source',
  '--recursive',
  '--all-packages',
  '--format=json',
]);
assert.equal(sourceArgs.at(-1), '/workspace/AnySentry');
for (const directory of ['artifacts', '.local', '.agents', 'node_modules', 'target']) {
  assert.ok(
    sourceArgs.includes(`--experimental-exclude=g:**/${directory}/**`),
    `OSV source scan must exclude ${directory}`,
  );
}
assert.ok(sourceArgs.slice(5, -1).every((arg) => arg.startsWith('--experimental-exclude=g:**/')));

const permissionDiagnostic = osvScannerGeneralError(
  'open workspace/AnySentry/artifacts/private/.gitignore: permission denied\nsecond line',
);
assert.match(permissionDiagnostic, /exit 127/u);
assert.match(permissionDiagnostic, /artifacts\/private\/\.gitignore: permission denied/u);
assert.equal(permissionDiagnostic.includes('\n'), false);
assert.match(osvScannerGeneralError(''), /no diagnostic output/u);

const modulesDockerfile = await readFile(new URL('../Dockerfile.modules', import.meta.url), 'utf8');
assert.match(
  modulesDockerfile,
  /FROM \$\{NODE_BUILD_IMAGE\} AS workspace-scanner[\s\S]*?apt-get install -y --no-install-recommends ca-certificates/u,
  'workspace-scanner image must contain the system CA bundle required by deps.dev and OSV',
);

const root = await mkdtemp(join(tmpdir(), 'anysentry-installed-inventory-'));
try {
  const nodePackage = join(root, 'node_modules', 'example-package');
  await mkdir(nodePackage, { recursive: true });
  await writeFile(
    join(nodePackage, 'package.json'),
    JSON.stringify({ name: 'example-package', version: '1.2.3' }),
  );

  const pythonPackage = join(
    root,
    '.venv',
    'lib',
    'python3.12',
    'site-packages',
    'example_python-4.5.6.dist-info',
  );
  await mkdir(pythonPackage, { recursive: true });
  await writeFile(
    join(pythonPackage, 'METADATA'),
    'Metadata-Version: 2.1\nName: example-python\nVersion: 4.5.6\n',
  );

  const components = await scanInstalledEnvironments(root);
  const node = components.find((component) => component.ecosystem === 'npm');
  const python = components.find((component) => component.ecosystem === 'PyPI');
  assert.equal(node?.packageName, 'example-package');
  assert.equal(node?.version, '1.2.3');
  assert.equal(node?.installedEnvironments?.[0]?.kind, 'node_modules');
  assert.equal(python?.packageName, 'example-python');
  assert.equal(python?.version, '4.5.6');
  assert.equal(python?.installedEnvironments?.[0]?.kind, 'python_environment');
  assert.equal(extractionStatusFromWarnings(['Scanning source']), 'complete');
  assert.equal(extractionStatusFromWarnings(['Error during extraction: failed resolution']), 'partial');
  console.log('Workspace installed environment inventory verification passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
