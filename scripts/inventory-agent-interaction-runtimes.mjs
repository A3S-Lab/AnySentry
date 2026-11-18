#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

function command(name, args = []) {
  try {
    return execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

function executable(name) {
  const resolved = command("bash", ["-lc", `command -v ${name}`]);
  if (!resolved || !existsSync(resolved)) return undefined;
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function buildId(file) {
  if (!file) return undefined;
  return command("readelf", ["-n", file])
    .match(/Build ID:\s*([a-f0-9]+)/iu)?.[1];
}

function libraries(file) {
  if (!file) return [];
  return command("ldd", [file])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /(?:ssl|crypto|boring)/iu.test(line));
}

const runtimes = [
  ["node", ["--version"]],
  ["python3", ["--version"]],
  ["bun", ["--version"]],
  ["codex", ["--version"]],
  ["claude", ["--version"]],
].map(([name, args]) => {
  const binary = executable(name);
  return {
    name,
    present: Boolean(binary),
    binary,
    version: binary ? command(binary, args) : undefined,
    buildId: buildId(binary),
    tlsLibraries: libraries(binary),
  };
});

const libssl = [
  "/lib/x86_64-linux-gnu/libssl.so.3",
  "/usr/lib/x86_64-linux-gnu/libssl.so.3",
].find(existsSync);

process.stdout.write(`${JSON.stringify({
  schemaVersion: "anysentry.agent-interaction-runtime-inventory.v1",
  observedAt: new Date().toISOString(),
  kernel: command("uname", ["-srmo"]),
  runtimes,
  openssl: {
    version: command("openssl", ["version", "-a"]).split("\n")[0],
    library: libssl,
    buildId: buildId(libssl),
    symbols: libssl
      ? ["SSL_write", "SSL_write_ex", "SSL_read", "SSL_read_ex"].filter((symbol) =>
          command("readelf", ["-Ws", libssl]).includes(symbol))
      : [],
  },
}, null, 2)}\n`);
