/**
 * generated/data.js — loads the generated tool inventory.
 *
 * `scripts/generate.mjs` extracts one definition per tool from the upstream
 * repository's `__toolsnaps__` (the authoritative serialization of every tool
 * the Go server exposes) and writes two JSON files next to this module.
 *
 * Loading through `createRequire` keeps the entry module a plain ESM import
 * while avoiding JSON import attributes, which not every host build enables.
 */

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const toolInventory = require('./tools.json');
const toolsetInventory = require('./toolsets.json');

/** @type {Array<object>} every upstream tool, normalized to a DSH definition. */
export const definitions = toolInventory.tools;

/** @type {Array<{constant: string, id: string, description: string, default: boolean, icon: string}>} */
export const toolsets = toolsetInventory.toolsets;

/** Provenance recorded by the generator: `{ source, generatedFrom }`. */
export const source = toolInventory.source ?? null;
export const generatedFrom = toolInventory.generatedFrom ?? null;
