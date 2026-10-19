'use strict';
const path = require('node:path');

// Optional deployment scope. It is independent of cgroup identity rules: a keep rule
// for an Agent must not expand a session-file-only capture into all of its files.
function fileScope(raw) {
  const roots = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  if (roots.length > 32 || roots.some(s => !s.startsWith('/') || s === '/' || s.includes('\0'))) {
    throw new Error('FORWARD_FILE_INCLUDE_PATHS requires up to 32 absolute non-root paths');
  }
  const normalized = roots.map(s => path.posix.normalize(s).replace(/\/$/, ''));
  return event => {
    const file = event?.event?.FileAccess ?? event?.event?.FileDelete;
    if (!file || !normalized.length) return true;
    if (typeof file.path !== 'string' || !file.path.startsWith('/')) return false;
    const target = path.posix.normalize(file.path);
    return normalized.some(root => target === root || target.startsWith(`${root}/`));
  };
}
module.exports = { fileScope };
