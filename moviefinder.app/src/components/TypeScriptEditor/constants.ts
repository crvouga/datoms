// Default execution context with standard globals
export const DEFAULT_EXECUTION_CONTEXT: Record<string, unknown> = {
  console: {
    log: (...args: unknown[]) => {
      console.log(...args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
    },
    warn: (...args: unknown[]) => {
      console.warn(...args);
    },
  },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  Promise,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Date,
  Math,
  Error,
};
