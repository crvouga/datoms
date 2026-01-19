import Editor from "@monaco-editor/react";
import { useState } from "react";
import { Panel, PanelResizeHandle } from "react-resizable-panels";
import { db } from "../lib/db";
import {
  createLoggedDatabase,
  type DbCallLog,
} from "../../../src/datom-database/index";
import { TypeScriptEditor, type TypeDefinition } from "./TypeScriptEditor";
import { ResizablePanels } from "./ui/ResizablePanels";
// Type definitions from db-types.d.ts are automatically included via TypeScript

type OutputTab = "results" | "sql";

// Monaco Editor theme configuration with type safety
// Available themes: "vs", "vs-dark", "hc-black", "hc-light"
const MONACO_THEME: "vs" | "vs-dark" | "hc-black" | "hc-light" = "hc-black";

// LocalStorage keys for persistence
const STORAGE_KEY_SAVED_QUERY = "query-editor-saved-query";

// Type definitions for the db instance (used by Monaco IntelliSense)
const DB_TYPE_DEFINITIONS: TypeDefinition[] = [
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
];

const DEFAULT_QUERY = `
await db.query({
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

await db.query({
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
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>("results");
  const [sqlQuery, setSqlQuery] = useState<string | null>(null);
  const [dbCallLogs, setDbCallLogs] = useState<DbCallLog[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  const handleExecuteError = (err: Error) => {
    const errorMessage = err.message;
    setError(errorMessage);
    console.error("Code execution error:", err);
  };

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
              <TypeScriptEditor
                typeDefinitions={DB_TYPE_DEFINITIONS}
                executionContext={() => {
                  // Create a logged database wrapper for each execution
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
                  return { db: loggedDb };
                }}
                defaultValue={DEFAULT_QUERY}
                storageKey={STORAGE_KEY_SAVED_QUERY}
                onExecuteStart={() => {
                  setLoading(true);
                  setError(null);
                  setLatency(null);
                  setSqlQuery(null);
                  setDbCallLogs([]);
                  setActiveTab("results");
                }}
                onExecuteComplete={(duration) => {
                  setLatency(duration);
                  setLoading(false);
                }}
                onExecuteError={handleExecuteError}
                title="TypeScript Query"
                runButtonLabel="Run Code"
                saveButtonLabel="Save"
                showShortcutsHelp={true}
                theme={MONACO_THEME}
              />
            </Panel>

            <PanelResizeHandle className="w-2 bg-gray-800 hover:bg-gray-700 transition-colors cursor-col-resize" />

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
