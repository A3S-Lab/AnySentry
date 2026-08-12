import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const buildRoot = new URL('../doc_build/', import.meta.url);
const requiredFiles = [
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
for (const marker of ['AnySentry', 'social-card.svg', 'search']) {
  if (!indexHtml.toLowerCase().includes(marker.toLowerCase())) {
    throw new Error(`Built homepage is missing marker: ${marker}`);
  }
}

const homepageChecks = [
  [
    indexHtml,
    [
      '把 Agent 的每一次行动',
      '四个智能体 三类规则 两段治理链路',
      '同一个动作 在不同系统现场中得到不同结论',
      '让一次审查成为下一次执行前的控制',
      '风险不是一个红点 而是一条可追问的系统事实',
    ],
  ],
  [
    englishIndexHtml.replaceAll('&mdash;', '—'),
    [
      'Judge every Agent action',
      'Four agents, three risk domains, two governance paths',
      'The same action means something different in a different system context',
      'Turn one review into control before the next execution',
      'Risk is not a red dot — it is a system fact you can question',
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
  !chineseMarkdown.includes('把 Agent 的每一次行动') ||
  !chineseMarkdown.includes('四个角色进入四个关键节点') ||
  !chineseMarkdown.includes('两段链路构成一个持续治理闭环') ||
  !englishMarkdown.includes('Judge every Agent action') ||
  !englishMarkdown.includes('Four roles at four critical moments') ||
  !englishMarkdown.includes('Two paths form one continuous control loop') ||
  chineseMarkdown.length < 1_000 ||
  englishMarkdown.length < 2_000
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
  `Built site verified: ${requiredFiles.length} required files and ${searchIndexes.length} search indexes.`,
);
