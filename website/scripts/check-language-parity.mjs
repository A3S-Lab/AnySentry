import { readdir } from 'node:fs/promises';
import path from 'node:path';

const docsRoot = new URL('../docs/', import.meta.url);

async function collect(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('_')) continue;
    const relative = path.posix.join(prefix, entry.name);
    const absolute = new URL(`${relative}`, directory);
    if (entry.isDirectory()) {
      files.push(
        ...(await collect(new URL(`${entry.name}/`, directory), relative)),
      );
    } else if (/\.(?:md|mdx)$/.test(entry.name)) {
      files.push(relative);
    }
  }

  return files.sort();
}

const [zhFiles, enFiles] = await Promise.all([
  collect(new URL('zh/', docsRoot)),
  collect(new URL('en/', docsRoot)),
]);

const missingInEnglish = zhFiles.filter((file) => !enFiles.includes(file));
const missingInChinese = enFiles.filter((file) => !zhFiles.includes(file));

if (missingInEnglish.length || missingInChinese.length) {
  console.error('Documentation language parity check failed.');
  if (missingInEnglish.length) {
    console.error(`Missing in English: ${missingInEnglish.join(', ')}`);
  }
  if (missingInChinese.length) {
    console.error(`Missing in Chinese: ${missingInChinese.join(', ')}`);
  }
  process.exit(1);
}

console.log(`Language parity verified for ${zhFiles.length} routes.`);
