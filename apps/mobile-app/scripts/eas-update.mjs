#!/usr/bin/env node
// Push an EAS update from apps/mobile-app.
// Loads EXPO_TOKEN from the app's .env so the CLI authenticates as the project
// owner (namcyeon) regardless of any locally-logged-in EAS session.
//
// The --message is shown to users in the in-app update modal as the changelog,
// so write it like release notes (what changed / fixed), not a raw commit hash.
//
// Usage:
//   npm run update                          # auto message from last git commit
//   npm run update -- "fix: crash on launch"

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..')
const envFile = resolve(appDir, '.env');

// --- Load .env (only sets vars not already present in process.env) ----------
const env = {};
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (!(m[1] in process.env)) env[m[1]] = m[2];
  }
} catch {
  console.error(`[eas-update] cannot read ${envFile}`);
  process.exit(1);
}

if (!env.EXPO_TOKEN) {
  console.error('[eas-update] EXPO_TOKEN missing from', envFile);
  process.exit(1);
}

// --- Message: explicit arg, else last git commit subject --------------------
let message = process.argv[2];
if (!message) {
  const git = spawnSync('git', ['log', '-1', '--pretty=%s'], { encoding: 'utf8' });
  message = (git.stdout || '').trim() || 'JS bundle update';
}

console.log(`[eas-update] channel=production message="${message}"`);

// --- Run: eas update --channel production -----------------------------------
// npx is a .cmd shim on Windows; spawnSync on a .cmd throws EINVAL without a
// shell. We route through cmd.exe and use windowsVerbatimArguments so the
// double-quoted --message value survives intact (without it, cmd.exe strips
// the quotes and oclif splits the message on spaces). POSIX npx takes a normal
// argv.
const r =
  process.platform === 'win32'
    ? spawnSync(
        'cmd.exe',
        ['/d', '/s', '/c', `npx eas-cli update --channel production --environment production --message "${message}" --non-interactive`],
        {
          cwd: appDir,
          stdio: 'inherit',
          windowsVerbatimArguments: true,
          env: { ...process.env, ...env },
        },
      )
    : spawnSync(
        'npx',
        ['eas-cli', 'update', '--channel', 'production', '--environment', 'production', '--message', message, '--non-interactive'],
        { cwd: appDir, stdio: 'inherit', env: { ...process.env, ...env } },
      );

if (r.error) {
  console.error('[eas-update] spawn failed:', r.error.message);
  process.exit(1);
}
process.exit(r.status ?? 1);
