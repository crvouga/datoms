import Editor from "@monaco-editor/react";
// @ts-expect-error - @babel/standalone doesn't have complete TypeScript definitions
import * as Babel from "@babel/standalone";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { db } from "../lib/db";
// Type definitions from db-types.d.ts are automatically included via TypeScript

type OutputTab = "results" | "sql";

// Simple keyboard shortcut display component
const KeyboardShortcut = ({ keys }: { keys: string[] }) => {
  const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const modifierKey = isMac ? "⌘" : "Ctrl";

  return (
    <span className="flex items-center gap-1 text-xs text-gray-400">
      {keys.map((key, index) => (
        <span key={index} className="flex items-center gap-1">
          {index > 0 && <span className="text-gray-500">+</span>}
          {key === "mod" ? (
            <kbd className="px-1.5 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs font-mono">
              {modifierKey}
            </kbd>
          ) : (
            <kbd className="px-1.5 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs font-mono">
              {key}
            </kbd>
          )}
        </span>
      ))}
    </span>
  );
};

// Simple icon components using SVG
const PlayIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const SaveIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"
    />
  </svg>
);

const HelpIcon = ({ className }: { className?: string }) => (
  <svg
    className={className}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

interface DbCallLog {
  id: number;
  timestamp: number;
  method: string;
  args: unknown[];
  result?: unknown;
  error?: string;
  duration: number;
}

// Monaco Editor theme configuration with type safety
// Available themes: "vs", "vs-dark", "hc-black", "hc-light"
const MONACO_THEME: "vs" | "vs-dark" | "hc-black" | "hc-light" = "hc-black";

// LocalStorage keys for persistence
const STORAGE_KEY_PANEL_SIZES = "query-editor-panel-sizes";
const STORAGE_KEY_SAVED_QUERY = "query-editor-saved-query";

const DEFAULT_QUERY = `
const results = await db.query({
  find: {
    "movie/id": ["?movie/id"],
    "movie/title": ["?title"],
    "movie/popularity": ["?popularity"]
  },
  where: [
    { e: "?movie/id", a: "tmdb.movie/id", v: "?movie/id" },
    { e: "?movie/id", a: "tmdb.movie/title", v: "?title" },
    { e: "?movie/id", a: "tmdb.movie/popularity", v: "?popularity" }
  ],
  orderBy: [["?popularity", "desc"]],
  limit: 10
});

const results2 = await db.query({
  find: {
    "movie/id": ["?movie/id"],
    "movie/title": ["?title"],
    "movie/popularity": ["?popularity"]
  },
  where: [
    { e: "?movie/id", a: "tmdb.movie/id", v: "?movie/id" },
    { e: "?movie/id", a: "tmdb.movie/title", v: "?title" },
    { e: "?movie/id", a: "tmdb.movie/popularity", v: "?popularity" }
  ],
  orderBy: [["?popularity", "desc"]],
  limit: 10
});
`;

export function QueryEditor() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);
  const handleRunQueryRef = useRef<(() => Promise<void>) | undefined>(undefined);

  // Load saved panel sizes from localStorage
  const loadPanelSizes = (): [number, number] => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_PANEL_SIZES);
      if (saved) {
        const sizes = JSON.parse(saved) as number[];
        if (
          Array.isArray(sizes) &&
          sizes.length === 2 &&
          sizes.every((s) => typeof s === "number" && s > 0 && s < 100)
        ) {
          return [sizes[0]!, sizes[1]!];
        }
      }
    } catch {
      // Ignore errors, use defaults
    }
    return [75, 25]; // Default sizes
  };

  const [panelSizes, setPanelSizes] = useState<[number, number]>(loadPanelSizes);
  const [queryText, setQueryText] = useState<string>(DEFAULT_QUERY);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>("results");
  const [sqlQuery, setSqlQuery] = useState<string | null>(null);
  const [dbCallLogs, setDbCallLogs] = useState<DbCallLog[]>([]);
  const [saveNotification, setSaveNotification] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  // Configure Monaco Editor with TypeScript types
  useEffect(() => {
    if (monacoRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const monaco = monacoRef.current;

      // Add type definitions for the db instance
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        target: monaco.languages.typescript.ScriptTarget.ES2020,
        allowNonTsExtensions: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        module: monaco.languages.typescript.ModuleKind.ESNext,
        noEmit: true,
        esModuleInterop: true,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
        jsx: monaco.languages.typescript.JsxEmit.React,
        reactNamespace: "React",
        allowJs: true,
        typeRoots: ["node_modules/@types"],
      });

      // Add extra libs for better IntelliSense
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
      monaco.languages.typescript.typescriptDefaults.setExtraLibs([
        {
          content: `
declare const db: {
  query(query: {
    find: Record<string, string[]>;
    where: Array<{
      e: string | number;
      a: string;
      v?: string | number | boolean | null;
      tx?: number;
    }>;
    orderBy?: Array<[string, "asc" | "desc"]>;
    limit?: number;
  }): Promise<Array<Record<string, unknown>>>;
  
  datoms(options: {
    e?: string | number;
    a?: string;
    v?: unknown;
    tx?: number;
    op?: "assert" | "retract";
    limit?: number;
    offset?: number;
  }): Promise<Array<{
    e: string | number;
    a: string;
    v: unknown;
    tx: number;
    op: "assert" | "retract";
  }>>;
  
  transact(
    ops: Array<{
      op: "assert" | "retract";
      e: string | number;
      a: string;
      v: unknown;
    }>,
    metadata?: Record<string, unknown>,
    context?: Record<string, unknown>
  ): Promise<number>;
  
  initialize(): Promise<void>;
  close(): Promise<void>;
  getLatestTransaction(): Promise<number>;
  asOf(txId: number): typeof db;
  history(): typeof db;
  since(txId: number): typeof db;
  with(ops: Array<{
    op: "assert" | "retract";
    e: string | number;
    a: string;
    v: unknown;
  }>): Promise<{
    dbBefore: typeof db;
    dbAfter: typeof db;
    txData: Array<unknown>;
  }>;
};
          `,
          filePath: "file:///db.d.ts",
        },
      ]);
    }
  }, [monacoRef.current]);

  // Debug: Log when dbCallLogs changes
  useEffect(() => {
    console.log("[DB Call] State changed, logs count:", dbCallLogs.length);
  }, [dbCallLogs]);

  // Save panel sizes to localStorage when they change
  const handlePanelLayout = (sizes: number[]) => {
    if (sizes.length === 2) {
      const newSizes: [number, number] = [sizes[0]!, sizes[1]!];
      setPanelSizes(newSizes);
      try {
        localStorage.setItem(STORAGE_KEY_PANEL_SIZES, JSON.stringify(newSizes));
      } catch {
        // Ignore localStorage errors
      }
    }
  };

  // Save query to localStorage
  const handleSaveQuery = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY_SAVED_QUERY, queryText);
      setSaveNotification("Saved");
      // Clear notification after 2 seconds
      setTimeout(() => {
        setSaveNotification(null);
      }, 2000);
    } catch {
      setSaveNotification("Failed to save");
      setTimeout(() => {
        setSaveNotification(null);
      }, 2000);
    }
  }, [queryText]);

  // Load saved query on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_SAVED_QUERY);
      if (saved && saved.trim() !== "") {
        setQueryText(saved);
      }
    } catch {
      // Ignore errors, use default
    }
  }, []);



  const handleRunQuery = async () => {
    setLoading(true);
    setError(null);
    setLatency(null);
    setSqlQuery(null);
    setDbCallLogs([]);
    setActiveTab("results");

    const startTime = performance.now();
    let callIdCounter = 0;

    // Create a proxy wrapper around db to intercept all method calls
    const createLoggedDb = (originalDb: typeof db): typeof db => {
      return new Proxy(originalDb, {
        get(target, prop) {
          const methodName = String(prop);
          console.log(`[DB Call] Proxy get trap for: ${methodName}`);

          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const originalMethod = Reflect.get(target, prop);

          // Skip Symbol properties
          if (typeof prop === "symbol") {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return originalMethod;
          }

          // If it's not a function, return as-is (for properties like asOf, history, since)
          if (typeof originalMethod !== "function") {
            console.log(`[DB Call] Property ${methodName} is not a function, returning as-is`);
            // Handle special methods that return db instances (asOf, history, since)
            if (prop === "asOf" || prop === "history" || prop === "since") {
              return (...args: unknown[]) => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
                const method = originalMethod as any;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
                const dbInstance = method.apply(target, args);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                return createLoggedDb(dbInstance);
              };
            }
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            return originalMethod;
          }

          // Wrap function calls with logging
          console.log(`[DB Call] Wrapping function ${methodName}, original type:`, typeof originalMethod);
          const wrappedFunction = async (...args: unknown[]) => {
            const callId = callIdCounter++;
            const callStartTime = performance.now();
            const timestamp = Date.now();

            console.log(`[DB Call] Wrapped function CALLED for ${methodName}`, args);

            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
              const result = await (originalMethod as (...args: unknown[]) => Promise<unknown>).apply(target, args);
              const callEndTime = performance.now();
              const duration = callEndTime - callStartTime;

              const logEntry: DbCallLog = {
                id: callId,
                timestamp,
                method: methodName,
                args,
                result,
                duration,
              };

              console.log(`[DB Call] Created log entry:`, logEntry);

              // Use functional update to ensure we get the latest state
              setDbCallLogs((prev) => {
                const newLogs = [...prev, logEntry];
                console.log(`[DB Call] State update: prev length=${prev.length}, new length=${newLogs.length}`);
                return newLogs;
              });

              // If the result is a db instance (like asOf, history, since return), wrap it too
              if (result && typeof result === "object" && "query" in result) {
                return createLoggedDb(result as typeof db);
              }

              return result;
            } catch (err) {
              const callEndTime = performance.now();
              const duration = callEndTime - callStartTime;
              const errorMessage = err instanceof Error ? err.message : String(err);

              const logEntry: DbCallLog = {
                id: callId,
                timestamp,
                method: methodName,
                args,
                error: errorMessage,
                duration,
              };

              // Use functional update to ensure we get the latest state
              setDbCallLogs((prev) => {
                const newLogs = [...prev, logEntry];
                return newLogs;
              });

              throw err;
            }
          };

          // Add a property to help identify the wrapped function
          Object.defineProperty(wrappedFunction, 'name', { value: `${methodName}_logged`, writable: false });
          console.log(`[DB Call] Returning wrapped function for ${methodName}`);

          return wrappedFunction;
        },
      }) as typeof db;
    };

    try {
      // Transpile TypeScript to JavaScript using Babel
      let compiledCode: string;
      try {
        // Wrap user code in an async function to handle top-level await
        const wrappedCode = `(async () => {\n${queryText}\n})()`;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const result = Babel.transform(wrappedCode, {
          presets: [
            ["typescript", { isTSX: false, allExtensions: false }],
            ["env", { targets: { browsers: ["last 2 versions"] } }],
          ],
          filename: "query.ts",
        });

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        if (!result.code) {
          throw new Error("Failed to compile TypeScript code");
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        compiledCode = result.code;
      } catch (compileError: unknown) {
        const errorMessage =
          compileError instanceof Error
            ? compileError.message
            : String(compileError);
        throw new Error(`TypeScript compilation error: ${errorMessage}`);
      }

      // Create execution context with logged db instance
      const loggedDb = createLoggedDb(db);
      console.log(`[DB Call] Created loggedDb, testing access to query:`, typeof loggedDb.query);
      const executionContext = {
        db: loggedDb,
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

      // Execute the compiled code (wrapped in async IIFE, so it returns a Promise)
      console.log(`[DB Call] About to execute compiled code`);
      console.log(`[DB Call] Compiled code preview:`, compiledCode.substring(0, 200));

      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-assignment
      const executeCode = new Function(
        ...Object.keys(executionContext),
        `
        console.log('[DB Call] Inside execution context, db type:', typeof db);
        console.log('[DB Call] Inside execution context, db.query type:', typeof db?.query);
        console.log('[DB Call] About to execute:', ${JSON.stringify(compiledCode.substring(0, 100))});
        try {
          const result = ${compiledCode};
          console.log('[DB Call] Execution completed, result type:', typeof result);
          return result;
        } catch (e) {
          console.error('[DB Call] Execution error:', e);
          throw e;
        }
        `
      );

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      const executionResult = executeCode(...Object.values(executionContext));
      console.log(`[DB Call] Execution started, result type:`, typeof executionResult);

      // The wrapped code always returns a Promise, so await it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
      await executionResult;

      // SQL generation is skipped for TypeScript code execution
      // Users can manually generate SQL if needed

      const endTime = performance.now();
      const duration = endTime - startTime;

      setLatency(duration);
    } catch (err) {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLatency(duration);
      console.error("Code execution error:", err);
    } finally {
      setLoading(false);
    }
  };

  // Update ref with latest handleRunQuery function
  useEffect(() => {
    handleRunQueryRef.current = handleRunQuery;
  }, [handleRunQuery]);

  // Keyboard shortcuts handler
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Command (Mac) or Ctrl (Windows/Linux)
      const isModifierPressed = event.metaKey || event.ctrlKey;

      if (!isModifierPressed) return;

      // Command+Enter or Ctrl+Enter: Run query
      if (event.key === "Enter") {
        event.preventDefault();
        if (!loading && handleRunQueryRef.current) {
          handleRunQueryRef.current();
        }
      }

      // Command+S or Ctrl+S: Save query
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        handleSaveQuery();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [loading, handleSaveQuery]);

  const formatCallLog = (log: DbCallLog): string => {
    const timeStr = new Date(log.timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
    });

    const durationStr = log.duration < 1
      ? `${(log.duration * 1000).toFixed(2)}μs`
      : log.duration < 1000
        ? `${log.duration.toFixed(2)}ms`
        : `${(log.duration / 1000).toFixed(2)}s`;

    // Format arguments nicely
    const formatArgs = (args: unknown[]): string => {
      if (args.length === 0) return "";
      if (args.length === 1) {
        const argStr = JSON.stringify(args[0], null, 2);
        // If it's a single object argument, format it nicely
        if (typeof args[0] === "object" && args[0] !== null) {
          return argStr.split("\n").map((line, i) => i === 0 ? line : `  ${line}`).join("\n");
        }
        return argStr;
      }
      return args.map((arg, i) => {
        const argStr = JSON.stringify(arg, null, 2);
        if (typeof arg === "object" && arg !== null) {
          return `  ${i + 1}. ${argStr.split("\n").join("\n    ")}`;
        }
        return `  ${i + 1}. ${argStr}`;
      }).join("\n");
    };

    // Format result nicely
    const formatResult = (result: unknown): string => {
      if (result === null || result === undefined) {
        return String(result);
      }

      const resultStr = JSON.stringify(result, null, 2);
      const maxResultLength = 2000;

      if (resultStr.length > maxResultLength) {
        const truncated = resultStr.substring(0, maxResultLength);
        return `${truncated}...\n  (truncated, ${resultStr.length} chars total)`;
      }

      // Indent the result
      return resultStr.split("\n").map((line, i) => i === 0 ? line : `  ${line}`).join("\n");
    };

    let output = "";

    // Header with timestamp and method name
    output += `┌─ ${timeStr} ──────────────────────────────────────────────┐\n`;
    output += `│ Method: ${log.method.padEnd(50)} │\n`;
    output += `│ Duration: ${durationStr.padEnd(47)} │\n`;
    output += `└──────────────────────────────────────────────────────────┘\n\n`;

    // Arguments section
    if (log.args.length > 0) {
      output += `Arguments:\n`;
      const formattedArgs = formatArgs(log.args);
      output += formattedArgs.split("\n").map(line => `  ${line}`).join("\n");
      output += `\n\n`;
    }

    // Result or error section
    if (log.error) {
      output += `❌ Error:\n`;
      output += `  ${log.error.split("\n").join("\n  ")}\n`;
    } else {
      output += `✓ Result:\n`;
      const formattedResult = formatResult(log.result);
      output += `  ${formattedResult.split("\n").join("\n  ")}\n`;
    }

    // Add separator between calls
    output += `\n${"─".repeat(60)}\n\n`;

    return output;
  };

  return (
    <div className="h-screen w-screen overflow-hidden">
      <PanelGroup
        direction="horizontal"
        onLayout={handlePanelLayout}
      >
        {/* Editor Section */}
        <Panel defaultSize={panelSizes[0]} minSize={30} className="flex flex-col">
          <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-900">
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold">TypeScript Query</h2>
              <button
                onClick={() => setShowShortcuts(!showShortcuts)}
                className="p-1.5 text-gray-400 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
                title="Show keyboard shortcuts"
              >
                <HelpIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex items-center gap-3">
              {saveNotification && (
                <span className="text-sm text-green-400 font-medium animate-pulse">
                  {saveNotification}
                </span>
              )}
              <button
                onClick={handleSaveQuery}
                className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors text-sm"
                title="Save query"
              >
                <SaveIcon className="w-4 h-4" />
                <span>Save</span>
                <KeyboardShortcut keys={["mod", "S"]} />
              </button>
              <button
                onClick={handleRunQuery}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
                title="Run code"
              >
                <PlayIcon className="w-4 h-4" />
                <span>{loading ? "Running..." : "Run Code"}</span>
                <KeyboardShortcut keys={["mod", "Enter"]} />
              </button>
            </div>
          </div>
          {showShortcuts && (
            <div className="p-3 bg-gray-800 border-b border-gray-700">
              <div className="text-sm text-gray-300 space-y-2">
                <div className="font-semibold text-gray-200 mb-2">Keyboard Shortcuts:</div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Run Code</span>
                  <KeyboardShortcut keys={["mod", "Enter"]} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-gray-400">Save Query</span>
                  <KeyboardShortcut keys={["mod", "S"]} />
                </div>
              </div>
            </div>
          )}
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              defaultLanguage="typescript"
              value={queryText}
              onChange={(value) => setQueryText(value || "")}
              theme={MONACO_THEME}
              onMount={(editor, monaco) => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                editorRef.current = editor;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                monacoRef.current = monaco;
              }}
              options={{
                minimap: { enabled: false },
                fontSize: 18,
                wordWrap: "off",
                automaticLayout: true,
                lineHeight: 26,
                padding: { top: 20, bottom: 20 },
                scrollBeyondLastLine: false,
                renderWhitespace: "selection",
                tabSize: 2,
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                parameterHints: { enabled: true },
                hover: { enabled: true },
                formatOnPaste: true,
                formatOnType: true,
              }}
            />
          </div>
        </Panel>

        <PanelResizeHandle className="w-2 bg-gray-800 hover:bg-gray-700 transition-colors cursor-col-resize" />

        {/* Output Section */}
        <Panel defaultSize={panelSizes[1]} minSize={20} className="flex flex-col">
          <div className="border-b border-gray-700 bg-gray-900">
            <div className="flex items-center justify-between p-2 border-b border-gray-700">
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setActiveTab("results")}
                  className={`px-3 py-1 text-sm font-medium rounded transition-colors ${activeTab === "results"
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-gray-300"
                    }`}
                >
                  DB Calls {dbCallLogs.length > 0 ? `(${dbCallLogs.length})` : ""}
                </button>
                <button
                  onClick={() => setActiveTab("sql")}
                  className={`px-3 py-1 text-sm font-medium rounded transition-colors ${activeTab === "sql"
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-gray-300"
                    }`}
                >
                  PostgreSQL
                </button>
              </div>
              {latency !== null && (
                <div className="text-sm text-gray-400 font-mono">
                  {latency < 1
                    ? `${(latency * 1000).toFixed(2)}μs`
                    : latency < 1000
                      ? `${latency.toFixed(2)}ms`
                      : `${(latency / 1000).toFixed(2)}s`}
                </div>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-auto">
            {activeTab === "results" && (
              <>
                {error && (
                  <div className="p-4 bg-red-900/20 border-l-4 border-red-500">
                    <div className="font-semibold text-red-400 mb-1">Error</div>
                    <div className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                      {error}
                    </div>
                  </div>
                )}
                {dbCallLogs.length > 0 && (
                  <div className="h-full flex flex-col">
                    <div className="p-2 text-xs text-gray-400 border-b border-gray-700">
                      {dbCallLogs.length} DB call{dbCallLogs.length !== 1 ? "s" : ""} logged
                    </div>
                    <div className="flex-1 min-h-0">
                      <Editor
                        key={`db-calls-${dbCallLogs.length}`}
                        height="100%"
                        defaultLanguage="plaintext"
                        value={dbCallLogs.map(formatCallLog).join("\n")}
                        theme={MONACO_THEME}
                        options={{
                          minimap: { enabled: false },
                          fontSize: 14,
                          wordWrap: "on",
                          automaticLayout: true,
                          lineHeight: 20,
                          padding: { top: 16, bottom: 16 },
                          scrollBeyondLastLine: false,
                          readOnly: true,
                          formatOnPaste: true,
                          formatOnType: true,
                        }}
                      />
                    </div>
                  </div>
                )}
                {dbCallLogs.length === 0 && !error && !loading && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Click "Run Code" to see DB call logs
                  </div>
                )}
                {loading && dbCallLogs.length === 0 && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Running code...
                  </div>
                )}
              </>
            )}
            {activeTab === "sql" && (
              <div className="h-full">
                {sqlQuery ? (
                  <Editor
                    height="100%"
                    defaultLanguage="sql"
                    value={sqlQuery}
                    theme={MONACO_THEME}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 14,
                      wordWrap: "on",
                      automaticLayout: true,
                      lineHeight: 20,
                      padding: { top: 16, bottom: 16 },
                      scrollBeyondLastLine: false,
                      readOnly: true,
                      formatOnPaste: true,
                      formatOnType: true,
                    }}
                  />
                ) : (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    {loading
                      ? "Generating SQL..."
                      : "Run a query to see the generated PostgreSQL SQL"}
                  </div>
                )}
              </div>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
