/**
 * handlers/index.js — merges every handler module into one name → handler map.
 *
 * Each sibling module default-exports `{ [toolName]: handler }`. Handlers are
 * grouped by upstream source area (repos, issues, pull requests, …) so a tool's
 * implementation sits next to its neighbours and two authors never edit the
 * same file.
 *
 * A handler has the shape:
 *
 *   async function handler(args, ctx) → JSON-serializable result
 *
 * where `ctx` is `{ client, config, log, signal }`.
 */

import actions from './actions.js';
import context from './context.js';
import copilot from './copilot.js';
import discussions from './discussions.js';
import gists from './gists.js';
import governance from './governance.js';
import issuesGranular from './issues_granular.js';
import issues from './issues.js';
import labels from './labels.js';
import notifications from './notifications.js';
import prGranular from './pr_granular.js';
import pullRequests from './pull_requests.js';
import repos from './repos.js';
import security from './security.js';

/** Module order is irrelevant; every file owns a disjoint set of tool names. */
const modules = {
  'actions.js': actions,
  'context.js': context,
  'copilot.js': copilot,
  'discussions.js': discussions,
  'gists.js': gists,
  'governance.js': governance,
  'issues_granular.js': issuesGranular,
  'issues.js': issues,
  'labels.js': labels,
  'notifications.js': notifications,
  'pr_granular.js': prGranular,
  'pull_requests.js': pullRequests,
  'repos.js': repos,
  'security.js': security,
};

/** @type {Record<string, (args: object, ctx: object) => Promise<unknown>>} */
export const handlers = {};

/** @type {Record<string, string>} tool name → module file that implements it. */
export const handlerSources = {};

/** @type {Array<{name: string, files: string[]}>} */
export const duplicateHandlers = [];

for (const [file, map] of Object.entries(modules)) {
  if (map === null || typeof map !== 'object') continue;
  for (const [name, handler] of Object.entries(map)) {
    if (typeof handler !== 'function') continue;
    if (Object.hasOwn(handlers, name)) {
      const existing = duplicateHandlers.find((entry) => entry.name === name);
      if (existing) existing.files.push(file);
      else duplicateHandlers.push({ name, files: [handlerSources[name], file] });
      continue;
    }
    handlers[name] = handler;
    handlerSources[name] = file;
  }
}

export { modules };
