// @ts-expect-error - @babel/standalone doesn't have complete TypeScript definitions
import * as Babel from '@babel/standalone';
import {DEFAULT_EXECUTION_CONTEXT} from '../constants';

/**
 * Compiles TypeScript code to JavaScript using Babel
 * Note: Type safety is intentionally relaxed here due to @babel/standalone's incomplete TypeScript definitions
 * @param code - TypeScript source code
 * @returns Compiled JavaScript code
 * @throws Error if compilation fails
 */
export function compileTypeScript(code: string): string {
  // Wrap user code in an async function to handle top-level await
  const wrappedCode = `(async () => {\n${code}\n})()`;

  const result = Babel.transform(wrappedCode, {
    presets: [
      ['typescript', {isTSX: false, allExtensions: false}],
      ['env', {targets: {browsers: ['last 2 versions']}}],
    ],
    filename: 'code.ts',
  });

  if (!result.code) {
    throw new Error('Failed to compile TypeScript code');
  }
  const compiledCode = result.code as string;
  if (typeof compiledCode !== 'string') {
    throw new Error('Compiled code is not a string');
  }
  return compiledCode;
}

/**
 * Executes compiled JavaScript code in a sandboxed context
 * @param compiledCode - Compiled JavaScript code
 * @param context - Execution context (variables available to the code)
 * @returns Promise that resolves when execution completes
 * @throws Error if execution fails
 */
export async function executeCode(
  compiledCode: string,
  context: Record<string, unknown>,
): Promise<void> {
  // Merge default execution context with provided context
  const mergedContext = {
    ...DEFAULT_EXECUTION_CONTEXT,
    ...context,
  };

  // Execute the compiled code (wrapped in async IIFE, so it returns a Promise)
  // Note: Dynamic code execution is required for the code playground
  const executeCode = new Function(
    ...Object.keys(mergedContext),
    `
        try {
          const result = ${compiledCode};
          return result;
        } catch (e) {
          console.error('Execution error:', e);
          throw e;
        }
        `,
  );

  const executionResult = executeCode(...Object.values(mergedContext));

  // The wrapped code always returns a Promise, so await it
  await executionResult;
}
