import type { ProviderMetadata } from '../types.js';

/**
 * Performs topological sort on providers based on their dependencies
 * Returns providers in the order they should be instantiated
 */
export function topologicalSort(
  providers: Map<string, ProviderMetadata>,
): string[] {
  const sorted: string[] = [];
  const visited = new Set<string>();
  const temp = new Set<string>();

  function visit(name: string): void {
    if (temp.has(name)) {
      // Circular dependency - should have been caught by validator
      // But we'll handle it gracefully here
      return;
    }

    if (visited.has(name)) {
      return;
    }

    const provider = providers.get(name);
    if (!provider) {
      // Missing provider - should have been caught by validator
      return;
    }

    temp.add(name);

    // Visit all dependencies first
    for (const dep of provider.dependencies) {
      visit(dep);
    }

    temp.delete(name);
    visited.add(name);
    sorted.push(name);
  }

  // Visit all providers
  for (const name of providers.keys()) {
    if (!visited.has(name)) {
      visit(name);
    }
  }

  return sorted;
}
