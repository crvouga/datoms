import Editor from '@monaco-editor/react';
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {DatalogQuery} from 'datoms';
import type {QueryEditorLog} from './types';

const MONACO_THEME: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light' = 'hc-black';

interface DbCallLogItemProps {
  log: QueryEditorLog;
  isExpanded: boolean;
  onToggle: () => void;
}

type TabType = 'datalog' | 'sql' | 'result' | 'error' | 'args';

const DEFAULT_HEIGHT = 256;
const STORAGE_KEY_PREFIX_HEIGHT = 'db-call-log-panel-height';
const STORAGE_KEY_PREFIX_TAB = 'db-call-log-panel-tab';

export function DbCallLogItem({log, isExpanded, onToggle}: DbCallLogItemProps) {
  const heightStorageKey = `${STORAGE_KEY_PREFIX_HEIGHT}-${log.id}`;
  const tabStorageKey = `${STORAGE_KEY_PREFIX_TAB}-${log.id}`;

  // Initialize height from localStorage
  const [height, setHeight] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(heightStorageKey);
      if (saved) {
        const parsed = Number.parseInt(saved, 10);
        if (!Number.isNaN(parsed) && parsed >= 200 && parsed <= 800) {
          return parsed;
        }
      }
    } catch {
      // Ignore errors, use default
    }
    return DEFAULT_HEIGHT;
  });

  const contentRef = useRef<HTMLDivElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);
  const isResizingRef = useRef(false);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  const formatDuration = (duration: number): string => {
    if (duration < 1) {
      return `${(duration * 1000).toFixed(2)}μs`;
    }
    if (duration < 1000) {
      return `${duration.toFixed(2)}ms`;
    }
    return `${(duration / 1000).toFixed(2)}s`;
  };

  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  };

  // Extract datalog query from args
  const datalogQuery = useMemo(() => {
    if (log.method === 'query' && log.args.length > 0) {
      const query = log.args[0];
      if (query && typeof query === 'object' && 'find' in query && 'where' in query) {
        return query as DatalogQuery;
      }
    }
    return null;
  }, [log.method, log.args]);

  // Calculate result count
  const resultCount = useMemo(() => {
    if (log.result === undefined) return null;
    if (Array.isArray(log.result)) {
      return log.result.length;
    }
    return null;
  }, [log.result]);

  // Determine available tabs
  const availableTabs = useMemo(() => {
    const tabs: TabType[] = [];
    if (datalogQuery) {
      tabs.push('datalog');
    } else if (log.args.length > 0) {
      tabs.push('args');
    }
    if (log.result !== undefined) {
      tabs.push('result');
    }
    if (log.error) {
      tabs.push('error');
    }
    return tabs.length > 0 ? tabs : ['args'];
  }, [datalogQuery, log.args, log.result, log.error]);

  // Initialize activeTab from localStorage, validating against available tabs
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    try {
      const saved = localStorage.getItem(tabStorageKey);
      if (saved) {
        const savedTab = saved as TabType;
        // Validate that the saved tab is a valid tab type
        const validTabs: TabType[] = ['datalog', 'sql', 'result', 'error', 'args'];
        if (validTabs.includes(savedTab)) {
          return savedTab;
        }
      }
    } catch {
      // Ignore errors, use default
    }
    return 'datalog';
  });

  // Set default tab when expanded or when saved tab is not available
  useEffect(() => {
    if (isExpanded && !availableTabs.includes(activeTab)) {
      const defaultTab = (availableTabs[0] || 'args') as TabType;
      setActiveTab(defaultTab);
    }
  }, [isExpanded, availableTabs, activeTab]);

  // Persist height to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(heightStorageKey, String(height));
    } catch {
      // Ignore errors (e.g., localStorage quota exceeded)
    }
  }, [height, heightStorageKey]);

  // Persist activeTab to localStorage whenever it changes
  useEffect(() => {
    if (isExpanded && availableTabs.includes(activeTab)) {
      try {
        localStorage.setItem(tabStorageKey, activeTab);
      } catch {
        // Ignore errors (e.g., localStorage quota exceeded)
      }
    }
  }, [activeTab, isExpanded, availableTabs, tabStorageKey]);

  // Handle mouse resize
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!contentRef.current) return;

      isResizingRef.current = true;
      startYRef.current = e.clientY;
      startHeightRef.current = height;
      document.body.style.cursor = 'ns-resize';
      document.body.style.userSelect = 'none';

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizingRef.current) return;

        const deltaY = moveEvent.clientY - startYRef.current;
        const newHeight = startHeightRef.current + deltaY;

        if (newHeight >= 200 && newHeight <= 800) {
          setHeight(newHeight);
        }
      };

      const handleMouseUp = () => {
        if (isResizingRef.current) {
          isResizingRef.current = false;
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', handleMouseMove);
          document.removeEventListener('mouseup', handleMouseUp);
        }
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [height],
  );

  const statusColor = log.error
    ? 'bg-red-900/30 text-red-400 border-red-700'
    : 'bg-green-900/30 text-green-400 border-green-700';

  return (
    <div className="border-b border-gray-700">
      {/* Collapsed Header */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left p-3 hover:bg-gray-800/50 transition-colors flex items-center justify-between gap-3"
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`px-2 py-1 rounded text-xs font-medium border ${statusColor} shrink-0`}>
            {log.error ? 'Error' : 'Success'}
          </div>
          <div className="px-2 py-1 rounded text-xs font-mono bg-gray-800 text-gray-300 shrink-0">
            {log.method}
          </div>
          <div className="text-xs text-gray-400 font-mono shrink-0">
            {formatTimestamp(log.timestamp)}
          </div>
          <div className="text-xs text-gray-500 font-mono shrink-0">
            {formatDuration(log.duration)}
          </div>
        </div>
        <div className="text-gray-500 shrink-0">{isExpanded ? '▼' : '▶'}</div>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="border-t border-gray-700 bg-gray-900/50">
          {/* Tabs */}
          <div className="flex border-b border-gray-700 overflow-x-auto">
            {availableTabs.map(tab => (
              <button
                type="button"
                key={tab}
                onClick={() => setActiveTab(tab as TabType)}
                className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 ${
                  activeTab === tab
                    ? 'border-blue-500 text-blue-400 bg-gray-800/50'
                    : 'border-transparent text-gray-400 hover:text-gray-300 hover:bg-gray-800/30'
                }`}
              >
                {tab === 'datalog'
                  ? 'Datalog Query'
                  : tab === 'sql'
                    ? 'SQL Query'
                    : tab === 'result'
                      ? `Result${resultCount !== null ? ` (${resultCount})` : ''}`
                      : tab === 'error'
                        ? 'Error'
                        : 'Arguments'}
              </button>
            ))}
          </div>

          {/* Tab Content Container */}
          <div className="relative" style={{height: `${height + 3}px`}}>
            <div
              ref={contentRef}
              style={{height: `${height}px`}}
              className="min-h-[200px] max-h-[800px] overflow-hidden"
            >
              {activeTab === 'datalog' && datalogQuery && (
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  value={JSON.stringify(datalogQuery, null, 2)}
                  theme={MONACO_THEME}
                  options={{
                    minimap: {enabled: false},
                    fontSize: 12,
                    wordWrap: 'on',
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    lineNumbers: 'off',
                    folding: true,
                  }}
                />
              )}

              {activeTab === 'result' && (
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  value={
                    log.result === undefined ? 'undefined' : JSON.stringify(log.result, null, 2)
                  }
                  theme={MONACO_THEME}
                  options={{
                    minimap: {enabled: false},
                    fontSize: 12,
                    wordWrap: 'on',
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    lineNumbers: 'off',
                    folding: true,
                  }}
                />
              )}

              {activeTab === 'error' && log.error && (
                <div className="h-full p-4 bg-red-900/20">
                  <div className="font-semibold text-red-400 mb-2">Error:</div>
                  <div className="text-red-300 font-mono text-sm whitespace-pre-wrap">
                    {log.error}
                  </div>
                </div>
              )}

              {activeTab === 'args' && (
                <Editor
                  height="100%"
                  defaultLanguage="json"
                  value={log.args.length === 0 ? '[]' : JSON.stringify(log.args, null, 2)}
                  theme={MONACO_THEME}
                  options={{
                    minimap: {enabled: false},
                    fontSize: 12,
                    wordWrap: 'on',
                    readOnly: true,
                    scrollBeyondLastLine: false,
                    lineNumbers: 'off',
                    folding: true,
                  }}
                />
              )}
            </div>
            {/* Resize Handle */}
            <div
              ref={resizeHandleRef}
              onMouseDown={handleMouseDown}
              className="absolute bottom-0 left-0 right-0 h-3 bg-gray-700 hover:bg-blue-600 cursor-ns-resize transition-colors group z-20 flex items-center justify-center pointer-events-auto"
              style={{top: `${height}px`}}
              title="Drag to resize"
            >
              <div className="w-12 h-0.5 bg-gray-500 opacity-50 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
