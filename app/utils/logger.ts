export type LogLevel = 'debug' | 'verbose' | 'info' | 'warn' | 'error';

export interface LoggerOptions {
  level?: LogLevel;
  prefix?: string;
  timestamps?: boolean;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  verbose: 1,
  info: 2,
  warn: 3,
  error: 4,
};

const LOG_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // Gray
  verbose: '\x1b[94m', // Light blue
  info: '\x1b[36m', // Cyan
  warn: '\x1b[33m', // Yellow
  error: '\x1b[31m', // Red
};

const RESET = '\x1b[0m';

/**
 * Simple logger with levels and optional file output
 */
export class Logger {
  private level: LogLevel;
  private prefix: string;
  private timestamps: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level || 'info';
    this.prefix = options.prefix || '';
    this.timestamps = options.timestamps ?? true;
  }

  /**
   * Format a log message
   */
  private format(level: LogLevel, ...args: unknown[]): string {
    const parts: string[] = [];

    if (this.timestamps) {
      parts.push(`[${new Date().toISOString()}]`);
    }

    parts.push(`[${level.toUpperCase()}]`);

    if (this.prefix) {
      parts.push(this.prefix);
    }

    const message = args
      .map((arg) => {
        if (arg instanceof Error) {
          return arg.stack || arg.message;
        }
        if (typeof arg === 'object') {
          return JSON.stringify(arg, null, 2);
        }
        return String(arg);
      })
      .join(' ');

    parts.push(message);

    return parts.join(' ');
  }

  /**
   * Log at a specific level
   */
  private log(level: LogLevel, ...args: unknown[]): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) {
      return;
    }

    const formatted = this.format(level, ...args);
    const color = LOG_COLORS[level];

    // Output to console with colors
    console.log(`${color}${formatted}${RESET}`);
  }

  debug(...args: unknown[]): void {
    this.log('debug', ...args);
  }

  verbose(...args: unknown[]): void {
    this.log('verbose', ...args);
  }

  info(...args: unknown[]): void {
    this.log('info', ...args);
  }

  warn(...args: unknown[]): void {
    this.log('warn', ...args);
  }

  error(...args: unknown[]): void {
    this.log('error', ...args);
  }

  /**
   * Set log level
   */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /**
   * Create a child logger with a new prefix
   */
  child(prefix: string): Logger {
    return new Logger({
      level: this.level,
      prefix: this.prefix ? `${this.prefix}${prefix}` : prefix,
      timestamps: this.timestamps,
    });
  }
}

// Default logger instance
export const logger = new Logger();
