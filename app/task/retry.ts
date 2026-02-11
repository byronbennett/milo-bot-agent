/**
 * Retry Logic
 *
 * Retry utilities with exponential backoff.
 */

import { logger } from '../utils/logger';

/**
 * Retry options
 */
export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryableErrors?: string[];
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryableErrors' | 'onRetry'>> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Calculate delay for a retry attempt with exponential backoff
 */
export function calculateBackoff(
  attempt: number,
  options: RetryOptions = {}
): number {
  const {
    initialDelayMs = DEFAULT_OPTIONS.initialDelayMs,
    maxDelayMs = DEFAULT_OPTIONS.maxDelayMs,
    backoffMultiplier = DEFAULT_OPTIONS.backoffMultiplier,
  } = options;

  // Exponential backoff with jitter
  const exponentialDelay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  const jitter = Math.random() * 0.1 * exponentialDelay; // 10% jitter
  const delay = Math.min(exponentialDelay + jitter, maxDelayMs);

  return Math.round(delay);
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: Error, retryableErrors?: string[]): boolean {
  // If no retryable errors specified, retry all errors
  if (!retryableErrors || retryableErrors.length === 0) {
    return true;
  }

  const errorMessage = error.message.toLowerCase();
  return retryableErrors.some(
    (pattern) => errorMessage.includes(pattern.toLowerCase())
  );
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a function with retry logic
 *
 * @param fn - The function to execute
 * @param options - Retry options
 * @returns The result of the function
 * @throws The last error if all retries fail
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = DEFAULT_OPTIONS.maxRetries,
    retryableErrors,
    onRetry,
  } = options;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we've exhausted retries
      if (attempt > maxRetries) {
        logger.error(`All ${maxRetries} retries exhausted:`, lastError.message);
        throw lastError;
      }

      // Check if error is retryable
      if (!isRetryableError(lastError, retryableErrors)) {
        logger.error('Non-retryable error:', lastError.message);
        throw lastError;
      }

      // Calculate delay and wait
      const delay = calculateBackoff(attempt, options);
      logger.warn(
        `Attempt ${attempt}/${maxRetries + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`
      );

      if (onRetry) {
        onRetry(attempt, lastError, delay);
      }

      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs this
  throw lastError ?? new Error('Unknown error');
}

/**
 * Create a retryable version of a function
 */
export function makeRetryable<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = {}
): T {
  return ((...args: Parameters<T>) => {
    return withRetry(() => fn(...args), options);
  }) as T;
}
