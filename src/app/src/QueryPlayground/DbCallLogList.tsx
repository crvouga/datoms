import { useEffect, useState } from "react";
import type { DbCallLog } from "../../../datom-database/wrapper/logged-datom-database";
import { DbCallLogItem } from "./DbCallLogItem";

// LocalStorage key for persistence
const STORAGE_KEY_EXPANDED_IDS = "db-call-log-expanded-ids";

interface DbCallLogListProps {
  logs: DbCallLog[];
  onClear: () => void;
}

export function DbCallLogList({ logs, onClear }: DbCallLogListProps) {
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // Load expanded IDs from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_EXPANDED_IDS);
      if (saved) {
        const parsedIds = JSON.parse(saved) as number[];
        setExpandedIds(new Set(parsedIds));
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save expanded IDs to localStorage whenever expandedIds changes
  useEffect(() => {
    try {
      const idsArray = Array.from(expandedIds);
      localStorage.setItem(STORAGE_KEY_EXPANDED_IDS, JSON.stringify(idsArray));
    } catch {
      // Ignore localStorage errors
    }
  }, [expandedIds]);

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  if (logs.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-gray-500">
        <div className="text-center">
          <div className="text-sm mb-2">No DB calls logged</div>
          <div className="text-xs text-gray-600">
            Click "Run Code" to see DB call logs
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-900">
        <div className="text-xs text-gray-400">
          {logs.length} DB call{logs.length !== 1 ? "s" : ""} logged
        </div>
        <button
          onClick={onClear}
          className="px-2 py-1 text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
        >
          Clear
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="divide-y divide-gray-700">
          {logs.map((log) => (
            <DbCallLogItem
              key={log.id}
              log={log}
              isExpanded={expandedIds.has(log.id)}
              onToggle={() => toggleExpanded(log.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
