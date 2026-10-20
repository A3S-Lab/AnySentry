import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

type A3sCodeSdk = typeof import('@a3s-lab/code');

let cachedCpuCompatible: boolean | undefined;

/**
 * The published @a3s-lab/code linux-x64 binaries embed AVX-512 (zmm) vector
 * code. On hosts without it the addon still imports, but the first vector
 * path raises SIGILL and takes the whole process down with no JS-level error
 * to catch (observed on an Ivy Bridge host: model-connection tests and any
 * L2 judgment crashed the API). Gate the load on an explicit capability
 * probe so such hosts degrade with a clear message instead of crashing.
 */
function assertCpuSupportsPublishedAddon(): void {
  if (cachedCpuCompatible === undefined) {
    try {
      const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
      cachedCpuCompatible = /(?:^|\t|\s)avx512f(?:\s|$)/m.test(cpuinfo);
    } catch {
      cachedCpuCompatible = true; // cannot probe: keep the legacy behaviour
    }
  }
  if (!cachedCpuCompatible) {
    throw new Error(
      'a3s-code 原生运行时（发布版二进制）需要 AVX-512 指令集，当前主机 CPU 不支持：' +
        'L2/L3 研判与模型连通性测试在此机型不可用（其余采集/聚合/展示功能不受影响）。' +
        '需要 baseline 编译版 a3s-code 或具备 AVX-512 的主机。',
    );
  }
}

/**
 * The native package throws while it is being imported when the platform
 * binary is missing or the host C library is older than the binary. Callers
 * that only need it for an L2, L3, or assistant session load it then.
 */
export function loadA3sCodeSdk(): A3sCodeSdk {
  assertCpuSupportsPublishedAddon();
  const require = createRequire(__filename);
  return require('@a3s-lab/code') as A3sCodeSdk;
}
