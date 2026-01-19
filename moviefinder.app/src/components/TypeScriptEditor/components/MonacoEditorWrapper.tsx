import Editor from "@monaco-editor/react";

export interface MonacoEditorWrapperProps {
  code: string;
  onChange: (value: string | undefined) => void;
  theme: "vs" | "vs-dark" | "hc-black" | "hc-light";
  fontSize: number;
  lineHeight: number;
  wordWrap: "on" | "off";
  tabSize: number;
  editorOptions: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onMount: (editor: any, monaco: any) => void;
}

export function MonacoEditorWrapper({
  code,
  onChange,
  theme,
  fontSize,
  lineHeight,
  wordWrap,
  tabSize,
  editorOptions,
  onMount,
}: MonacoEditorWrapperProps) {
  return (
    <div className="flex-1 min-h-0">
      <Editor
        height="100%"
        defaultLanguage="typescript"
        value={code}
        onChange={onChange}
        theme={theme}
        onMount={onMount}
        options={{
          minimap: { enabled: false },
          fontSize,
          wordWrap,
          automaticLayout: true,
          lineHeight,
          padding: { top: 20, bottom: 20 },
          scrollBeyondLastLine: false,
          renderWhitespace: "selection",
          tabSize,
          suggestOnTriggerCharacters: true,
          quickSuggestions: true,
          parameterHints: { enabled: true },
          hover: { enabled: true },
          formatOnPaste: true,
          formatOnType: true,
          ...editorOptions,
        }}
      />
    </div>
  );
}
