// @ts-expect-error - @babel/standalone doesn't have complete TypeScript definitions
import * as Babel from "@babel/standalone";
import { DEFAULT_EXECUTION_CONTEXT } from "../constants";

/**
 * Compiles TypeScript code to JavaScript using Babel
 * @param code - TypeScript source code
 * @returns Compiled JavaScript code
 * @throws Error if compilation fails
 */
export function compileTypeScript(code: string): string {
  // Wrap user code in an async function to handle top-level await
  const wrappedCode = `(async () => {\n${code}\n})()`;

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
  const result = Babel.transform(wrappedCode, {
    presets: [
      ["typescript", { isTSX: false, allExtensions: false }],
      ["env", { targets: { browsers: ["last 2 versions"] } }],
    ],
    filename: "code.ts",
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (!result.code) {
    throw new Error("Failed to compile TypeScript code");
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
  const compiledCode = result.code as string;
  if (typeof compiledCode !== "string") {
    throw new Error("Compiled code is not a string");
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
  context: Record<string, unknown>
): Promise<void> {
  // Merge default execution context with provided context
  const mergedContext = {
    ...DEFAULT_EXECUTION_CONTEXT,
    ...context,
  };

  // Execute the compiled code (wrapped in async IIFE, so it returns a Promise)
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-assignment
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
        `
  );

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const executionResult = executeCode(...Object.values(mergedContext));

  // The wrapped code always returns a Promise, so await it
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  await executionResult;
}
