import { ClaudeProvider, type ClaudeProviderOptions } from './claude-provider.js';
import { DEMO_BEHAVIOR } from './demo-behavior.js';
import { FakeAgentProvider, type FakeProviderOptions } from './fake-provider.js';
import type { AgentProvider } from './types.js';

/**
 * Provider registry. Adding `OpenAIProvider` later means registering a factory
 * here and nothing else: no use case, UI or storage code changes (ADR-004).
 */
export type ProviderFactory = (options?: Record<string, unknown>) => AgentProvider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(id: string, factory: ProviderFactory): void {
  registry.set(id, factory);
}

export function createProvider(id: string, options?: Record<string, unknown>): AgentProvider {
  const factory = registry.get(id);
  if (!factory) {
    throw new Error(`Unknown provider "${id}". Available: ${[...registry.keys()].join(', ')}`);
  }
  return factory(options);
}

export function availableProviders(): string[] {
  return [...registry.keys()];
}

registerProvider('claude', (options) => new ClaudeProvider((options ?? {}) as ClaudeProviderOptions));

/**
 * `--provider fake` is the "try the product without spending anything" path, so
 * it ships the demo fixture by default — identically in the TUI and the Web.
 * Tests that want the minimal behaviour construct `FakeAgentProvider` directly.
 */
registerProvider('fake', (options) => {
  const opts = (options ?? {}) as FakeProviderOptions;
  return new FakeAgentProvider({ defaultBehavior: DEMO_BEHAVIOR, ...opts });
});
