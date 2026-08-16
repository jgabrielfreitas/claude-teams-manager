const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * The domain package is imported by the browser bundle as well as by Node, so
 * it uses the Web Crypto API available in both (Node 19+) rather than
 * `node:crypto`. Keeping the domain isomorphic is what lets the web client
 * share the same types, formatting and validation as the server (ADR-001).
 */
const webCrypto: Crypto = globalThis.crypto;

/**
 * Short, URL/filename-safe, sortable-ish identifier.
 * Prefixed so that an id is self-describing in logs and exports.
 */
export function newId(prefix: string): string {
  const bytes = webCrypto.getRandomValues(new Uint8Array(8));
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

export const ids = {
  team: () => newId('tm'),
  agent: () => newId('ag'),
  run: () => newId('run'),
  task: () => newId('tsk'),
  message: () => newId('msg'),
  event: () => newId('evt'),
  approval: () => newId('apr'),
  question: () => newId('qst'),
  uuid: () => webCrypto.randomUUID(),
};

/** Stable, human-friendly slug used for agent handles inside a team (`architect`, `backend-auth`). */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** Returns a slug not present in `taken`, appending -2, -3, ... as needed. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const root = slugify(base) || 'agent';
  if (!set.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`;
}
