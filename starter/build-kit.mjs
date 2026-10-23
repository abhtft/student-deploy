#!/usr/bin/env node
// Build the student kit into a folder:   node starter/build-kit.mjs <outDir> [--force]
//
// The kit = starter/template/ (the project skeleton)
//         + student/portal-deploy.mjs                -> portal-deploy.mjs            (single source: the same CLI the portal offers)
//         + student/class_ai.py / class_ai.mjs       -> backend/class_ai.py, variants/node-backend/class_ai.mjs
//         + starter/rules/AGENTS.md                  -> the rules, under the file names each AI editor reads (identical content)
//         + kit-manifest.json                        -> sha256 of every file, for `update` and integrity checks
//
// Nothing secret and nothing personal goes in: the kit is generic and can live in a public repository.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');

/** The rule files each AI editor reads. All carry the SAME rules, so it does not matter which one an editor prefers. */
export function ruleFiles(rules) {
  const description = "The class platform's rules for this project: layout, the class AI helper, limits, secrets, deploy. Use when building, changing or deploying anything here.";
  return {
    'AGENTS.md': rules, // the open standard: Codex, Cursor, Copilot, Windsurf, Antigravity and others read this
    'GEMINI.md': rules, // Gemini CLI and Antigravity
    'CLAUDE.md': `@AGENTS.md\n`, // Claude Code imports the shared rules
    '.claude/skills/class-platform/SKILL.md': `---\nname: class-platform\ndescription: ${description}\n---\n\n${rules}`,
    '.cursor/rules/class-platform.mdc': `---\ndescription: ${description}\nalwaysApply: true\n---\n\n${rules}`,
    '.github/copilot-instructions.md': rules, // GitHub Copilot
    '.windsurfrules': rules, // Windsurf
  };
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export function buildKit(out, { force = false } = {}) {
  out = resolve(out);
  if (existsSync(out) && readdirSync(out).length) {
    if (!force) throw new Error(`${out} is not empty. Use --force to replace its contents.`);
    rmSync(out, { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  cpSync(join(here, 'template'), out, { recursive: true });

  const copy = (from, to) => {
    mkdirSync(dirname(join(out, to)), { recursive: true });
    cpSync(join(repo, from), join(out, to));
  };
  copy('student/portal-deploy.mjs', 'portal-deploy.mjs');
  copy('student/class_ai.py', 'backend/class_ai.py');
  copy('student/class_ai.mjs', 'variants/node-backend/class_ai.mjs');

  const rules = readFileSync(join(here, 'rules', 'AGENTS.md'), 'utf8').replace(/\r\n/g, '\n');
  for (const [name, content] of Object.entries(ruleFiles(rules))) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), content);
  }

  // Text files always get LF line endings, so the kit (and its manifest hashes) is identical whichever computer built it.
  for (const file of listFiles(out)) {
    const data = readFileSync(file);
    if (data.includes(0)) continue; // binary
    const text = data.toString('utf8');
    if (text.includes('\r\n')) writeFileSync(file, text.replace(/\r\n/g, '\n'));
  }

  const platform = JSON.parse(readFileSync(join(out, 'platform.json'), 'utf8'));
  const files = Object.fromEntries(listFiles(out).map((f) => [relative(out, f).split(sep).join('/'), createHash('sha256').update(readFileSync(f)).digest('hex')]).sort());
  writeFileSync(join(out, 'kit-manifest.json'), `${JSON.stringify({ kit: platform.kit, kitVersion: platform.kitVersion, files }, null, 2)}\n`);
  return { out, version: platform.kitVersion, files: Object.keys(files).length + 1 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node starter/build-kit.mjs <outDir> [--force]');
    process.exit(1);
  }
  try {
    const result = buildKit(target, { force: process.argv.includes('--force') });
    console.log(`Kit ${result.version} built in ${result.out} (${result.files} files)`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
