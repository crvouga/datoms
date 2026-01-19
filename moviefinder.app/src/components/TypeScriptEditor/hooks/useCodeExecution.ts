import { useState } from "react";
import { compileTypeScript, executeCode } from "../utils/codeExecutor";
import type { TypeScriptEditorProps } from "../types";

export interface UseCodeExecutionReturn {
  handleRun: () => Promise<void>;
  loading: boolean;
  error: string | null;
  latency: number | null;
}

/**
 * Hook for managing code execution state and logic
 * @param code - TypeScript code to execute
 * @param executionContext - Execution context (variables available to the code)
 * @param onExecute - Custom execution handler (optional)
 * @param onExecuteStart - Callback when execution starts
 * @param onExecuteComplete - Callback when execution completes
 * @param onExecuteError - Callback when execution errors
 * @returns Object with handleRun function and execution state
 */
export function useCodeExecution(
  code: string,
  executionContext: TypeScriptEditorProps["executionContext"],
  onExecute: TypeScriptEditorProps["onExecute"],
  onExecuteStart: TypeScriptEditorProps["onExecuteStart"],
  onExecuteComplete: TypeScriptEditorProps["onExecuteComplete"],
  onExecuteError: TypeScriptEditorProps["onExecuteError"]
): UseCodeExecutionReturn {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);

  const handleRun = async () => {
    setLoading(true);
    setError(null);
    setLatency(null);

    const startTime = performance.now();

    // Call onExecuteStart callback if provided
    onExecuteStart?.();

    try {
      // If custom onExecute is provided, use it
      if (onExecute) {
        await onExecute(code);
        const endTime = performance.now();
        const duration = endTime - startTime;
        setLatency(duration);
        onExecuteComplete?.(duration);
        return;
      }

      // Otherwise, use default execution logic
      // Transpile TypeScript to JavaScript using Babel
      let compiledCode: string;
      try {
        compiledCode = compileTypeScript(code);
      } catch (compileError: unknown) {
        const errorMessage =
          compileError instanceof Error
            ? compileError.message
            : String(compileError);
        throw new Error(`TypeScript compilation error: ${errorMessage}`);
      }

      // Get execution context (call function if needed)
      const contextValue =
        typeof executionContext === "function"
          ? executionContext()
          : executionContext;

      // Execute the compiled code
      await executeCode(compiledCode, contextValue);

      const endTime = performance.now();
      const duration = endTime - startTime;

      setLatency(duration);
      onExecuteComplete?.(duration);
    } catch (err) {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLatency(duration);
      onExecuteError?.(err instanceof Error ? err : new Error(String(err)));
      console.error("Code execution error:", err);
    } finally {
      setLoading(false);
    }
  };

  return {
    handleRun,
    loading,
    error,
    latency,
  };
}
