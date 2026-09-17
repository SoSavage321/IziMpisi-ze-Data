/**
 * Vendor /shared into supabase/functions/_shared/lib.
 *
 * Why this exists: the Supabase CLI bundles only what sits under
 * supabase/functions, so an edge function cannot reliably `import` from
 * ../../shared at deploy time. Rather than let the alarm rules drift into two
 * implementations, the canonical files live in /shared, are unit-tested there,
 * and are copied here verbatim.
 *
 * Run `npm run sync:shared` after editing anything in /shared. CI should run
 * it with --check, which fails if the copies are stale.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'shared');
const dest = join(root, 'supabase', 'functions', '_shared', 'lib');

const BANNER = `// GENERATED FILE — do not edit.
// Copied from /shared by scripts/sync-shared.mjs. Edit the original and run
// \`npm run sync:shared\`.

`;

const check = process.argv.includes('--check');
mkdirSync(dest, { recursive: true });

const files = readdirSync(src).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
let stale = [];

for (const file of files) {
  const body = BANNER + readFileSync(join(src, file), 'utf8');
  const target = join(dest, file);
  let current = null;
  try { current = readFileSync(target, 'utf8'); } catch { /* not there yet */ }

  if (current === body) continue;
  if (check) { stale.push(file); continue; }
  writeFileSync(target, body);
  console.log(`synced ${file}`);
}

if (check && stale.length) {
  console.error(`Stale vendored copies: ${stale.join(', ')}\nRun: npm run sync:shared`);
  process.exit(1);
}
if (check) console.log('vendored copies are up to date');
