import type { ProviderMetadata } from '../types.js';
import { type CompilerError, ErrorCode } from '../utils/index.js';

/**
 * Validates the dependency graph for common errors
 */
export class DependencyValidator {
  private readonly providers: Map<string, ProviderMetadata>;
  private readonly errors: CompilerError[] = [];

  constructor(providers: Map<string, ProviderMetadata>) {
    this.providers = providers;
  }

  /**
   * Validates all dependencies and returns any errors found
   */
  validate(): CompilerError[] {
    this.errors.length = 0; // Clear previous errors

    // Validate all providers
    for (const provider of this.providers.values()) {
      this.validateProvider(provider);
    }

    // Check for circular dependencies
    this.detectCircularDependencies();

    return this.errors;
  }

  /**
   * Validates a single provider
   */
  private validateProvider(provider: ProviderMetadata): void {
    // Check for missing dependencies (ZNIGHT001)
    for (const dependency of provider.dependencies) {
      if (!this.providers.has(dependency)) {
        this.errors.push({
          code: ErrorCode.ZNIGHT001,
          message: `Missing provider '${dependency}' required by '${provider.name}'`,
          suggestions: [
            `Add @Injectable() decorator to '${dependency}' class`,
            'Ensure the dependency is in the scanned source files',
            'Check for typos in the dependency name',
          ],
        });
      }
    }

    // Check for scope mismatch (ZNIGHT003)
    this.validateScopeMismatch(provider);
  }

  /**
   * Validates that singleton providers don't depend on request/transient scoped providers
   */
  private validateScopeMismatch(provider: ProviderMetadata): void {
    if (provider.scope !== 'singleton') {
      return; // Only validate singleton providers
    }

    for (const depName of provider.dependencies) {
      const dependency = this.providers.get(depName);
      if (!dependency) {
        continue; // Already reported as missing
      }

      if (dependency.scope === 'request' || dependency.scope === 'transient') {
        this.errors.push({
          code: ErrorCode.ZNIGHT003,
          message: `Scope mismatch: singleton provider '${provider.name}' cannot depend on ${dependency.scope} provider '${depName}'`,
          suggestions: [
            `Change '${provider.name}' scope to '${dependency.scope}' or 'transient'`,
            `Change '${depName}' scope to 'singleton'`,
            'Consider using a factory pattern or async injection',
          ],
        });
      }
    }
  }

  /**
   * Detects circular dependencies using depth-first search (ZNIGHT002)
   */
  private detectCircularDependencies(): void {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    for (const providerName of this.providers.keys()) {
      if (!visited.has(providerName)) {
        this.dfs(providerName, visited, recursionStack, []);
      }
    }
  }

  /**
   * Depth-first search to detect cycles
   */
  private dfs(
    current: string,
    visited: Set<string>,
    recursionStack: Set<string>,
    path: string[],
  ): void {
    visited.add(current);
    recursionStack.add(current);
    path.push(current);

    const provider = this.providers.get(current);
    if (!provider) {
      recursionStack.delete(current);
      path.pop();
      return;
    }

    for (const dependency of provider.dependencies) {
      if (!this.providers.has(dependency)) {
        continue; // Skip missing dependencies (already reported)
      }

      if (!visited.has(dependency)) {
        this.dfs(dependency, visited, recursionStack, path);
      } else if (recursionStack.has(dependency)) {
        // Found a cycle!
        const cycleStart = path.indexOf(dependency);
        const cycle = [...path.slice(cycleStart), dependency];
        const cycleStr = cycle.join(' → ');

        this.errors.push({
          code: ErrorCode.ZNIGHT002,
          message: `Circular dependency detected: ${cycleStr}`,
          suggestions: [
            'Break the circular dependency by removing one of the dependencies',
            'Use lazy injection or factory pattern',
            'Consider refactoring to extract common logic into a separate service',
          ],
        });
      }
    }

    recursionStack.delete(current);
    path.pop();
  }

  /**
   * Checks for duplicate providers with same name (ZNIGHT004)
   */
  static checkDuplicates(
    providers: Map<string, ProviderMetadata>,
  ): CompilerError[] {
    const errors: CompilerError[] = [];
    const nameCount = new Map<string, number>();

    // Count occurrences
    for (const provider of providers.values()) {
      nameCount.set(provider.name, (nameCount.get(provider.name) || 0) + 1);
    }

    // Check for duplicates
    for (const [name, count] of nameCount.entries()) {
      if (count > 1) {
        const primaryCount = Array.from(providers.values()).filter(
          (p) => p.name === name && p.isPrimary,
        ).length;

        if (primaryCount === 0) {
          errors.push({
            code: ErrorCode.ZNIGHT004,
            message: `Duplicate provider '${name}' found ${count} times without @Primary decorator`,
            suggestions: [
              `Add @Primary() decorator to one of the '${name}' providers`,
              'Rename one of the providers to avoid ambiguity',
              'Use different class names',
            ],
          });
        } else if (primaryCount > 1) {
          errors.push({
            code: ErrorCode.ZNIGHT004,
            message: `Multiple providers named '${name}' marked as @Primary`,
            suggestions: [
              `Only one '${name}' provider should have @Primary decorator`,
              'Remove @Primary from all but one provider',
            ],
          });
        }
      }
    }

    return errors;
  }
}
