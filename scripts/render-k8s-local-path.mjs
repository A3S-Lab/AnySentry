#!/usr/bin/env node

/**
 * Render the single-node local-path profile with an explicitly validated checkout path.
 *
 * Kustomize has no portable, built-in environment substitution for hostPath values.  Rather
 * than asking operators to edit the tracked overlay (or briefly create an empty Directory),
 * this command creates a private sibling overlay, adds a strategic patch, renders it, and
 * removes the private directory before returning.  It never applies resources to Kubernetes.
 */

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { validateWorkspacePath } from './verify-k8s-workspace-path.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceOverlay = join(repoRoot, 'deploy/manual-test/k8s-local-path');
const MAX_RENDER_BYTES = 64 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  node scripts/render-k8s-local-path.mjs --workspace-path /absolute/checkout',
    '',
    'The command validates the existing directory, renders a private Kustomize overlay, and',
    'writes YAML to stdout. Pipe the output to kubectl apply only after reviewing the target.',
  ].join('\n');
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

function runKubectl(kubectl, overlayPath) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(kubectl, ['kustomize', '--load-restrictor=LoadRestrictionsNone', overlayPath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_RENDER_BYTES) stdout.push(chunk);
      else child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 1_000_000) stderr.push(chunk);
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const errorText = Buffer.concat(stderr).toString('utf8').trim();
      if (signal || code !== 0) {
        reject(new Error(`kubectl kustomize failed: ${errorText || signal || `exit ${code}`}`));
        return;
      }
      if (stdoutBytes > MAX_RENDER_BYTES) {
        reject(new Error(`rendered manifest exceeds ${MAX_RENDER_BYTES} bytes`));
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString('utf8'));
    });
  });
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  let workspacePath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--workspace-path') workspacePath = optionValue(argv, index++, argument);
    else if (argument === '--kubectl') {
      // Keep this override useful for hermetic local tests without accepting arbitrary command
      // arguments; the executable itself is resolved by spawn.
      process.env.ANYSENTRY_KUBECTL = optionValue(argv, index++, argument);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (!workspacePath) throw new Error('--workspace-path is required');
  const validated = await validateWorkspacePath(workspacePath);
  const temporaryOverlay = await mkdtemp(join(dirname(sourceOverlay), '.k8s-local-path-render-'));
  try {
    await cp(sourceOverlay, temporaryOverlay, { recursive: true });
    const kustomizationPath = join(temporaryOverlay, 'kustomization.yaml');
    const kustomization = await readFile(kustomizationPath, 'utf8');
    const patchName = 'workspace-host-path.generated.yaml';
    const patch = [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      '  name: workspace-scanner',
      '  namespace: anysentry',
      'spec:',
      '  template:',
      '    metadata:',
      '      annotations:',
      `        anysentry.io/manual-host-workspace: ${JSON.stringify(validated.path)}`,
      '    spec:',
      '      volumes:',
      '        - name: workspace',
      '          hostPath:',
      `            path: ${JSON.stringify(validated.path)}`,
      '            type: Directory',
      '',
    ].join('\n');
    await writeFile(join(temporaryOverlay, patchName), patch, { encoding: 'utf8', mode: 0o600 });
    if (!/^patches:\s*$/mu.test(kustomization)) {
      throw new Error('local-path kustomization has no patches section');
    }
    await writeFile(
      kustomizationPath,
      `${kustomization.trimEnd()}\n  - path: ${patchName}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    const rendered = await runKubectl(process.env.ANYSENTRY_KUBECTL || 'kubectl', temporaryOverlay);
    process.stdout.write(rendered);
  } finally {
    await rm(temporaryOverlay, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`local-path render failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
  });
}
