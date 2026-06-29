/**
 * Build step: copy each agent's in-sandbox runner (`src/lib/agents/<agent>/run.mjs`)
 * into the compiled output (`dist/lib/agents/<agent>/run.mjs`).
 *
 * `tsc` only emits .ts → .js; the `.mjs` runners are plain JS artifacts that ship
 * as-is and get read at runtime via `new URL('./run.mjs', import.meta.url)` next to
 * the compiled definition. So they must sit beside the compiled agent.js in dist.
 */

import { readdirSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src/lib/agents';
const OUT = 'dist/lib/agents';

let copied = 0;
for (const entry of readdirSync(SRC, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const runner = join(SRC, entry.name, 'run.mjs');
  if (!existsSync(runner)) continue;
  const destDir = join(OUT, entry.name);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(runner, join(destDir, 'run.mjs'));
  copied++;
}

console.log(`copy-runners: copied ${copied} run.mjs file(s) into ${OUT}`);
