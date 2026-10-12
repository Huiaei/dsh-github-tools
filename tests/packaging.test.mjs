/**
 * Packaging checks: the bundle manifest, the Cordis patch, the locale files and
 * the display icon are what make this repo installable, and the harness validates
 * them at install time. None of them is exercised by the handler tests.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import yaml from 'js-yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(readFileSync(join(ROOT, relative), 'utf8'));
const manifest = readJson('package.json');

test('the package manifest describes a Cordis bundle', () => {
  assert.equal(manifest.name, 'dsh-github-tools');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.ok(manifest.description.length > 40);
  assert.ok(manifest.engines?.node);
  assert.ok(manifest.engines?.dsh);
  assert.equal(manifest.exports['.'], './src/index.js');
});

test('the bundle entry point exists', () => {
  assert.ok(existsSync(join(ROOT, manifest.main)), `missing ${manifest.main}`);
  assert.ok(existsSync(join(ROOT, manifest.exports['.'])));
});

test('the harness packages are declared as optional peers', () => {
  for (const name of ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery']) {
    assert.ok(manifest.peerDependencies?.[name], `${name} must be a peer dependency`);
    assert.equal(manifest.peerDependenciesMeta?.[name]?.optional, true, `${name} must be an optional peer`);
  }
});

test('every path listed in "files" exists', () => {
  for (const entry of manifest.files) {
    assert.ok(existsSync(join(ROOT, entry)), `files entry does not exist: ${entry}`);
  }
});

test('the Cordis patch parses and inserts exactly one row', () => {
  const patch = yaml.load(readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8'));
  assert.ok(Array.isArray(patch), 'the patch must be a list of operations');
  const inserts = patch.filter((operation) => operation?.insert);
  assert.equal(inserts.length, 1);
  const rows = inserts[0].insert;
  assert.ok(Array.isArray(rows) && rows.length === 1, 'exactly one plugin row');
  const row = rows[0];
  assert.equal(row.id, 'github-tools');
  assert.equal(typeof row.name, 'string');
  assert.ok(row.config && typeof row.config === 'object', 'the row must carry a config block');
  assert.deepEqual(Object.keys(row.config).sort(), ['readOnly', 'token', 'toolsets']);
});

test('the patch row addresses the package by its bare name', () => {
  const patch = yaml.load(readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8'));
  const row = patch.find((operation) => operation?.insert).insert[0];
  // `dsh-client-modules` attaches a package's browser half to the Loader row whose
  // specifier is the bare package name; a relative path would leave the row
  // configuration page unregistered even though the Host half still loads.
  assert.equal(row.name, manifest.name, 'the row must name the package, not a path');
});

test('the browser half is declared and follows the shipped bundle format', () => {
  assert.equal(manifest.exports['./client'], './client/index.js');
  assert.equal(manifest.dsh.client?.platform, 'web');
  const source = readFileSync(join(ROOT, manifest.exports['./client']), 'utf8');
  // The page loads it as a script: no ESM syntax, one ModuleLoader wrapper.
  assert.doesNotMatch(source, /^\s*(import|export)\s/m, 'the browser half must not use ESM syntax');
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, new RegExp(`id: '${manifest.name}'`));
  assert.match(source, /exports\.apply = apply/);
  assert.match(source, /require\('react'\)/);
  const row = yaml.load(readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8')).find((operation) => operation?.insert).insert[0];
  // The `plugins.row.config` key is `<package name>#<row id>` (ui-plugin-manager's
  // rowConfigKey), and the configForms scope is addressed by the Loader row id.
  assert.match(source, new RegExp(`SLOT_KEY = '${manifest.name}#${row.id}'`));
  assert.match(source, new RegExp(`CONFIG_ROW_ID = '${row.id}'`));
});

test('the plugin config keys match the declared Config schema', () => {
  const patch = yaml.load(readFileSync(join(ROOT, manifest.dsh.bundle.patch), 'utf8'));
  const config = patch.find((operation) => operation?.insert).insert[0].config;
  const source = readFileSync(join(ROOT, 'src/index.js'), 'utf8');
  const block = source.slice(source.indexOf('export const Config'), source.indexOf('const DEFAULTS'));
  for (const key of Object.keys(config)) {
    assert.match(block, new RegExp(`\\b${key}:`), `Config does not declare "${key}"`);
  }
});

test('the locale files carry display metadata for the plugin list', () => {
  for (const locale of ['en', 'zh']) {
    const messages = readJson(`locale/${locale}.json`);
    assert.equal(typeof messages.meta?.title, 'string', `${locale}: meta.title`);
    assert.ok(messages.meta.title.length > 0);
    assert.equal(typeof messages.meta?.description, 'string', `${locale}: meta.description`);
    assert.ok(messages.meta.description.length > 10);
  }
});

test('the display icon is a small local SVG', () => {
  assert.equal(manifest.icon, './icon.svg');
  const path = join(ROOT, manifest.icon);
  const stats = statSync(path);
  assert.ok(stats.size <= 256 * 1024, 'icons must be at most 256 KiB');
  const svg = readFileSync(path, 'utf8');
  assert.match(svg, /^<svg[\s>]/, 'must be an SVG document');
  assert.doesNotMatch(svg, /<script|href=|url\(/i, 'the icon must not reference anything external');
});

test('the generated inventory is present and self-describing', () => {
  const tools = readJson('src/generated/tools.json');
  assert.equal(tools.source, 'github/github-mcp-server');
  assert.equal(tools.generatedFrom, 'pkg/github/__toolsnaps__');
  assert.equal(tools.tools.length, 131);
  const toolsets = readJson('src/generated/toolsets.json');
  assert.ok(toolsets.toolsets.length > 0);
});

test('the documentation set is complete', () => {
  for (const file of ['README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE', 'docs/HANDLER-CONTRACT.md', 'docs/TOOLS.md']) {
    assert.ok(existsSync(join(ROOT, file)), `missing ${file}`);
  }
});
