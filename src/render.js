/**
 * render.js — turn a handler's return value into harness content blocks.
 *
 * Every tool declares `output.render(args, value)`; the harness calls it with
 * the exact value the handler returned (both sides pass through `cloneJson`,
 * so handlers must return plain JSON data — no class instances, no functions,
 * no `undefined` leaves).
 */

/** Largest rendered payload, in characters, before a truncation notice is added. */
export const DEFAULT_MAX_RENDER_BYTES = 200_000;

function stringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return `[unserializable result: ${error?.message ?? error}]`;
  }
}

function truncate(text, limit) {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  const omitted = text.length - limit;
  return `${text.slice(0, limit)}\n\n… [truncated ${omitted} characters]`;
}

/**
 * Render a handler result as a single text block of pretty-printed JSON.
 * @param {unknown} args  the tool arguments (unused; kept for the render contract)
 * @param {unknown} value the handler's return value
 * @param {object} [options] `{ maxBytes }`
 */
export function renderOutput(args, value, options = {}) {
  void args;
  const limit = options.maxBytes ?? DEFAULT_MAX_RENDER_BYTES;
  if (value === undefined || value === null) return [{ type: 'text', text: '(no content)' }];
  if (typeof value === 'string') return [{ type: 'text', text: truncate(value, limit) }];
  return [{ type: 'text', text: truncate(stringify(value), limit) }];
}

/** Render an already-formatted string. */
export function renderText(text) {
  return [{ type: 'text', text: String(text) }];
}

export { stringify, truncate };
