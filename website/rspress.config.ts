import * as path from 'node:path';
import { defineConfig } from '@rspress/core';

const base = process.env.DOCS_BASE ?? '/';
const siteOrigin = process.env.DOCS_ORIGIN ?? 'https://a3s-lab.github.io';

export default defineConfig({
  root: path.join(__dirname, 'docs'),
  base,
  siteOrigin,
  title: 'AnySentry',
  description:
    'An evidence and governance plane for AI agent runtime security: observe actual behavior, judge risk, investigate context, and take auditable action.',
  lang: 'zh',
  icon: '/favicon.svg',
  logo: '/anysentry-logo-horizontal-reversed.svg',
  logoText: '',
  outDir: 'doc_build',
  llms: true,
  locales: [
    {
      lang: 'zh',
      label: '简体中文',
      title: 'AnySentry',
      description:
        '面向 AI Agent 运行时的证据与治理平面：观测真实行为、判断风险、调查上下文并执行可审计动作。',
    },
    {
      lang: 'en',
      label: 'English',
      title: 'AnySentry',
      description:
        'An evidence and governance plane for AI agent runtime security: observe actual behavior, judge risk, investigate context, and take auditable action.',
    },
  ],
  head: [
    ['meta', { name: 'theme-color', content: '#080b0d' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'AnySentry' }],
    [
      'meta',
      {
        property: 'og:image',
        content: `${siteOrigin}${base}social-card.svg`,
      },
    ],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    (route) => [
      'link',
      {
        rel: 'canonical',
        href: `${siteOrigin}${base.replace(/\/$/, '')}${route.routePath}`,
      },
    ],
  ],
  themeConfig: {
    darkMode: 'force-dark',
    search: true,
    localeRedirect: 'never',
    enableContentAnimation: true,
    editLink: {
      docRepoBaseUrl:
        'https://github.com/A3S-Lab/AnySentry/tree/main/website/docs',
    },
    llmsUI: {
      placement: 'outline',
      viewOptions: ['markdownLink', 'chatgpt', 'claude'],
    },
    socialLinks: [
      {
        icon: 'github',
        mode: 'link',
        content: 'https://github.com/A3S-Lab/AnySentry',
      },
    ],
  },
});
