import Editor from "@monaco-editor/react";
import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { format } from "sql-formatter";
import { datalogToPostgresSQL } from "../../../src/datom-database/postgres/postgres-datom-database";
import type { DatalogQuery, QueryResult } from "../lib/db";
import { db } from "../lib/db";

type OutputTab = "results" | "sql";

// Monaco Editor theme configuration with type safety
// Available themes: "vs", "vs-dark", "hc-black", "hc-light"
const MONACO_THEME: "vs" | "vs-dark" | "hc-black" | "hc-light" = "hc-black";

// LocalStorage keys for persistence
const STORAGE_KEY_PANEL_SIZES = "query-editor-panel-sizes";

const DEFAULT_QUERY = `{
  "find": {
    "movie/id": ["?movie/id"],
    "movie/title": ["?title"],
    "movie/popularity": ["?popularity"]
  },
  "where": [
    { "e": "?movie/id", "a": "tmdb.movie/id", "v": "?id" },
    { "e": "?movie/id", "a": "tmdb.movie/title", "v": "?title" },
    { "e": "?movie/id", "a": "tmdb.movie/popularity", "v": "?popularity" }
  ],
  "orderBy": [["?popularity", "desc"]],
  "limit": 10
}`;

export function QueryEditor() {
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
  const [results, setResults] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>("results");
  const [sqlQuery, setSqlQuery] = useState<string | null>(null);

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

  const handleRunQuery = async () => {
    setLoading(true);
    setError(null);
    setResults(null);
    setLatency(null);
    setSqlQuery(null);
    setActiveTab("results");

    const startTime = performance.now();

    try {
      // Parse the query text as JSON
      const parsed: unknown = JSON.parse(queryText);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("find" in parsed) ||
        !("where" in parsed)
      ) {
        throw new Error("Invalid query format: must have 'find' and 'where' properties");
      }
      const query = parsed as DatalogQuery;

      // Generate PostgreSQL SQL query
      try {
        const tableName = "datoms"; // Default table name
        const { sql, params } = datalogToPostgresSQL(query, tableName);
        // Replace placeholders with parameter values
        let sqlWithParams = sql;
        params.forEach((param) => {
          const value =
            typeof param === "string"
              ? `'${param.replace(/'/g, "''")}'`
              : param === null
                ? "NULL"
                : String(param);
          sqlWithParams = sqlWithParams.replace("?", value);
        });
        // Format the SQL with proper indentation and line breaks
        try {
          const formattedSql: string = format(sqlWithParams, {
            language: "postgresql",
            tabWidth: 2,
            useTabs: false,
            keywordCase: "upper",
            functionCase: "upper",
            dataTypeCase: "upper",
            identifierCase: "lower",
            indentStyle: "standard",
            linesBetweenQueries: 2,
          });
          setSqlQuery(formattedSql);
        } catch (formatError: unknown) {
          // If formatting fails, use unformatted SQL
          const errorMessage =
            formatError instanceof Error
              ? formatError.message
              : String(formatError);
          console.warn("Failed to format SQL, using unformatted version:", errorMessage);
          setSqlQuery(sqlWithParams);
        }
      } catch (sqlError) {
        // If SQL generation fails, still try to execute the query
        const errorMessage =
          sqlError instanceof Error ? sqlError.message : String(sqlError);
        console.warn("Failed to generate SQL:", errorMessage);
        setSqlQuery(null);
      }

      // Execute the query
      const queryResults = await db.query(query);

      const endTime = performance.now();
      const duration = endTime - startTime;

      setResults(queryResults);
      setLatency(duration);
    } catch (err) {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      setLatency(duration);
      console.error("Query execution error:", err);
    } finally {
      setLoading(false);
    }
  };

  const formatResults = (results: QueryResult): string => {
    return JSON.stringify(results, null, 2);
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
            <h2 className="text-lg font-semibold">Datalog Query</h2>
            <button
              onClick={handleRunQuery}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
            >
              {loading ? "Running..." : "Run Query"}
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              height="100%"
              defaultLanguage="json"
              value={queryText}
              onChange={(value) => setQueryText(value || "")}
              theme={MONACO_THEME}
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
                  Results {results && `(${results.length})`}
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
                {results !== null && !error && (
                  <div className="h-full">
                    <Editor
                      height="100%"
                      defaultLanguage="json"
                      value={formatResults(results)}
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
                )}
                {results === null && !error && !loading && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Click "Run Query" to execute your Datalog query
                  </div>
                )}
                {loading && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Running query...
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
