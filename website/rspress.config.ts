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
    'AI-Native runtime security and governance that judges Agent actions with intent, runtime facts, and system context.',
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
        '面向 AI-Native 系统的运行时安全与治理平面，将 Agent 意图、运行事实与系统现场汇入同一判断上下文。',
    },
    {
      lang: 'en',
      label: 'English',
      title: 'AnySentry',
      description:
        'AI-Native runtime security and governance that judges Agent actions with intent, runtime facts, and system context.',
    },
  ],
  head: [
    ['meta', { name: 'theme-color', content: '#05090e' }],
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
