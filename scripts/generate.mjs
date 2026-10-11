#!/usr/bin/env node
/**
 * generate.mjs — build src/generated/tools.json from the upstream Go repository.
 *
 * Sources of truth (read-only, upstream checkout):
 *   1. pkg/github/__toolsnaps__/*.snap   -> exact name / description / inputSchema / outputSchema / annotations
 *   2. pkg/github/*.go                   -> toolset membership + source function + source file
 *   3. pkg/github/tools.go               -> ToolsetMetadata (id / description / default / icon)
 *
 * Usage: node scripts/generate.mjs [path-to-github-mcp-server]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = process.argv[2] || '/tmp/gh-mcp';
const GH = join(SRC, 'pkg', 'github');
const SNAPS = join(GH, '__toolsnaps__');

/* ---------------------------------------------------------------- snapshots */

/** Read every .snap and fold them by tool name (output-schema snapshots share a name). */
function readSnaps() {
  const byName = new Map();
  const files = readdirSync(SNAPS).filter((f) => f.endsWith('.snap')).sort();
  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(SNAPS, file), 'utf8'));
    } catch (err) {
      throw new Error(`cannot parse ${file}: ${err.message}`);
    }
    const name = doc.name;
    if (!name) throw new Error(`${file} has no "name"`);
    const prev = byName.get(name) || { name, files: [] };
    prev.files.push(file.replace(/\.snap$/, ''));
    // A description snapshot always wins over an empty/absent one.
    if (doc.description) prev.description = doc.description;
    if (doc.annotations) prev.annotations = { ...(prev.annotations || {}), ...doc.annotations };
    if (doc.inputSchema && Object.keys(doc.inputSchema.properties || {}).length >=
        Object.keys(prev.inputSchema?.properties || {}).length) {
      prev.inputSchema = doc.inputSchema;
    }
    if (doc.outputSchema) prev.outputSchema = doc.outputSchema;
    if (doc._meta?.ui?.resourceUri) prev.uiResourceUri = doc._meta.ui.resourceUri;
    if (doc._meta?.ui?.visibility) prev.uiVisibility = doc._meta.ui.visibility;
    byName.set(name, prev);
  }
  return byName;
}

/* ------------------------------------------------------------------- Go side */

const goFiles = readdirSync(GH).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'));

/** ToolsetMetadataXxx = inventory.ToolsetMetadata{ ID: "...", Description: "...", Default: true, Icon: "..." } */
function readToolsets() {
  const text = readFileSync(join(GH, 'tools.go'), 'utf8');
  const out = new Map();
  const re = /(Toolset\w+)\s*=\s*inventory\.ToolsetMetadata\{([\s\S]*?)\n\t?\}/g;
  for (const m of text.matchAll(re)) {
    const body = m[2];
    const id = /ID:\s*"([^"]+)"/.exec(body)?.[1];
    if (!id) continue;
    out.set(m[1], {
      constant: m[1],
      id,
      description: /Description:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1]?.replace(/\\"/g, '"') ?? '',
      default: /Default:\s*true/.test(body),
      icon: /Icon:\s*"([^"]+)"/.exec(body)?.[1] ?? null,
    });
  }
  return out;
}

/** Split a Go file into top-level funcs: name -> body. */
function splitFuncs(text) {
  const funcs = new Map();
  const re = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm;
  const marks = [...text.matchAll(re)].map((m) => ({ name: m[1], at: m.index }));
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
    funcs.set(marks[i].name, text.slice(marks[i].at, end));
  }
  return funcs;
}

/** Walk the Go tree and attribute every known tool name to its declaring func + toolset. */
function readDeclarations(toolNames) {
  const decls = new Map();
  const perFile = [];
  for (const file of goFiles) {
    const text = readFileSync(join(GH, file), 'utf8');
    // file-scope string constants, so `Name: DeleteRepositoryToolName` still resolves
    const consts = new Map();
    for (const m of text.matchAll(/^\s*(\w+)\s*=\s*"([a-z0-9_]+)"\s*$/gm)) consts.set(m[1], m[2]);
    const funcs = splitFuncs(text);
    perFile.push({ file, funcs, consts });
    for (const [func, body] of funcs) {
      const named = [
        ...[...body.matchAll(/Name:\s*"([a-z0-9_]+)"/g)].map((m) => m[1]),
        ...[...body.matchAll(/Name:\s*([A-Z]\w+)/g)].map((m) => consts.get(m[1])).filter(Boolean),
      ];
      for (const name of named) {
        if (!toolNames.has(name) || decls.has(name)) continue;
        const tsConst = /(?:ToolsetMetadata|Toolset)\w+/.exec(body)?.[0] ?? null;
        decls.set(name, { sourceFile: `pkg/github/${file}`, sourceFunc: func, toolsetConstant: tsConst });
      }
    }
  }
  // Fallback for tools whose name is passed through a slice/loop: first func mentioning the literal.
  for (const name of toolNames) {
    if (decls.has(name)) continue;
    for (const { file, funcs, consts } of perFile) {
      const viaConst = [...consts.entries()].filter(([, v]) => v === name).map(([k]) => k);
      const hit = [...funcs.entries()].find(
        ([, body]) => body.includes(`"${name}"`) || viaConst.some((c) => body.includes(c)),
      );
      if (hit) {
        decls.set(name, {
          sourceFile: `pkg/github/${file}`,
          sourceFunc: hit[0],
          toolsetConstant: /(?:ToolsetMetadata|Toolset)\w+/.exec(hit[1])?.[0] ?? null,
        });
        break;
      }
    }
  }
  return decls;
}

