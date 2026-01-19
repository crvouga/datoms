import { useEffect, useRef, useState } from "react";
import { useKeyboardShortcut } from "../hooks/useKeyboardShortcut";
import { useMonacoConfig } from "./hooks/useMonacoConfig";
import { useCodeStorage } from "./hooks/useCodeStorage";
import { useCodeExecution } from "./hooks/useCodeExecution";
import { EditorHeader } from "./components/EditorHeader";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { ErrorDisplay } from "./components/ErrorDisplay";
import { LatencyDisplay } from "./components/LatencyDisplay";
import { MonacoEditorWrapper } from "./components/MonacoEditorWrapper";
import type { TypeDefinition, TypeScriptEditorProps } from "./types";

export type { TypeDefinition, TypeScriptEditorProps };

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;

export function TypeScriptEditor({
  typeDefinitions,
  executionContext,
  defaultValue = "",
  storageKey,
  onExecute,
  onExecuteStart,
  onExecuteComplete,
  onExecuteError,
  title = "TypeScript Editor",
  runButtonLabel = "Run Code",
  saveButtonLabel = "Save",
  showShortcutsHelp = true,
  theme = "hc-black",
  fontSize: initialFontSize = 18,
  lineHeight: _lineHeight = 26,
  wordWrap = "off",
  tabSize = 2,
  editorOptions = {},
}: TypeScriptEditorProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const monacoRef = useRef<any>(null);

  // Initialize code from localStorage if available
  const [code, setCode] = useState<string>(() => {
    if (!storageKey) return defaultValue;
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved && saved.trim() !== "") {
        return saved;
      }
    } catch {
      // Ignore errors, use default
    }
    return defaultValue;
  });

  // Initialize font size from localStorage if available
  const [fontSize, setFontSize] = useState<number>(() => {
    if (!storageKey) return initialFontSize;
    try {
      const saved = localStorage.getItem(`${storageKey}_fontSize`);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= MIN_FONT_SIZE && parsed <= MAX_FONT_SIZE) {
          return parsed;
        }
      }
    } catch {
      // Ignore errors, use default
    }
    return initialFontSize;
  });

  // Handle code storage
  const { handleSave, saveNotification } = useCodeStorage(
    storageKey,
    code,
    defaultValue
  );
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  // Font size adjustment functions
  const increaseFontSize = () => {
    setFontSize((prev) => {
      const newSize = Math.min(prev + FONT_SIZE_STEP, MAX_FONT_SIZE);
      if (storageKey) {
        try {
          localStorage.setItem(`${storageKey}_fontSize`, newSize.toString());
        } catch {
          // Ignore errors
        }
      }
      return newSize;
    });
  };

  const decreaseFontSize = () => {
    setFontSize((prev) => {
      const newSize = Math.max(prev - FONT_SIZE_STEP, MIN_FONT_SIZE);
      if (storageKey) {
        try {
          localStorage.setItem(`${storageKey}_fontSize`, newSize.toString());
        } catch {
          // Ignore errors
        }
      }
      return newSize;
    });
  };

  // Calculate line height based on font size (1.44 ratio is common for code editors)
  const calculatedLineHeight = Math.round(fontSize * 1.44);

  // Update Monaco editor when font size changes
  useEffect(() => {
    if (editorRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      editorRef.current.updateOptions({
        fontSize,
        lineHeight: calculatedLineHeight,
      });
    }
  }, [fontSize, calculatedLineHeight]);

  // Configure Monaco Editor with TypeScript types
  useMonacoConfig(monacoRef, typeDefinitions);

  // Handle code execution
  const executionResult = useCodeExecution(
    code,
    executionContext,
    onExecute,
    onExecuteStart,
    onExecuteComplete,
    onExecuteError
  );
  const { handleRun, loading, error, latency } = executionResult;

  // Keyboard shortcuts
  useKeyboardShortcut({
    keys: ["mod", "Enter"],
    callback: () => {
      void handleRun();
    },
    enabled: !loading,
  });

  useKeyboardShortcut({
    keys: ["mod", "S"],
    callback: handleSave,
    enabled: !!storageKey,
  });

  // Font size keyboard shortcuts
  // Handle both "=" and "+" for increase (Plus is Shift+= on most keyboards)
  useKeyboardShortcut({
    keys: ["mod", "="],
    callback: increaseFontSize,
  });

  useKeyboardShortcut({
    keys: ["mod", "+"],
    callback: increaseFontSize,
  });

  useKeyboardShortcut({
    keys: ["mod", "-"],
    callback: decreaseFontSize,
  });

  return (
    <div className="flex flex-col h-full">
      <EditorHeader
        title={title}
        showShortcutsHelp={showShortcutsHelp}
        onToggleShortcuts={() => setShowShortcuts(!showShortcuts)}
        saveNotification={saveNotification}
        storageKey={storageKey}
        onSave={handleSave}
        saveButtonLabel={saveButtonLabel}
        onRun={handleRun}
        loading={loading}
        runButtonLabel={runButtonLabel}
      />
      {showShortcuts && showShortcutsHelp && (
        <ShortcutsHelp storageKey={storageKey} />
      )}
      <ErrorDisplay error={error} />
      <LatencyDisplay latency={latency} />
      <MonacoEditorWrapper
        code={code}
        onChange={(value) => setCode(value || "")}
        theme={theme}
        fontSize={fontSize}
        lineHeight={calculatedLineHeight}
        wordWrap={wordWrap}
        tabSize={tabSize}
        editorOptions={editorOptions}
        onMount={(editor, monaco) => {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          editorRef.current = editor;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          monacoRef.current = monaco;
        }}
      />
    </div>
  );
}
