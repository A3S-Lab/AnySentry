import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@rsbuild/core";
import { pluginReact } from "@rsbuild/plugin-react";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const browserTargets = ["Chrome >= 91", "Edge >= 91", "Firefox >= 90", "Safari >= 14", "iOS >= 14", "not dead"];

// AnySentry backend default port. Override with `WEB_PROXY_API_TARGET` when needed.
const apiProxyTarget = process.env.WEB_PROXY_API_TARGET || "http://127.0.0.1:29653";

const proxy = (target: string, options: { ws?: boolean } = {}) => ({
  target,
  changeOrigin: true,
  ...options,
});

export default defineConfig({
  html: {
    template: "./index.html",
  },
  source: {
    entry: {
      index: "./src/main.tsx",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  output: {
    distPath: {
      root: "dist",
    },
    // Serve assets under a configurable base path (e.g. behind an ingress at
    // `/apps/anysentry`). Empty => root, so local dev is unaffected.
    assetPrefix: process.env.PUBLIC_BASE_PATH ? `${process.env.PUBLIC_BASE_PATH}/` : "/",
    overrideBrowserslist: browserTargets,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      // Route the dashboard's API calls to the AnySentry backend in dev.
      "/security-center": proxy(apiProxyTarget, { ws: true }),
      "/open": proxy(apiProxyTarget),
      "/api": proxy(apiProxyTarget),
    },
  },
  plugins: [pluginReact()],
});
