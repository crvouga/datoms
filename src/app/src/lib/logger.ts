import pino from 'pino';
import type {Logger} from '../../../types';

/**
 * Creates a Pino-based logger that implements the Logger interface.
 * Configured for structured JSON logging with appropriate log levels.
 *
 * @param options - Optional Pino logger options
 * @returns A Logger instance compatible with the Logger interface
 */
export function createLogger(options?: pino.LoggerOptions): Logger {
  const pinoLogger = pino({
    level: process.env.LOG_LEVEL || 'info',
    ...options,
  });

  return {
    debug(message: string, meta?: Record<string, unknown>): void {
      pinoLogger.debug(meta || {}, message);
    },
    info(message: string, meta?: Record<string, unknown>): void {
      pinoLogger.info(meta || {}, message);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
      pinoLogger.warn(meta || {}, message);
    },
    error(message: string, meta?: Record<string, unknown>): void {
      pinoLogger.error(meta || {}, message);
    },
  };
}
