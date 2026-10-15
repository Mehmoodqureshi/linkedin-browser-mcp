#!/usr/bin/env node
/**
 * pack-mcpb.js — build a `.mcpb` bundle WITHOUT the `@anthropic-ai/mcpb` CLI.
 *
 * A `.mcpb` (Desktop Extension) is just a ZIP archive with `manifest.json` at
 * its root, the server's compiled code, its runtime `node_modules`, and any
 * assets the manifest references. This script assembles exactly that using only
 * Node + the system `zip` (posix) / `tar` (Windows bsdtar) — no extra tooling.
 *
 * Steps:
 *   0. Sync manifest.json's `version` from package.json — see syncManifestVersion.
 *   1. `npm run build` — compile dist/.
 *   1b. Sync manifest.json's `tools` from the server's own catalog — see
 *       syncManifestTools (needs dist/, so it runs after the build).
 *   2. Stage into a temp dir: manifest.json, dist/, assets/, resources/,
 *      package.json + package-lock.json.
 *   3. `npm ci --omit=dev` in the stage so ONLY runtime deps land in the bundle
 *      (Chromium download is skipped — the driver is connect-only).
 *   4. Zip the stage into ./mcp-linkedin-browser.mcpb.
 *
 * Output: ./mcp-linkedin-browser.mcpb — double-clickable into Claude Desktop.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'mcp-linkedin-browser.mcpb');

function log(msg) {
  process.stderr.write(`[pack-mcpb] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

/** Copy a file or directory tree into the stage. */
function copyInto(stage, relPath, { optional = false } = {}) {
  const src = path.join(ROOT, relPath);
  if (!fs.existsSync(src)) {
    if (optional) return;
    throw new Error(`required path missing: ${relPath}`);
  }
  fs.cpSync(src, path.join(stage, relPath), { recursive: true });
}

/**
 * Copy package.json's version into manifest.json.
 *
 * `npm version` bumps package.json and package-lock.json, and knows nothing about
 * the .mcpb manifest — so the two drifted silently (the manifest still claimed
 * 0.6.0 while the package shipped 0.7.0, which is the version Claude Desktop
 * shows for an installed extension). package.json is the single source of truth;
 * this rewrites the manifest in place so the checked-in file never lies, and the
 * staged copy is correct by construction.
 *
 * Rewrites only the one field, preserving key order and the file's 2-space
 * formatting, so the diff after a bump is a single line.
 */
