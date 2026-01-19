import { useRef, useState } from "react";
import { useKeyboardShortcut } from "../hooks/useKeyboardShortcut";
import { useMonacoConfig } from "./hooks/useMonacoConfig";
import { useCodeStorage } from "./hooks/useCodeStorage";
import { useCodeExecution } from "./hooks/useCodeExecution";
import { useFontSize } from "./hooks/useFontSize";
import { EditorHeader } from "./components/EditorHeader";
import { ShortcutsHelp } from "./components/ShortcutsHelp";
import { ErrorDisplay } from "./components/ErrorDisplay";
import { LatencyDisplay } from "./components/LatencyDisplay";
import { MonacoEditorWrapper } from "./components/MonacoEditorWrapper";
import type { TypeDefinition, TypeScriptEditorProps } from "./types";

export type { TypeDefinition, TypeScriptEditorProps };

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

  // Handle code storage
  const { handleSave, saveNotification } = useCodeStorage(
    storageKey,
    code,
    defaultValue
  );
  const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

  // Handle font size with localStorage persistence and keyboard shortcuts
  const { fontSize, calculatedLineHeight } = useFontSize({
    storageKey,
    initialFontSize,
    editorRef,
  });

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
