import {useEffect, useState} from 'react';
import {Panel, PanelResizeHandle} from 'react-resizable-panels';
import {db} from '../lib/db';
import {DbCallLogList} from './DbCallLogList';
import {TypeScriptEditor, type TypeDefinition} from './TypeScriptEditor';
import {ResizablePanels} from './ui/ResizablePanels';
import {createLoggedDatabaseWithHooks} from './hooks/useDatabaseLogging';
import type {QueryEditorLog} from './types';
// Type definitions from db-types.d.ts are automatically included via TypeScript

// Monaco Editor theme configuration with type safety
// Available themes: "vs", "vs-dark", "hc-black", "hc-light"
const MONACO_THEME: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' = 'hc-black';

// LocalStorage keys for persistence
const STORAGE_KEY_SAVED_QUERY = 'query-editor-saved-query';
const STORAGE_KEY_DB_CALL_LOGS = 'query-editor-db-call-logs';

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
    filePath: 'file:///db.d.ts',
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

export function QueryPlayground() {
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [dbCallLogs, setDbCallLogs] = useState<QueryEditorLog[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Load logs from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DB_CALL_LOGS);
      if (saved) {
        const parsedLogs = JSON.parse(saved) as QueryEditorLog[];
        setDbCallLogs(parsedLogs);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save logs to localStorage whenever dbCallLogs changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_DB_CALL_LOGS, JSON.stringify(dbCallLogs));
    } catch {
      // Ignore localStorage errors
    }
  }, [dbCallLogs]);

  const handleExecuteError = (err: Error) => {
    const errorMessage = err.message;
    setError(errorMessage);
    console.error('Code execution error:', err);
  };

  const handleClearLogs = () => {
    setDbCallLogs([]);
    try {
      localStorage.removeItem(STORAGE_KEY_DB_CALL_LOGS);
    } catch {
      // Ignore localStorage errors
    }
  };

  return (
    <div className="h-screen w-screen overflow-hidden">
      <ResizablePanels
        storageKey="query-editor-panel-sizes"
        defaultSizes={[75, 25]}
        direction="horizontal"
      >
        {({panelSizes}) => (
          <>
            {/* Editor Section */}
            <Panel defaultSize={panelSizes[0]} minSize={30} className="flex flex-col">
              <TypeScriptEditor
                typeDefinitions={DB_TYPE_DEFINITIONS}
                executionContext={() => {
                  // Create a logged database using hooks API
                  const loggedDb = createLoggedDatabaseWithHooks(db, {
                    onLog: log => {
                      console.log(`[DB Call] Completed ${log.method} in ${log.duration}ms`);
                      // Use functional update to ensure we get the latest state
                      setDbCallLogs(prev => {
                        const newLogs = [...prev, log];
                        return newLogs;
                      });
                    },
                    onError: log => {
                      console.error(`[DB Call] Error in ${log.method}: ${log.error}`);
                      // Use functional update to ensure we get the latest state
                      setDbCallLogs(prev => {
                        const newLogs = [...prev, log];
                        return newLogs;
                      });
                    },
                  });
                  return {db: loggedDb};
                }}
                defaultValue={DEFAULT_QUERY}
                storageKey={STORAGE_KEY_SAVED_QUERY}
                onExecuteStart={() => {
                  setLoading(true);
                  setError(null);
                  setLatency(null);
                  setDbCallLogs([]);
                  try {
                    localStorage.removeItem(STORAGE_KEY_DB_CALL_LOGS);
                  } catch {
                    // Ignore localStorage errors
                  }
                }}
                onExecuteComplete={duration => {
                  setLatency(duration);
                  setLoading(false);
                }}
                onExecuteError={handleExecuteError}
                title="Datoms"
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
                  <div className="text-sm font-medium text-gray-300">
                    DB Calls {dbCallLogs.length > 0 ? `(${dbCallLogs.length})` : ''}
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
                {error && (
                  <div className="p-4 bg-red-900/20 border-l-4 border-red-500">
                    <div className="font-semibold text-red-400 mb-1">Error</div>
                    <div className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                      {error}
                    </div>
                  </div>
                )}
                {loading && dbCallLogs.length === 0 && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Running code...
                  </div>
                )}
                {!loading && <DbCallLogList logs={dbCallLogs} onClear={handleClearLogs} />}
              </div>
            </Panel>
          </>
        )}
      </ResizablePanels>
    </div>
  );
}
