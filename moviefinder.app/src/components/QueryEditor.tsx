import Editor from "@monaco-editor/react";
import { useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import type { DatalogQuery, QueryResult } from "../lib/db";
import { db } from "../lib/db";

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
  const [queryText, setQueryText] = useState<string>(DEFAULT_QUERY);
  const [results, setResults] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleRunQuery = async () => {
    setLoading(true);
    setError(null);
    setResults(null);

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

      // Execute the query
      const queryResults = await db.query(query);

      setResults(queryResults);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
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
      <PanelGroup direction="horizontal">
        {/* Editor Section */}
        <Panel defaultSize={75} minSize={30} className="flex flex-col">
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
              theme="vs-dark"
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
        <Panel defaultSize={25} minSize={20} className="flex flex-col">
          <div className="p-2 border-b border-gray-700 bg-gray-900">
            <h2 className="text-lg font-semibold">
              Results {results && `(${results.length} rows)`}
            </h2>
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
            {results !== null && !error && (
              <div className="p-4">
                <pre className="text-sm font-mono text-gray-300 whitespace-pre-wrap">
                  {formatResults(results)}
                </pre>
              </div>
            )}
            {results === null && !error && !loading && (
              <div className="p-4 text-gray-500 text-center">
                Click "Run Query" to execute your Datalog query
              </div>
            )}
            {loading && (
              <div className="p-4 text-gray-500 text-center">
                Running query...
              </div>
            )}
          </div>
        </Panel>
      </PanelGroup>
    </div>
  );
}
