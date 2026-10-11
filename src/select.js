/**
 * select.js — decide which of the 131 tools a profile activates.
 *
 * Mirrors the upstream server's semantics:
 *   - no `toolsets` given            → the toolsets flagged `default: true`
 *   - `toolsets: ['all']`            → every toolset
 *   - `toolsets: ['default', 'x']`   → the default set plus `x`
 *   - `tools` given                  → exactly those tool names, overriding toolsets
 *   - `excludeTools`                 → removed last
 *   - `readOnly: true`               → only tools whose upstream `readOnlyHint` is true
 */

const ALL = 'all';
const DEFAULT = 'default';

/**
 * @param {string[]|undefined} requested toolset ids from the config
 * @param {Array<{id: string, default: boolean}>} toolsets
 * @returns {Set<string>} the enabled toolset ids
 */
export function resolveToolsets(requested, toolsets) {
  const known = new Map(toolsets.map((entry) => [entry.id, entry]));
  const defaults = toolsets.filter((entry) => entry.default).map((entry) => entry.id);
  const list = Array.isArray(requested) ? requested.filter((id) => typeof id === 'string' && id.length > 0) : [];
  if (list.length === 0) return new Set(defaults);
  if (list.includes(ALL)) return new Set(known.keys());
  const enabled = new Set();
  for (const id of list) {
    if (id === DEFAULT) {
      for (const entry of defaults) enabled.add(entry);
      continue;
    }
    if (known.has(id)) enabled.add(id);
  }
  return enabled;
}

/**
 * @param {object} options
 * @param {Array<object>} options.definitions every generated tool definition
 * @param {Array<{id: string, default: boolean}>} options.toolsets
 * @param {object} options.config normalized plugin config
 * @returns {{ selected: Array<object>, enabledToolsets: string[], unknownToolsets: string[], unknownTools: string[], droppedByReadOnly: string[] }}
 */
export function selectTools({ definitions, toolsets, config = {} }) {
  const known = new Set(toolsets.map((entry) => entry.id));
  const requestedToolsets = Array.isArray(config.toolsets) ? config.toolsets.filter(Boolean) : [];
  const unknownToolsets = requestedToolsets.filter((id) => id !== ALL && id !== DEFAULT && !known.has(id));
  const enabledToolsets = resolveToolsets(requestedToolsets, toolsets);

  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const requestedTools = Array.isArray(config.tools) ? config.tools.filter(Boolean) : [];
  const unknownTools = requestedTools.filter((name) => !byName.has(name));

  let candidates;
  if (requestedTools.length > 0) {
    candidates = [];
    const seen = new Set();
    for (const name of requestedTools) {
      const definition = byName.get(name);
      if (definition && !seen.has(name)) {
        seen.add(name);
        candidates.push(definition);
      }
    }
  } else {
    candidates = definitions.filter((definition) => enabledToolsets.has(definition.toolset));
  }

  const excluded = new Set(Array.isArray(config.excludeTools) ? config.excludeTools : []);
  const droppedByReadOnly = [];
  const selected = [];
  for (const definition of candidates) {
    if (excluded.has(definition.name)) continue;
    if (config.readOnly === true && definition.annotations?.readOnlyHint !== true) {
      droppedByReadOnly.push(definition.name);
      continue;
    }
    selected.push(definition);
  }

  return {
    selected,
    enabledToolsets: [...enabledToolsets].sort(),
    unknownToolsets,
    unknownTools,
    droppedByReadOnly,
  };
}
