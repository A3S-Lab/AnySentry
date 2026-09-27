#!/usr/bin/env node

/**
 * Fail-closed preflight for the local Kubernetes Workspace Scanner hostPath.
 *
 * A hostPath with `type: Directory` must already exist on the selected node.  This command is
 * intentionally read-only: it never creates the directory and never changes a Kubernetes object.
 * The renderer in render-k8s-local-path.mjs calls the same validator before producing a manifest.
 */

import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const MAX_PATH_LENGTH = 4_096;

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-k8s-workspace-path.mjs --path /absolute/checkout',
    '',
    'Checks that the path already exists as a real directory. It never creates a hostPath.',
  ].join('\n');
}

export async function validateWorkspacePath(inputPath) {
  const value = String(inputPath ?? '').trim();
  if (!value || !path.isAbsolute(value) || value.includes('\0') || value.length > MAX_PATH_LENGTH) {
    throw new Error('workspace path must be a non-empty absolute path of at most 4096 bytes');
  }
  const normalized = path.normalize(value);
  if (normalized === path.parse(normalized).root) {
    throw new Error('workspace path must not be the filesystem root');
  }
  let metadata;
  try {
    metadata = await lstat(normalized);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`workspace path does not exist: ${normalized}`);
    }
    throw new Error(`workspace path cannot be inspected (${error?.code || 'unknown'})`);
  }
  if (metadata.isSymbolicLink()) {
    throw new Error('workspace path must be a real directory, not a symbolic link');
  }
  if (!metadata.isDirectory()) {
    throw new Error('workspace path exists but is not a directory');
  }
  let canonical;
  try {
    canonical = await realpath(normalized);
    const canonicalMetadata = await stat(canonical);
    if (!canonicalMetadata.isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new Error(`workspace path is not traversable (${error?.code || 'unknown'})`);
  }
  return { path: normalized, realpath: canonical };
}

function optionValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    return;
  }
  let workspacePath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--path') workspacePath = optionValue(argv, index++, argument);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!workspacePath) throw new Error('--path is required');
  const result = await validateWorkspacePath(workspacePath);
  console.log(JSON.stringify({ ok: true, path: result.path, realpath: result.realpath }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`workspace path preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(usage());
    process.exitCode = 1;
  });
}
