import pc from 'picocolors';
import type { CompilerError, SourceLocation } from './error-codes.js';

/**
 * Formats a compiler error with colors and source location
 */
export function formatError(error: CompilerError): string {
  const lines: string[] = [];

  // Error header with code
  lines.push(`${pc.red('✗')} ${pc.bold(error.code)}: ${error.message}`);

  // Source location if available
  if (error.location) {
    lines.push(formatLocation(error.location));
  }

  // Suggestions if available
  if (error.suggestions && error.suggestions.length > 0) {
    lines.push('');
    lines.push(pc.cyan('💡 Suggestions:'));
    for (const suggestion of error.suggestions) {
      lines.push(`  ${pc.dim('•')} ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Formats a source location
 */
function formatLocation(location: SourceLocation): string {
  return `  ${pc.dim('→')} ${pc.cyan(location.filePath)}${pc.dim(':')}${pc.yellow(String(location.line))}${pc.dim(':')}${pc.yellow(String(location.column))}`;
}

/**
 * Formats multiple compiler errors
 */
export function formatErrors(errors: CompilerError[]): string {
  const lines: string[] = [];

  lines.push(''); // Empty line for spacing
  for (const error of errors) {
    lines.push(formatError(error));
    lines.push(''); // Empty line between errors
  }

  const count = errors.length;
  const plural = count === 1 ? 'error' : 'errors';
  lines.push(pc.red(`Build failed with ${count} ${plural}.`));

  return lines.join('\n');
}
