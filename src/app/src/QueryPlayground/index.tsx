import {useEffect, useState, useRef, useCallback} from 'react';
import {Panel, PanelResizeHandle} from 'react-resizable-panels';
import Editor from '@monaco-editor/react';
import {db} from '../lib/db';
import {ResizablePanels} from './ui/ResizablePanels';
import type {DatalogQuery} from '../../../datalog/datalog';
import type {QueryResultEnvelope} from '../../../datom-database/views/database-view';

// Monaco Editor theme configuration
const MONACO_THEME: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' = 'hc-black';

// LocalStorage key for persistence
const STORAGE_KEY_QUERY_JSON = 'query-editor-json-query';

// Default query as JSON string
const DEFAULT_QUERY_JSON = JSON.stringify(
  {
    find: {
      'movie/id': ['?movie/id'],
      'movie/title': ['?title'],
      'movie/popularity': ['?popularity'],
    },
    where: [
      {e: '?movie/id', a: 'tmdb.movie/id', v: '?movie/id'},
      {e: '?movie/id', a: 'tmdb.movie/title', v: '?title'},
      {e: '?movie/id', a: 'tmdb.movie/popularity', v: '?popularity'},
    ],
    orderBy: [['?popularity', 'desc']],
    limit: 10,
  },
  null,
  2,
);

export function QueryPlayground() {
  const [queryJson, setQueryJson] = useState<string>(DEFAULT_QUERY_JSON);
  const [result, setResult] = useState<QueryResultEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);

  // Load query from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_QUERY_JSON);
      if (saved && saved.trim() !== '') {
        setQueryJson(saved);
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save query to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_QUERY_JSON, queryJson);
    } catch {
      // Ignore localStorage errors
    }
  }, [queryJson]);

  const handleRunQuery = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      // Parse JSON
      let parsedQuery: DatalogQuery;
      try {
        parsedQuery = JSON.parse(queryJson) as DatalogQuery;
      } catch (parseError) {
        throw new Error(
          `Invalid JSON: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
        );
      }

      // Format the JSON query and update the editor
      const formattedJson = JSON.stringify(parsedQuery, null, 2);
      setQueryJson(formattedJson);

      // Basic validation
      if (!parsedQuery.find || typeof parsedQuery.find !== 'object') {
        throw new Error('Query must have a "find" property');
      }
      if (!Array.isArray(parsedQuery.where)) {
        throw new Error('Query must have a "where" property that is an array');
      }

      // Execute query
      const queryResult = await db.query(parsedQuery);
      setResult(queryResult);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(errorMessage);
      console.error('Query execution error:', err);
    } finally {
      setLoading(false);
    }
  }, [queryJson]);

  // Keyboard shortcut: Cmd/Ctrl+Enter to run query
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void handleRunQuery();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleRunQuery]);

  return (
    <div className="h-screen w-screen overflow-hidden">
      <ResizablePanels
        storageKey="query-editor-panel-sizes"
        defaultSizes={[50, 50]}
        direction="horizontal"
      >
        {({panelSizes}) => (
          <>
            {/* Query Editor Panel */}
            <Panel defaultSize={panelSizes[0]} minSize={30} className="flex flex-col">
              <div className="border-b border-gray-700 bg-gray-900">
                <div className="flex items-center justify-between p-2">
                  <div className="text-sm font-medium text-gray-300">Datalog Query</div>
                  <button
                    onClick={() => void handleRunQuery()}
                    disabled={loading}
                    className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white rounded transition-colors"
                  >
                    {loading ? 'Running...' : 'Run Query'}
                  </button>
                </div>
                <div className="px-2 pb-1 text-xs text-gray-400">Cmd/Ctrl+Enter to run</div>
              </div>
              <div className="flex-1 min-h-0">
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  value={queryJson}
                  onChange={value => setQueryJson(value || '')}
                  theme={MONACO_THEME}
                  onMount={(editor, monaco) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    editorRef.current = editor;
                    // Configure JSON validation
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
                    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
                      validate: true,
                      allowComments: false,
                      schemas: [],
                    });
                  }}
                  options={{
                    minimap: {enabled: false},
                    fontSize: 14,
                    wordWrap: 'on',
                    automaticLayout: true,
                    scrollBeyondLastLine: false,
                    tabSize: 2,
                    formatOnPaste: true,
                    formatOnType: true,
                  }}
                />
              </div>
            </Panel>

            <PanelResizeHandle className="w-2 bg-gray-800 hover:bg-gray-700 transition-colors cursor-col-resize" />

            {/* Results Panel */}
            <Panel defaultSize={panelSizes[1]} minSize={30} className="flex flex-col">
              <div className="border-b border-gray-700 bg-gray-900">
                <div className="flex items-center justify-between p-2">
                  <div className="text-sm font-medium text-gray-300">Results</div>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                {loading && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    Running query...
                  </div>
                )}
                {error && (
                  <div className="p-4 bg-red-900/20 border-l-4 border-red-500">
                    <div className="font-semibold text-red-400 mb-1">Error</div>
                    <div className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                      {error}
                    </div>
                  </div>
                )}
                {!loading && !error && result && (
                  <div className="h-full">
                    <Editor
                      height="100%"
                      defaultLanguage="json"
                      value={JSON.stringify(result, null, 2)}
                      theme={MONACO_THEME}
                      options={{
                        minimap: {enabled: false},
                        fontSize: 14,
                        wordWrap: 'on',
                        readOnly: true,
                        automaticLayout: true,
                        scrollBeyondLastLine: false,
                        lineNumbers: 'on',
                      }}
                    />
                  </div>
                )}
                {!loading && !error && !result && (
                  <div className="flex items-center justify-center h-full text-gray-500">
                    <div className="text-center">
                      <div className="text-sm mb-2">No results</div>
                      <div className="text-xs text-gray-600">Run a query to see results</div>
                    </div>
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
