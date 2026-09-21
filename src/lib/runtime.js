/**
 * Runtime preflight.
 *
 * The app stores data via `node:sqlite`, which exists from Node 22.5 but stayed
 * behind --experimental-sqlite until 22.13. On an older runtime the failure is a
 * bare ERR_UNKNOWN_BUILTIN_MODULE thrown while the module graph is still being
 * linked, which names neither the cause nor the fix. This check runs first and
 * says exactly what to change.
 */
export const MIN_NODE = [22, 13, 0];

export function parseVersion(version) {
  return String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function isSupported(version = process.versions.node) {
  const [major, minor, patch] = parseVersion(version);
  const [reqMajor, reqMinor, reqPatch] = MIN_NODE;
  if (major !== reqMajor) return major > reqMajor;
  if (minor !== reqMinor) return minor > reqMinor;
  return patch >= reqPatch;
}

export function checkRuntime({ exit = true } = {}) {
  if (isSupported()) return true;

  const required = MIN_NODE.join('.');
  process.stderr.write([
    '',
    '  ✖ FinTrack cannot start on this version of Node.',
    '',
    `    Running:  Node ${process.versions.node}`,
    `    Required: Node ${required} or newer`,
    '',
    '    Why: the database uses the built-in `node:sqlite` module, which is not',
    `    usable before Node ${required} (it was behind a flag until then).`,
    '',
    '    Fix:',
    '      • Locally .... install Node 22.13+ (nvm install 22 && nvm use 22)',
    '      • Render ..... Environment → set NODE_VERSION to 22.22.2,',
    '                     or rely on the .node-version file in this repo',
    '      • Docker ..... use the node:22.22-alpine base image',
    '',
    ''
  ].join('\n'));

  if (exit) process.exit(1);
  return false;
}
