#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractionStatusFromWarnings,
  scanInstalledEnvironments,
} from './workspace-scanner.mjs';

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