/**
 * Tools built by shared helpers take their name from a slice/loop or a helper
 * parameter, so static attribution cannot see it. These 12 are attributed by
 * hand from the helper's own `toolset:` field / call site (verified by reading
 * pkg/github/comment_minimize.go, issues_granular.go, pullrequests_granular.go).
 */
const OVERRIDES = {
  hide_issue_comment: { toolset: 'issues', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  unhide_issue_comment: { toolset: 'issues', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  hide_pull_request_review: { toolset: 'pull_requests', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  unhide_pull_request_review: { toolset: 'pull_requests', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  hide_pull_request_review_comment: { toolset: 'pull_requests', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  unhide_pull_request_review_comment: { toolset: 'pull_requests', sourceFile: 'pkg/github/comment_minimize.go', sourceFunc: 'commentVisibilityTool' },
  update_issue_title: { toolset: 'issues', sourceFile: 'pkg/github/issues_granular.go', sourceFunc: 'GranularUpdateIssueTitle' },
  update_issue_body: { toolset: 'issues', sourceFile: 'pkg/github/issues_granular.go', sourceFunc: 'GranularUpdateIssueBody' },
  update_issue_milestone: { toolset: 'issues', sourceFile: 'pkg/github/issues_granular.go', sourceFunc: 'GranularUpdateIssueMilestone' },
  update_pull_request_title: { toolset: 'pull_requests', sourceFile: 'pkg/github/pullrequests_granular.go', sourceFunc: 'GranularUpdatePullRequestTitle' },
  update_pull_request_body: { toolset: 'pull_requests', sourceFile: 'pkg/github/pullrequests_granular.go', sourceFunc: 'GranularUpdatePullRequestBody' },
  update_pull_request_state: { toolset: 'pull_requests', sourceFile: 'pkg/github/pullrequests_granular.go', sourceFunc: 'GranularUpdatePullRequestState' },
};

/* ---------------------------------------------------------------------- main */

const toolsets = readToolsets();
const snaps = readSnaps();
const decls = readDeclarations(new Set(snaps.keys()));

const tools = [...snaps.values()]
  .map((t) => {
    const d = decls.get(t.name) || {};
    const o = OVERRIDES[t.name] || {};
    const ts = d.toolsetConstant ? toolsets.get(d.toolsetConstant) : undefined;
    return {
      name: t.name,
      toolset: o.toolset ?? ts?.id ?? null,
      toolsetConstant: d.toolsetConstant ?? null,
      sourceFunc: o.sourceFunc ?? d.sourceFunc ?? null,
      sourceFile: o.sourceFile ?? d.sourceFile ?? null,
      description: t.description ?? '',
      annotations: t.annotations ?? {},
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      outputSchema: t.outputSchema ?? null,
      uiResourceUri: t.uiResourceUri ?? null,
      snapFiles: t.files,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(join(ROOT, 'src', 'generated'), { recursive: true });
writeFileSync(
  join(ROOT, 'src', 'generated', 'tools.json'),
  JSON.stringify({ source: 'github/github-mcp-server', generatedFrom: 'pkg/github/__toolsnaps__', tools }, null, 2) + '\n',
);
writeFileSync(
  join(ROOT, 'src', 'generated', 'toolsets.json'),
  JSON.stringify({ toolsets: [...toolsets.values()] }, null, 2) + '\n',
);

/* ---------------------------------------------------------------- docs/TOOLS.md */

const tableCell = (value, limit = 120) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
};
const docs = [
  '# Tool inventory',
  '',
  `All ${tools.length} tools, grouped by toolset. Generated from \`github/github-mcp-server\``,
  '(`pkg/github/__toolsnaps__`) — regenerate with `node scripts/generate.mjs`.',
  '',
  '"read-only" is the upstream `readOnlyHint` annotation: with `readOnly: true` in the plugin',
  'config only those tools are registered.',
  '',
  '| tool | toolset | read-only | upstream source | description |',
  '| --- | --- | :---: | --- | --- |',
];
for (const t of [...tools].sort((a, b) => a.toolset.localeCompare(b.toolset) || a.name.localeCompare(b.name))) {
  const readOnly = t.annotations?.readOnlyHint === true ? 'yes' : '—';
  docs.push(`| \`${t.name}\` | \`${t.toolset}\` | ${readOnly} | \`${t.sourceFile}\` · \`${t.sourceFunc}\` | ${tableCell(t.description)} |`);
}
docs.push('', '## Toolsets', '', '| toolset | default | tools | description |', '| --- | :---: | ---: | --- |');
for (const toolset of toolsets.values()) {
  const count = tools.filter((t) => t.toolset === toolset.id).length;
  const isDefault = toolset.default ? 'yes' : '—';
  docs.push(`| \`${toolset.id}\` | ${isDefault} | ${count} | ${tableCell(toolset.description, 200)} |`);
}
mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(join(ROOT, 'docs', 'TOOLS.md'), `${docs.join('\n')}\n`);

/* ------------------------------------------------------------------- reports */

const noToolset = tools.filter((t) => !t.toolset).map((t) => t.name);
const noFunc = tools.filter((t) => !t.sourceFunc).map((t) => t.name);
const byToolset = {};
for (const t of tools) (byToolset[t.toolset ?? '(none)'] ||= []).push(t.name);

console.log(`tools: ${tools.length}  (snap files: ${readdirSync(SNAPS).length})`);
console.log(`toolsets: ${toolsets.size}`);
console.log('--- tools per toolset ---');
for (const [id, names] of Object.entries(byToolset).sort()) console.log(`${String(names.length).padStart(3)}  ${id}`);
if (noToolset.length) console.log(`\n!! no toolset (${noToolset.length}): ${noToolset.join(', ')}`);
if (noFunc.length) console.log(`\n!! no source func (${noFunc.length}): ${noFunc.join(', ')}`);
