#!/usr/bin/env node
// Build and submit the mobile app to the stores via EAS.
// Loads EXPO_TOKEN from the app's .env so the CLI authenticates as the project
// owner (namcyeon) regardless of any locally-logged-in EAS session.
//
// Usage:
//   npm run build                              # build + submit iOS
//   npm run build -- ios                       # build + submit iOS only
//   npm run build -- android                   # build + submit Android only
//   npm run build -- all                       # build + submit both
//   npm run build -- ios --no-submit           # build only, skip submit
//   npm run build -- ios --profile preview     # use a different build profile
//
// Notes:
// - Default platform is ios, default profile is production.
// - Build numbers are auto-incremented (autoIncrement in eas.json).
// - Submit uses the profile's submit configuration (ascAppId / appleId).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const envFile = resolve(appDir, '.env');

// --- Parse args -------------------------------------------------------------
const validPlatforms = new Set(['ios', 'android', 'all']);
let platform = 'ios';
let profile = 'production';
let submit = true;

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (validPlatforms.has(a)) platform = a;
  else if (a === '--no-submit') submit = false;
  else if (a === '--profile') profile = process.argv[++i];
  else if (a.startsWith('--profile=')) profile = a.slice('--profile='.length);
  else if (a === '--submit') submit = true;
  else {
    console.error(`[eas-build] unknown argument: ${a}`);
    printUsage();
    process.exit(2);
  }
}

function printUsage() {
  console.error(
    'Usage: eas-build.mjs [ios|android|all] [--profile <name>] [--no-submit]',
  );
}

// --- Load .env (only sets vars not already present in process.env) ----------
const env = {};
try {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (!(m[1] in process.env)) env[m[1]] = m[2];
  }
} catch {
  console.error(`[eas-build] cannot read ${envFile}`);
  process.exit(1);
}

if (!env.EXPO_TOKEN && !process.env.EXPO_TOKEN) {
  console.error('[eas-build] EXPO_TOKEN missing from', envFile);
  process.exit(1);
}

// --- Resolve platforms ------------------------------------------------------
const platforms = platform === 'all' ? ['ios', 'android'] : [platform];

// Suppress the Expo Go warning (we intentionally use a custom dev client).
env.EAS_BUILD_NO_EXPO_GO_WARNING = 'true';

const childEnv = { ...process.env, ...env };

// --- Helpers ----------------------------------------------------------------
// npx is a .cmd shim on Windows; spawnSync on a .cmd throws EINVAL without a
// shell. We route through cmd.exe and use windowsVerbatimArguments so
// double-quoted argv survives intact. POSIX npx takes a normal argv.
function runEas(args) {
  const isWin = process.platform === 'win32';
  return isWin
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `npx eas-cli ${args.join(' ')}`], {
        cwd: appDir,
        stdio: 'inherit',
        windowsVerbatimArguments: true,
        env: childEnv,
      })
    : spawnSync('npx', ['eas-cli', ...args], {
        cwd: appDir,
        stdio: 'inherit',
        env: childEnv,
      });
}

function tag(label, msg) {
  const c = ({ ios: '\x1b[36m', android: '\x1b[32m' })[label] ?? '\x1b[35m';
  console.log(`\n${c}[eas-build:${label}]\x1b[0m ${msg}`);
}

// --- Build + submit per platform --------------------------------------------
async function main() {
  const results = { ios: null, android: null };

  for (const p of platforms) {
    tag(p, `building profile="${profile}" submit=${submit}`);
    const buildArgs = [
      'build',
      '--platform',
      p,
      '--profile',
      profile,
      '--non-interactive',
    ];
    if (submit) buildArgs.push('--auto-submit');

    const r = runEas(buildArgs);
    if (r.error) {
      console.error(`[eas-build:${p}] spawn failed:`, r.error.message);
      process.exit(1);
    }
    if (r.status !== 0) {
      console.error(`[eas-build:${p}] build failed (exit ${r.status})`);
      process.exit(r.status ?? 1);
    }
    tag(p, 'build complete');
    results[p] = 'built';
  }

  // Summary ------------------------------------------------------------------
  console.log('\n[eas-build] summary');
  for (const p of platforms) {
    const s = results[p];
    console.log(`  ${p}: ${s}`);
  }
}

main().catch((e) => {
  console.error('[eas-build]', e.message ?? e);
  process.exit(1);
});
