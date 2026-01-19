export interface TypeDefinition {
  content: string;
  filePath: string;
}

export interface TypeScriptEditorProps {
  // Type definitions for Monaco IntelliSense
  typeDefinitions: TypeDefinition[];

  // Execution context - variables available in user code
  // Can be a static object or a function that returns the context (called on each execution)
  executionContext: Record<string, unknown> | (() => Record<string, unknown>);

  // Default code value
  defaultValue?: string;

  // Storage key for persistence (optional, if not provided, no persistence)
  storageKey?: string;

  // Callbacks
  onExecute?: (code: string) => Promise<void> | void;
  onExecuteStart?: () => void;
  onExecuteComplete?: (duration: number) => void;
  onExecuteError?: (error: Error) => void;

  // UI customization
  title?: string;
  runButtonLabel?: string;
  saveButtonLabel?: string;
  showShortcutsHelp?: boolean;

  // Editor options
  theme?: "vs" | "vs-dark" | "hc-black" | "hc-light";
  fontSize?: number;
  lineHeight?: number;
  wordWrap?: "on" | "off";
  tabSize?: number;

  // Additional Monaco editor options
  editorOptions?: Record<string, unknown>;
}
