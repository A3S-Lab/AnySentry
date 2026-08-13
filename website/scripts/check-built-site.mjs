import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const buildRoot = new URL('../doc_build/', import.meta.url);
const requiredFiles = [
  '404.html',
  'index.html',
  'en/index.html',
  'guide/index.html',
  'en/guide/index.html',
  'safety-loop/index.html',
  'en/safety-loop/index.html',
  'architecture/index.html',
  'en/architecture/index.html',
  'scenarios/index.html',
  'en/scenarios/index.html',
  'llms.txt',
  'en/llms.txt',
  'anysentry-mark.svg',
  'anysentry-mark-reversed.svg',
  'anysentry-logo-horizontal.svg',
  'anysentry-logo-horizontal-reversed.svg',
  'social-card.svg',
  'ai-native/index.html',
  'en/ai-native/index.html',
  'judgment/index.html',
  'en/judgment/index.html',
  'evidence/index.html',
  'en/evidence/index.html',
];

await Promise.all(
  requiredFiles.map((file) => access(new URL(file, buildRoot))),
);

const indexHtml = await readFile(new URL('index.html', buildRoot), 'utf8');
const englishIndexHtml = await readFile(
  new URL('en/index.html', buildRoot),
  'utf8',
);

const builtBase = indexHtml.match(
  /(?:href|src)="(\/[^"<>]*?)static\/(?:css|js)\//,
)?.[1];

if (!builtBase?.endsWith('/')) {
  throw new Error('Unable to determine the built site base path.');
}

const htmlFiles = requiredFiles.filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const html = await readFile(new URL(file, buildRoot), 'utf8');
  const localUrls = [...html.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map(
    (match) => match[1],
  );
  const escapedBaseUrls = localUrls.filter(
    (url) => !url.startsWith('//') && !url.startsWith(builtBase),
  );

  if (escapedBaseUrls.length > 0) {
    throw new Error(
      `Built page ${file} contains URLs outside ${builtBase}: ${[
        ...new Set(escapedBaseUrls),
      ].join(', ')}`,
    );
  }
}

for (const marker of ['AnySentry', 'social-card.svg', 'search']) {
  if (!indexHtml.toLowerCase().includes(marker.toLowerCase())) {
    throw new Error(`Built homepage is missing marker: ${marker}`);
  }
}

const homepageChecks = [
  [
    indexHtml,
    [
      '接入智能体',
      '可观测平台',
      'AnySentry 把 Agent 意图、工具调用、内核事件和主机状态汇入同一证据链，在运行中发现风险，及时阻断。',
      'WHAT YOU GET · 核心能力',
      '从运行事实',
      '到执行前控制',
      '一次风险如何',
      '从发现走向阻断',
      '一条事件如何保留',
      '每一步判断依据',
      '让一次审查成为',
      '下一次执行前的控制',
      '接入什么、依据什么、何时生效',
      '都能被验证',
    ],
  ],
  [
    englishIndexHtml.replaceAll('&mdash;', '—'),
    [
      'Connect Agents to',
      'observability platform',
      'From runtime facts',
      'to control before execution',
      'How one risk travels',
      'from discovery to prevention',
      'How one event preserves',
      'every basis for judgment',
      'Turn one review into control',
      'before the next execution',
      'Verify what enters, what supports a verdict',
      'and when control applies',
    ],
  ],
];

for (const [html, markers] of homepageChecks) {
  if (
    markers.some((marker) => !html.includes(marker)) ||
    html.includes('pageType: home title:') ||
    html.includes('用十秒看清审查如何变成下一次阻断') ||
    html.includes('Turn AI judgment into a governable system capability') ||
    html.includes('id="boundaries"')
  ) {
    throw new Error(
      `Homepage rendering check failed for markers: ${markers.join(', ')}`,
    );
  }
}

const [chineseMarkdown, englishMarkdown] = await Promise.all([
  readFile(new URL('index.md', buildRoot), 'utf8'),
  readFile(new URL('en/index.md', buildRoot), 'utf8'),
]);

if (
  !chineseMarkdown.includes('接入智能体可观测平台') ||
  !chineseMarkdown.includes('从运行事实到执行前控制') ||
  !chineseMarkdown.includes('一次风险如何从发现走向阻断') ||
  !chineseMarkdown.includes('让一次审查成为下一次执行前的控制') ||
  !chineseMarkdown.includes('接入什么、依据什么、何时生效，都能被验证') ||
  !englishMarkdown.includes('Connect Agents to an observability platform') ||
  !englishMarkdown.includes('From runtime facts to control before execution') ||
  !englishMarkdown.includes(
    'How one risk travels from discovery to prevention',
  ) ||
  !englishMarkdown.includes(
    'Turn one review into control before the next execution',
  ) ||
  !englishMarkdown.includes(
    'Verify what enters, what supports a verdict, and when control applies',
  ) ||
  chineseMarkdown.length < 450 ||
  englishMarkdown.length < 1_200
) {
  throw new Error('Homepage Markdown fallback is incomplete.');
}

const staticFiles = await readdir(new URL('static/', buildRoot));
const searchIndexes = staticFiles.filter((file) =>
  /^search_index\.(?:zh|en)\..+\.json$/.test(path.basename(file)),
);

if (searchIndexes.length < 2) {
  throw new Error('Expected both Chinese and English search indexes.');
}

console.log(
  `Built site verified at ${builtBase}: ${requiredFiles.length} required files and ${searchIndexes.length} search indexes.`,
);
