import {
  type ClassDeclaration,
  Node,
  type Project,
  type SourceFile,
} from 'ts-morph';
import type { LifecycleHook, ProviderMetadata, ProviderScope } from '../types.js';

/**
 * Analyzes TypeScript source files to extract @Injectable metadata
 */
export class InjectableAnalyzer {
  constructor(private readonly project: Project) {}

  /**
   * Analyzes all source files in the project and extracts provider metadata
   */
  analyze(): Map<string, ProviderMetadata> {
    const providers = new Map<string, ProviderMetadata>();

    // Get all source files (excluding node_modules)
    const sourceFiles = this.project.getSourceFiles([
      'src/**/*.ts',
      '!src/**/*.spec.ts',
      '!src/**/*.test.ts',
      '!node_modules/**',
    ]);

    for (const sourceFile of sourceFiles) {
      const fileProviders = this.analyzeSourceFile(sourceFile);
      for (const provider of fileProviders) {
        providers.set(provider.name, provider);
      }
    }

    return providers;
  }

  /**
   * Analyzes a single source file for @Injectable classes
   */
  private analyzeSourceFile(sourceFile: SourceFile): ProviderMetadata[] {
    const providers: ProviderMetadata[] = [];

    // Find all classes with @Injectable decorator
    const classes = sourceFile.getClasses();

    for (const classDecl of classes) {
      if (this.hasInjectableDecorator(classDecl)) {
        const metadata = this.extractProviderMetadata(classDecl, sourceFile);
        if (metadata) {
          providers.push(metadata);
        }
      }
    }

    return providers;
  }

  /**
   * Checks if a class has the @Injectable decorator
   */
  private hasInjectableDecorator(classDecl: ClassDeclaration): boolean {
    const decorators = classDecl.getDecorators();
    return decorators.some((decorator) => {
      const name = decorator.getName();
      return name === 'Injectable';
    });
  }

  /**
   * Extracts provider metadata from a class declaration
   */
  private extractProviderMetadata(
    classDecl: ClassDeclaration,
    sourceFile: SourceFile,
  ): ProviderMetadata | null {
    const name = classDecl.getName();
    if (!name) {
      return null;
    }

    // Extract scope from decorator arguments
    const scope = this.extractScope(classDecl);

    // Extract dependencies from constructor
    const dependencies = this.extractDependencies(classDecl);

    // Extract lifecycle hooks
    const lifecycle = this.extractLifecycleHooks(classDecl);

    // Check if marked as @Primary
    const isPrimary = this.hasPrimaryDecorator(classDecl);

    // Get import path relative to project root
    const importPath = this.getRelativeImportPath(sourceFile);

    return {
      name,
      importPath,
      scope,
      dependencies,
      lifecycle,
      isPrimary,
    };
  }

  /**
   * Extracts the scope from @Injectable decorator arguments
   */
  private extractScope(classDecl: ClassDeclaration): ProviderScope {
    const decorator = classDecl.getDecorator('Injectable');
    if (!decorator) {
      return 'singleton'; // Default scope
    }

    const args = decorator.getArguments();
    if (args.length === 0) {
      return 'singleton';
    }

    // First argument should be an object with scope property
    const arg = args[0];
    if (Node.isObjectLiteralExpression(arg)) {
      const scopeProp = arg.getProperty('scope');
      if (scopeProp && Node.isPropertyAssignment(scopeProp)) {
        const initializer = scopeProp.getInitializer();
        if (initializer && Node.isStringLiteral(initializer)) {
          const scopeValue = initializer.getLiteralValue();
          if (
            scopeValue === 'singleton' ||
            scopeValue === 'request' ||
            scopeValue === 'transient'
          ) {
            return scopeValue;
          }
        }
      }
    }

    return 'singleton';
  }

  /**
   * Extracts dependencies from constructor parameters
   */
  private extractDependencies(classDecl: ClassDeclaration): string[] {
    const constructors = classDecl.getConstructors();
    if (constructors.length === 0) {
      return [];
    }

    // Take the first constructor (TypeScript only allows one constructor)
    const constructor = constructors[0];
    const parameters = constructor.getParameters();

    return parameters.map((param) => {
      const type = param.getType();
      const symbol = type.getSymbol();

      // Get the type name (class name)
      if (symbol) {
        return symbol.getName();
      }

      // Fallback to type text
      return type.getText();
    });
  }

  /**
   * Extracts lifecycle hooks implemented by the class
   */
  private extractLifecycleHooks(classDecl: ClassDeclaration): LifecycleHook[] {
    const hooks: LifecycleHook[] = [];
    const methods = classDecl.getMethods();

    for (const method of methods) {
      const methodName = method.getName();
      if (
        methodName === 'onStart' ||
        methodName === 'onStop' ||
        methodName === 'onReady'
      ) {
        hooks.push(methodName);
      }
    }

    return hooks;
  }

  /**
   * Checks if class has @Primary decorator
   */
  private hasPrimaryDecorator(classDecl: ClassDeclaration): boolean {
    const decorators = classDecl.getDecorators();
    return decorators.some((decorator) => decorator.getName() === 'Primary');
  }

  /**
   * Gets the relative import path for a source file
   */
  private getRelativeImportPath(sourceFile: SourceFile): string {
    const filePath = sourceFile.getFilePath();
    // Remove the file extension and convert to relative path
    return filePath
      .replace(/\\/g, '/')
      .replace(/\.ts$/, '')
      .replace(/^.*\/src\//, './');
  }
}
