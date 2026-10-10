#!/usr/bin/env node
// Teacher helper - manage student deploy keys (uses your local AWS CLI credentials).
//
//   node admin.mjs add alice bob     create keys and print what to send each student
//   node admin.mjs remove bob        revoke a key (site stays online)
//   node admin.mjs list              show students and their site URLs
//
// STACK_NAME (default "student-hosting") selects the deployed stack.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const STACK = process.env.STACK_NAME || 'student-hosting';
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,29}$/;
// Names that would clash with internal folders or subdomains you are likely to use yourself.
// Add your own (e.g. "bs") here; an existing explicit DNS record always wins over the wildcard.
const RESERVED = new Set(['sites', 'uploads', 'www', 'api', 'admin', 'mail', 'ftp', 'app', 'apps', 'static', 'assets', 'bs']);
const [command, ...names] = process.argv.slice(2);

const aws = (...args) => execFileSync('aws', [...args, '--output', 'json'], { encoding: 'utf8' });

const outputs = Object.fromEntries(
  JSON.parse(aws('cloudformation', 'describe-stacks', '--stack-name', STACK)).Stacks[0].Outputs.map((o) => [
    o.OutputKey,
    o.OutputValue,
  ]),
);
const param = outputs.KeysParameterName;
const siteUrl = (name) => outputs.SiteUrlPattern.replace('<student>', name);

const keys = JSON.parse(JSON.parse(aws('ssm', 'get-parameter', '--name', param)).Parameter.Value || '{}');
const save = () => aws('ssm', 'put-parameter', '--name', param, '--type', 'String', '--overwrite', '--value', JSON.stringify(keys));

if (command === 'add') {
  for (const name of names) {
    if (!NAME_RE.test(name) || RESERVED.has(name)) {
      console.error(`Skipping "${name}": use 1-30 lowercase letters, digits or "-" and not a reserved name.`);
      continue;
    }
    if (keys[name]) {
      console.log(`${name} already has a key (remove it first to rotate).`);
      continue;
    }
    keys[name] = randomBytes(12).toString('base64url');
    console.log(`\n--- send to ${name} ---\nDEPLOY_KEY=${name}.${keys[name]}\nSite: ${siteUrl(name)}`);
  }
  save();
} else if (command === 'remove') {
  for (const name of names) delete keys[name];
  save();
  console.log(`Removed: ${names.join(', ')} (takes effect within a minute)`);
} else if (command === 'list') {
  for (const name of Object.keys(keys).sort()) console.log(`${name.padEnd(20)} ${siteUrl(name)}`);
  console.log(`\n${Object.keys(keys).length} students, parameter uses ${JSON.stringify(keys).length}/4096 bytes`);
} else {
  console.log('Usage: node admin.mjs add <name...> | remove <name...> | list');
}
