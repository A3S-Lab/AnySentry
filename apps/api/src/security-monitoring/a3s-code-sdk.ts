import { createRequire } from 'node:module';

type A3sCodeSdk = typeof import('@a3s-lab/code');

/**
 * The native package throws while it is being imported when the platform
 * binary is missing or the host C library is older than the binary. Callers
 * that only need it for an L2, L3, or assistant session load it then.
 */
export function loadA3sCodeSdk(): A3sCodeSdk {
  const require = createRequire(__filename);
  return require('@a3s-lab/code') as A3sCodeSdk;
}
