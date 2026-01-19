import Editor from "@monaco-editor/react";
// @ts-expect-error - @babel/standalone doesn't have complete TypeScript definitions
import * as Babel from "@babel/standalone";
import { useCallback, useEffect, useRef, useState } from "react";
import { PlayIcon, SaveIcon, HelpIcon } from "./ui/icons";
import { KeyboardShortcut } from "./ui/KeyboardShortcut";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";

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

// Default execution context with standard globals
const DEFAULT_EXECUTION_CONTEXT: Record<string, unknown> = {
    console: {
        log: (...args: unknown[]) => {
            console.log(...args);
        },
        error: (...args: unknown[]) => {
            console.error(...args);
        },
        warn: (...args: unknown[]) => {
            console.warn(...args);
        },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    JSON,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Date,
    Math,
    Error,
};

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
    fontSize = 18,
    lineHeight = 26,
    wordWrap = "off",
    tabSize = 2,
    editorOptions = {},
}: TypeScriptEditorProps) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editorRef = useRef<any>(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monacoRef = useRef<any>(null);
    const [code, setCode] = useState<string>(defaultValue);
    const [loading, setLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);
    const [latency, setLatency] = useState<number | null>(null);
    const [saveNotification, setSaveNotification] = useState<string | null>(null);
    const [showShortcuts, setShowShortcuts] = useState<boolean>(false);

    // Configure Monaco Editor with TypeScript types
    useEffect(() => {
        if (monacoRef.current) {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            const monaco = monacoRef.current;

            // Set compiler options
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
                target: monaco.languages.typescript.ScriptTarget.ES2020,
                allowNonTsExtensions: true,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
                moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
                module: monaco.languages.typescript.ModuleKind.ESNext,
                noEmit: true,
                esModuleInterop: true,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
                jsx: monaco.languages.typescript.JsxEmit.React,
                reactNamespace: "React",
                allowJs: true,
                typeRoots: ["node_modules/@types"],
            });

            // Add extra libs for better IntelliSense
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
            monaco.languages.typescript.typescriptDefaults.setExtraLibs(
                typeDefinitions.map((def) => ({
                    content: def.content,
                    filePath: def.filePath,
                }))
            );
        }
    }, [monacoRef.current, typeDefinitions]);

    // Load saved code on mount if storageKey is provided
    useEffect(() => {
        if (!storageKey) return;

        try {
            const saved = localStorage.getItem(storageKey);
            if (saved && saved.trim() !== "") {
                setCode(saved);
            }
        } catch {
            // Ignore errors, use default
        }
    }, [storageKey]);

    // Save code to localStorage
    const handleSave = useCallback(() => {
        if (!storageKey) return;

        try {
            localStorage.setItem(storageKey, code);
            setSaveNotification("Saved");
            // Clear notification after 2 seconds
            setTimeout(() => {
                setSaveNotification(null);
            }, 2000);
        } catch {
            setSaveNotification("Failed to save");
            setTimeout(() => {
                setSaveNotification(null);
            }, 2000);
        }
    }, [code, storageKey]);

    // Execute code
    const handleRun = async () => {
        setLoading(true);
        setError(null);
        setLatency(null);

        const startTime = performance.now();

        // Call onExecuteStart callback if provided
        onExecuteStart?.();

        try {
            // If custom onExecute is provided, use it
            if (onExecute) {
                await onExecute(code);
                const endTime = performance.now();
                const duration = endTime - startTime;
                setLatency(duration);
                onExecuteComplete?.(duration);
                return;
            }

            // Otherwise, use default execution logic
            // Transpile TypeScript to JavaScript using Babel
            let compiledCode: string;
            try {
                // Wrap user code in an async function to handle top-level await
                const wrappedCode = `(async () => {\n${code}\n})()`;

                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
                const result = Babel.transform(wrappedCode, {
                    presets: [
                        ["typescript", { isTSX: false, allExtensions: false }],
                        ["env", { targets: { browsers: ["last 2 versions"] } }],
                    ],
                    filename: "code.ts",
                });

                // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
                if (!result.code) {
                    throw new Error("Failed to compile TypeScript code");
                }
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                compiledCode = result.code;
            } catch (compileError: unknown) {
                const errorMessage =
                    compileError instanceof Error
                        ? compileError.message
                        : String(compileError);
                throw new Error(`TypeScript compilation error: ${errorMessage}`);
            }

            // Get execution context (call function if needed)
            const contextValue = typeof executionContext === "function"
                ? executionContext()
                : executionContext;

            // Merge default execution context with provided context
            const mergedContext = {
                ...DEFAULT_EXECUTION_CONTEXT,
                ...contextValue,
            };

            // Execute the compiled code (wrapped in async IIFE, so it returns a Promise)
            // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-assignment
            const executeCode = new Function(
                ...Object.keys(mergedContext),
                `
        try {
          const result = ${compiledCode};
          return result;
        } catch (e) {
          console.error('Execution error:', e);
          throw e;
        }
        `
            );

            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
            const executionResult = executeCode(...Object.values(mergedContext));

            // The wrapped code always returns a Promise, so await it
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
            await executionResult;

            const endTime = performance.now();
            const duration = endTime - startTime;

            setLatency(duration);
            onExecuteComplete?.(duration);
        } catch (err) {
            const endTime = performance.now();
            const duration = endTime - startTime;

            const errorMessage = err instanceof Error ? err.message : String(err);
            setError(errorMessage);
            setLatency(duration);
            onExecuteError?.(err instanceof Error ? err : new Error(String(err)));
            console.error("Code execution error:", err);
        } finally {
            setLoading(false);
        }
    };

    // Keyboard shortcuts
    useKeyboardShortcut({
        keys: ["mod", "Enter"],
        callback: handleRun,
        enabled: !loading,
    });

    useKeyboardShortcut({
        keys: ["mod", "S"],
        callback: handleSave,
        enabled: !!storageKey,
    });

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-900">
                <div className="flex items-center gap-3">
                    <h2 className="text-lg font-semibold">{title}</h2>
                    {showShortcutsHelp && (
                        <button
                            onClick={() => setShowShortcuts(!showShortcuts)}
                            className="p-1.5 text-gray-400 hover:text-gray-300 hover:bg-gray-800 rounded transition-colors"
                            title="Show keyboard shortcuts"
                        >
                            <HelpIcon className="w-4 h-4" />
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {saveNotification && (
                        <span className="text-sm text-green-400 font-medium animate-pulse">
                            {saveNotification}
                        </span>
                    )}
                    {storageKey && (
                        <button
                            onClick={handleSave}
                            className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors text-sm"
                            title="Save code"
                        >
                            <SaveIcon className="w-4 h-4" />
                            <span>{saveButtonLabel}</span>
                            <KeyboardShortcut keys={["mod", "S"]} />
                        </button>
                    )}
                    <button
                        onClick={handleRun}
                        disabled={loading}
                        className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
                        title="Run code"
                    >
                        <PlayIcon className="w-4 h-4" />
                        <span>{loading ? "Running..." : runButtonLabel}</span>
                        <KeyboardShortcut keys={["mod", "Enter"]} />
                    </button>
                </div>
            </div>
            {showShortcuts && showShortcutsHelp && (
                <div className="p-3 bg-gray-800 border-b border-gray-700">
                    <div className="text-sm text-gray-300 space-y-2">
                        <div className="font-semibold text-gray-200 mb-2">Keyboard Shortcuts:</div>
                        <div className="flex items-center justify-between">
                            <span className="text-gray-400">Run Code</span>
                            <KeyboardShortcut keys={["mod", "Enter"]} />
                        </div>
                        {storageKey && (
                            <div className="flex items-center justify-between">
                                <span className="text-gray-400">Save Code</span>
                                <KeyboardShortcut keys={["mod", "S"]} />
                            </div>
                        )}
                    </div>
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
            {latency !== null && (
                <div className="px-4 py-2 text-sm text-gray-400 font-mono border-b border-gray-700">
                    Execution time:{" "}
                    {latency < 1
                        ? `${(latency * 1000).toFixed(2)}μs`
                        : latency < 1000
                            ? `${latency.toFixed(2)}ms`
                            : `${(latency / 1000).toFixed(2)}s`}
                </div>
            )}
            <div className="flex-1 min-h-0">
                <Editor
                    height="100%"
                    defaultLanguage="typescript"
                    value={code}
                    onChange={(value) => setCode(value || "")}
                    theme={theme}
                    onMount={(editor, monaco) => {
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        editorRef.current = editor;
                        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                        monacoRef.current = monaco;
                    }}
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
        </div>
    );
}
