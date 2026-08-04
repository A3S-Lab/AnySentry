#!/usr/bin/env node
import { opendir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [nodeModulesPath, applicationPackagePath, outputPath] = process.argv.slice(2);
if (!nodeModulesPath || !applicationPackagePath || !outputPath) {
  throw new Error('usage: generate-production-component-manifest <node_modules> <package.json> <output>');
}

const applicationPackage = JSON.parse(await readFile(applicationPackagePath, 'utf8'));
const directNames = new Set([
  ...Object.keys(applicationPackage.dependencies ?? {}),
  ...Object.keys(applicationPackage.optionalDependencies ?? {}),
]);
const visited = new Set();
const components = new Map();

async function visit(directory) {
  const actual = await realpath(directory).catch(() => '');
  if (!actual || visited.has(actual)) return;
  visited.add(actual);
  const metadata = await stat(actual).catch(() => undefined);
  if (!metadata?.isDirectory()) return;

  const packagePath = resolve(actual, 'package.json');
  const pkg = await readFile(packagePath, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => undefined);
  if (pkg?.name && pkg?.version) {
    const packageName = String(pkg.name);
    const version = String(pkg.version);
    const key = `${packageName}\u0000${version}`;
    components.set(key, {
      relativeSourcePath: `app/node_modules/${packageName}/package.json`,
      ecosystem: 'npm',
      packageName,
      version,
      dependencyScope: 'runtime',
      direct: directNames.has(packageName),
    });
    await visit(resolve(actual, 'node_modules'));
    return;
  }

  const handle = await opendir(actual).catch(() => undefined);
  if (!handle) return;
  for await (const entry of handle) {
    if (entry.name === '.bin') continue;
    const candidate = resolve(actual, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) await visit(candidate);
  }
}

await visit(nodeModulesPath);
const output = [...components.values()]
  .sort((left, right) => `${left.packageName}@${left.version}`.localeCompare(`${right.packageName}@${right.version}`));
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(`Production component manifest contains ${output.length} npm packages`);
