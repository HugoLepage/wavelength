// Node ≥ 21 reads `node --test tests/` (the package.json `test` script) as one
// file path, which resolves to this index — so it loads every *.test.mjs in
// this folder. Plain `node --test` finds those files by itself and skips this.

import { readdirSync } from 'node:fs';

const dir = new URL('./', import.meta.url);
for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort()) {
  await import(new URL(file, dir).href);
}