function syncManifestVersion() {
  const pkgPath = path.join(ROOT, 'package.json');
  const manifestPath = path.join(ROOT, 'manifest.json');
  const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const current = JSON.parse(raw).version;
  if (current === version) {
    log(`manifest version already ${version}`);
    return;
  }
  const updated = raw.replace(/("version"\s*:\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
  if (JSON.parse(updated).version !== version) {
    throw new Error(`could not rewrite manifest.json version (${current} -> ${version})`);
  }
  fs.writeFileSync(manifestPath, updated);
  log(`manifest version ${current} -> ${version}`);
}

// --- manifest tools -------------------------------------------------------

/** Cap on a generated tool blurb; the manifest is a summary, not the full catalog. */
const MAX_TOOL_DESCRIPTION = 200;

/**
 * Abbreviations whose trailing dot is not a sentence end. Checked against the
 * text UP TO and including the candidate dot, so only a trailing match counts.
 */
const ABBREVIATION = /(?:^|\s)(?:e\.g|i\.e|etc|vs|approx|no|fig|dr|mr|ms|st|inc|ltd)\.$/i;

/**
 * The first sentence of `text`.
 *
 * A dot ends a sentence only when it is followed by whitespace (or the end) AND
 * the next word starts like a new sentence AND the run-up is not a known
 * abbreviation — so "…(e.g. to react)…" and "0.7" do not split.
 */
function firstSentence(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '.') continue;
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const head = text.slice(0, i + 1);
    if (ABBREVIATION.test(head)) continue;
    const rest = text.slice(i + 1).trimStart();
    if (rest && !/^["'“(A-Z]/.test(rest)) continue;
    return head;
  }
  return text;
}

/** One short blurb for the manifest, derived from a tool's own MCP description. */
function summarize(description) {
  const sentence = firstSentence(description.replace(/\s+/g, ' ').trim());
  if (sentence.length <= MAX_TOOL_DESCRIPTION) return sentence;
  const cut = sentence.slice(0, MAX_TOOL_DESCRIPTION);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[,;:]$/, '')}…`;
}

/**
 * Regenerate manifest.json's `tools` from the server's own `TOOL_DEFINITIONS`.
 *
 * The list was hand-maintained and had drifted badly — it advertised 12 tools
 * while the server exposed 21, so nine tools (including the whole invitations and
 * messaging-read surface) were invisible in the extension's Claude Desktop
 * listing. Deriving it from the catalog means adding a tool updates the manifest
 * for free, and the catalog is already the thing `registerTools` validates
 * against at startup.
 *
 * Each entry keeps the manifest's established shape: a one-sentence blurb, with
 * " Write action." appended for anything the mutation gate covers.
 */
function syncManifestTools() {
  // Required lazily and from dist/, so this must run after the build. Importing
  // the catalog launches nothing — handlers resolve the driver only when called.
  const { TOOL_DEFINITIONS } = require(path.join(ROOT, 'dist', 'mcp', 'tools.js'));
  const { isMutatingTool } = require(path.join(ROOT, 'dist', 'mcp', 'mutation-gate.js'));

  const tools = TOOL_DEFINITIONS.map((d) => ({
    name: d.name,
    description: isMutatingTool(d.name) ? `${summarize(d.description)} Write action.` : summarize(d.description),
  }));

  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const before = JSON.stringify(manifest.tools);
  if (before === JSON.stringify(tools)) {
    log(`manifest tools already in sync (${tools.length})`);
    return;
  }
  const previousCount = Array.isArray(manifest.tools) ? manifest.tools.length : 0;
  manifest.tools = tools;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log(`manifest tools ${previousCount} -> ${tools.length}`);
}

function main() {
  // 0. Keep the manifest's version honest before anything is staged.
  syncManifestVersion();

  // 1. Generate icons + compile. gen-icon writes assets/ (gitignored, generated),
  //    which the manifest's icon reference and the staging copy both need — on a
  //    fresh checkout (CI) they don't exist until this runs.
  const npmShell = process.platform === 'win32';
  log('generating icons…');
  run('npm', ['run', 'gen-icon'], { cwd: ROOT, shell: npmShell });
  log('building dist/…');
  run('npm', ['run', 'build'], { cwd: ROOT, shell: npmShell });

  // 1b. dist/ exists now, so the catalog can be read and mirrored into the manifest.
  syncManifestTools();

  // 2. Stage.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-mcpb-'));
  log(`staging in ${stage}`);
  for (const p of ['manifest.json', 'package.json', 'package-lock.json', 'dist', 'assets', 'resources', 'README.md', 'LICENSE']) {
    copyInto(stage, p, { optional: p === 'resources' || p === 'README.md' });
  }

  // 3. Production-only deps (no Chromium — connect-only never launches a browser).
  //    --ignore-scripts: the bundle needs no postinstall (that step is dev-only,
  //    and its script isn't staged); skipping it is also faster and safer.
  log('installing runtime dependencies (production only)…');
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: stage,
    shell: process.platform === 'win32',
    env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
  });
  // A stray package-lock in the bundle is harmless but pointless — drop it.
  fs.rmSync(path.join(stage, 'package-lock.json'), { force: true });

  // 4. Zip the stage contents (manifest.json must be at the archive ROOT).
  fs.rmSync(OUT, { force: true });
  log(`packing → ${path.relative(ROOT, OUT)}`);
  if (process.platform === 'win32') {
    // bsdtar ships with Windows 10+ and writes real zips.
    run('tar', ['-a', '-c', '-f', OUT, '-C', stage, '.']);
  } else {
    run('zip', ['-r', '-q', OUT, '.'], { cwd: stage });
  }

  fs.rmSync(stage, { recursive: true, force: true });
  const sizeMb = (fs.statSync(OUT).size / (1024 * 1024)).toFixed(1);
  log(`done: ${path.relative(ROOT, OUT)} (${sizeMb} MB)`);
  log('Install it by double-clicking the file in Claude Desktop.');
}

// Only pack when run directly (`npm run pack:mcpb`); requiring this file just
// exposes the helpers, so the manifest-sync logic can be exercised on its own.
if (require.main === module) main();

module.exports = { firstSentence, summarize, syncManifestVersion, syncManifestTools };
