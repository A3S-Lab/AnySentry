interface ImportMetaEnv {
  readonly SSG_MD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module '*.css';
