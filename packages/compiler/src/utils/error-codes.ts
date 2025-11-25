/**
 * Znight compiler error codes
 */
export enum ErrorCode {
  /** Missing provider - required dependency not found */
  ZNIGHT001 = 'ZNIGHT001',

  /** Circular dependency detected in dependency graph */
  ZNIGHT002 = 'ZNIGHT002',

  /** Scope mismatch - singleton depends on request/transient */
  ZNIGHT003 = 'ZNIGHT003',

  /** Duplicate provider - same name without @Primary */
  ZNIGHT004 = 'ZNIGHT004',

  /** Invalid decorator usage */
  ZNIGHT005 = 'ZNIGHT005',

  /** Missing required config */
  ZNIGHT006 = 'ZNIGHT006',

  /** Invalid route definition */
  ZNIGHT007 = 'ZNIGHT007',

  /** Ambiguous injection - multiple candidates without @Primary */
  ZNIGHT008 = 'ZNIGHT008',

  /** Invalid lifecycle hook signature */
  ZNIGHT009 = 'ZNIGHT009',
}

export interface SourceLocation {
  filePath: string;
  line: number;
  column: number;
}

export interface CompilerError {
  code: ErrorCode;
  message: string;
  location?: SourceLocation;
  suggestions?: string[];
}
