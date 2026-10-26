#!/usr/bin/env node
// Build the npm package a teacher installs with one npx command (name: see PACKAGE_NAME). It carries the platform itself, taken from the files git
// tracks (so no local or personal file can slip in), plus the teacher MCP and a small command entry.
//
//   node build-teacher-package.mjs [outDir]          build into dist/teacher-package (default)
//   node build-teacher-package.mjs [outDir] --pack   also run `npm pack` there, giving the tarball to `npm publish`
//
// The package version is the repository's VERSION file. CI builds this from a release tag, so the package is exactly what was tested.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_NAME = 'class-platform-teacher';
const here = dirname(fileURLToPath(import.meta.url));

// what goes into the package: whole folders (tracked files only) and single files
const FOLDERS = ['lambda', 'web', 'starter', 'student', 'installer'];
const FILES = ['template.yaml', 'admin.mjs', 'setup.mjs', 'portal-downloads.json', 'VERSION', 'CHANGELOG.md', 'docs/TEACHER_SETUP.md', 'docs/NEW_ACCOUNT_AND_TRANSFER.md'];
const SKIP = [/^starter\/eval\//, /(^|\/)__pycache__\//, /\.pyc$/, /\.local$/, /(^|\/)test_/];
const MCP = ['server.mjs', 'setup.mjs', 'jsonc.mjs']; // from teacher-mcp/, placed in mcp/

const tracked = (paths) => execFileSync('git', ['ls-files', '-z', '--', ...paths], { cwd: here, encoding: 'utf8' }).split('\0').filter(Boolean);

export function packageFiles() {
  const files = [...tracked(FOLDERS), ...FILES].filter((f) => !SKIP.some((re) => re.test(f)));
  return [...new Set(files)].sort();
}

export function buildTeacherPackage(outDir = join(here, 'dist', 'teacher-package'), { pack = false } = {}) {
  const out = resolve(outDir);
  rmSync(out, { recursive: true, force: true });
  const put = (from, to) => { mkdirSync(dirname(join(out, to)), { recursive: true }); copyFileSync(join(here, from), join(out, to)); };
  const files = packageFiles();
  for (const f of files) put(f, f);
  for (const f of MCP) put(join('teacher-mcp', f), join('mcp', f));
  put(join('teacher-package', 'bin.mjs'), 'bin.mjs');
  put(join('teacher-package', 'README.md'), 'README.md');
  writeFileSync(join(out, '.packaged'), 'This folder is the npm package: install state is kept in the home folder, not here.\n');
  const version = readFileSync(join(here, 'VERSION'), 'utf8').trim();
  writeFileSync(join(out, 'package.json'), `${JSON.stringify({
    name: PACKAGE_NAME, version, description: 'Install and update your own copy of the class hosting platform in your own AWS account with one command, plus MCP tools for your AI editor.',
    type: 'module', bin: { [PACKAGE_NAME]: 'bin.mjs' }, engines: { node: '>=20' }, license: 'MIT',
    files: ['*', '.packaged'], publishConfig: { access: 'public', provenance: true },
  }, null, 2)}\n`);
  let tarball = null;
  if (pack) {
    execFileSync('npm', ['pack', '--silent'], { cwd: out, shell: process.platform === 'win32' });
    tarball = `${PACKAGE_NAME}-${version}.tgz`;
  }
  return { out, version, files: files.length + MCP.length + 4, tarball };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const result = buildTeacherPackage(positional[0], { pack: process.argv.includes('--pack') });
  console.log(`Built ${PACKAGE_NAME} ${result.version} (${result.files} files) in ${result.out}${result.tarball ? `, tarball ${result.tarball}` : ''}`);
}
