import Editor from "@monaco-editor/react";
// @ts-expect-error - @babel/standalone doesn't have complete TypeScript definitions
import * as Babel from "@babel/standalone";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { db } from "../lib/db";
import { PlayIcon, SaveIcon, HelpIcon } from "./ui/icons";
import { KeyboardShortcut } from "./ui/KeyboardShortcut";
import { ResizablePanels } from "./ui/ResizablePanels";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";
import {
  createLoggedDatabase,
  type DbCallLog,
} from "../../../src/datom-database/index";
// Type definitions from db-types.d.ts are automatically included via TypeScript

type OutputTab = "results" | "sql";

// Monaco Editor theme configuration with type safety
// Available themes: "vs", "vs-dark", "hc-black", "hc-light"
const MONACO_THEME: "vs" | "vs-dark" | "hc-black" | "hc-light" = "hc-black";

// LocalStorage keys for persistence
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

    // Create a logged database wrapper using the library utility
    const loggedDb = createLoggedDatabase(db, {
      onCallStart: (method, args) => {
        console.log(`[DB Call] Calling ${method}`, args);
      },
      onCallComplete: (log) => {
        console.log(`[DB Call] Completed ${log.method} in ${log.duration}ms`);
        // Use functional update to ensure we get the latest state
        setDbCallLogs((prev) => {
          const newLogs = [...prev, log];
          console.log(`[DB Call] State update: prev length=${prev.length}, new length=${newLogs.length}`);
          return newLogs;
        });
      },
      onCallError: (log) => {
        console.error(`[DB Call] Error in ${log.method}: ${log.error}`);
        // Use functional update to ensure we get the latest state
        setDbCallLogs((prev) => {
          const newLogs = [...prev, log];
          return newLogs;
        });
      },
    });

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

      // Use the logged db instance created above
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

  // Keyboard shortcuts
  useKeyboardShortcut({
    keys: ["mod", "Enter"],
    callback: handleRunQuery,
    enabled: !loading,
  });

  useKeyboardShortcut({
    keys: ["mod", "S"],
    callback: handleSaveQuery,
  });

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
      <ResizablePanels
        storageKey="query-editor-panel-sizes"
        defaultSizes={[75, 25]}
        direction="horizontal"
      >
        {({ panelSizes }) => (
          <>
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
          </>
        )}
      </ResizablePanels>
    </div>
  );
}
