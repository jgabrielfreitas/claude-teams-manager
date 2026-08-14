#!/usr/bin/env node
/**
 * Launcher for the claude-team terminal interface.
 *
 * The workspace packages publish their TypeScript sources through their
 * `exports` map, so the app runs through `tsx`. A compiled `dist/main.js` is
 * used only as a fallback when tsx is not installed.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'main.tsx');
const compiled = join(here, '..', 'dist', 'main.js');

let registered = false;
try {
  const tsx = await import('tsx/esm/api');
  tsx.register();
  registered = true;
} catch {
  registered = false;
}

if (registered) {
  await import(pathToFileURL(source).href);
} else if (existsSync(compiled)) {
  await import(pathToFileURL(compiled).href);
} else {
  process.stderr.write(
    'claude-team needs tsx (pnpm install) or a build (pnpm --filter @claude-team/tui exec tsc -b).\n',
  );
  process.exit(1);
}
