// Real code-search evidence command for Counterpoint deliberations.
// Usage: node scripts/evidence-scan.mjs <pattern> [pattern...] -- <path> [path...]
// Prints a JSON summary and always exits 0 when scanning succeeds.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const separator = args.indexOf('--');
if (separator < 1) {
  console.error(JSON.stringify({ error: 'usage: evidence-scan.mjs <patterns...> -- <paths...>' }));
  process.exit(1);
}
const patterns = args.slice(0, separator);
const roots = args.slice(separator + 1);
const IGNORED = new Set(['node_modules', '.git', 'dist', '.vite', 'coverage', '.tmp-tscheck']);

function collectFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          if (statSync(full).size > 2 * 1024 * 1024) continue;
          files.push(full);
        } catch {
          // unreadable files are skipped
        }
      }
    }
  }
  return files;
}

const matches = {};
let totalMatches = 0;
for (const pattern of patterns) {
  const lower = pattern.toLowerCase();
  const hits = [];
  for (const root of roots) {
    for (const file of collectFiles(root)) {
      try {
        const text = readFileSync(file, 'utf8');
        const count = text.toLowerCase().split(lower).length - 1;
        if (count > 0) hits.push({ file, count });
      } catch {
        // binary or unreadable files are skipped
      }
    }
  }
  matches[pattern] = hits;
  totalMatches += hits.length;
}
process.stdout.write(JSON.stringify({ patterns, roots, matches, totalMatches }, null, 2));
process.stdout.write('\n');
