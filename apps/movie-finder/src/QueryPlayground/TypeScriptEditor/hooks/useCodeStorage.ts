import {useCallback, useState} from 'react';
import type {RefObject} from 'react';

export interface UseCodeStorageReturn {
  handleSave: () => Promise<void>;
  saveNotification: string | null;
}

/**
 * Aggressively clean up whitespace in code
 * - Removes trailing whitespace from lines
 * - Removes multiple consecutive blank lines (keeps max 1 blank line)
 * - Trims leading/trailing blank lines
 * - Ensures single newline at end
 */
function aggressivelyCleanWhitespace(code: string): string {
  return code
    .split('\n')
    .map((line) => line.replace(/\s+$/, '')) // Remove trailing whitespace from each line
    .join('\n')
    .replace(/\n{2,}/g, '\n') // Replace 2+ consecutive newlines with single newline (very aggressive)
    .replace(/^\n+/, '') // Remove leading blank lines
    .replace(/\n+$/, '') // Remove trailing blank lines
    .concat('\n'); // Ensure single newline at end
}

/**
 * Hook for managing code persistence in localStorage
 * Note: Type safety is intentionally relaxed here due to Monaco editor's lack of proper TypeScript types
 * @param storageKey - localStorage key for persistence (optional)
 * @param code - Current code value
 * @param defaultValue - Default code value if nothing is saved
 * @param editorRef - Ref to Monaco editor instance
 * @param setCode - Function to update code state
 * @returns Object with handleSave function and saveNotification
 */
export function useCodeStorage(
  storageKey: string | undefined,
  code: string,
  _defaultValue: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco editor types are not available
  editorRef: RefObject<any>,
  setCode: (code: string) => void,
): UseCodeStorageReturn {
  const [saveNotification, setSaveNotification] = useState<string | null>(null);

  // Save code to localStorage with formatting
  const handleSave = useCallback(async () => {
    if (!storageKey) return;

    try {
      const editor = editorRef.current;
      let codeToSave = code;

      // Format the code if editor is available
      if (editor) {
        try {
          // Save cursor position before formatting
          const position = editor.getPosition();
          const selection = editor.getSelection();

          // Calculate character offset for better position preservation
          const currentValue = editor.getValue();
          const currentValueStr =
            typeof currentValue === 'string' ? currentValue : String(currentValue);
          let cursorOffset = 0;
          if (position) {
            // Calculate offset: sum of characters in previous lines + column
            const lines = currentValueStr.split('\n');
            const lineNumberRaw = position.lineNumber;
            const lineNumber =
              typeof lineNumberRaw === 'number' ? lineNumberRaw : Number(lineNumberRaw) || 1;
            for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
              const line = lines[i];
              if (line) {
                cursorOffset += line.length + 1; // +1 for newline
              }
            }
            const columnRaw = position.column;
            const column = typeof columnRaw === 'number' ? columnRaw : Number(columnRaw) || 1;
            cursorOffset += column - 1;
          }

          // Format using Monaco's formatter with aggressive options
          const formatAction = editor.getAction('editor.action.formatDocument');
          if (formatAction) {
            // Run formatting
            await formatAction.run();

            // Get the formatted code from the editor
            codeToSave = editor.getValue();

            // Apply aggressive whitespace cleanup
            codeToSave = aggressivelyCleanWhitespace(codeToSave);

            // Set the cleaned code back to editor
            editor.setValue(codeToSave);

            // Restore cursor position
            if (position) {
              // Try to restore to similar position in formatted code
              const formattedLines = codeToSave.split('\n');
              let restoredLine = 1;
              let restoredColumn = 1;
              let currentOffset = 0;

              // Find the line and column that best matches the original offset
              for (let i = 0; i < formattedLines.length; i++) {
                const line = formattedLines[i];
                if (!line) continue;
                const lineLength = line.length;
                if (currentOffset + lineLength >= cursorOffset) {
                  restoredLine = i + 1;
                  restoredColumn = Math.min(cursorOffset - currentOffset + 1, lineLength + 1);
                  break;
                }
                currentOffset += lineLength + 1; // +1 for newline
              }

              // Ensure we don't go beyond the document
              restoredLine = Math.min(restoredLine, formattedLines.length);
              if (restoredLine > 0) {
                const targetLine = formattedLines[restoredLine - 1];
                if (targetLine) {
                  restoredColumn = Math.min(restoredColumn, targetLine.length + 1);
                }
              }

              // Restore position
              editor.setPosition({
                lineNumber: restoredLine,
                column: restoredColumn,
              });

              // Restore selection if there was one
              if (selection && typeof selection === 'object' && 'isEmpty' in selection) {
                const isEmptyFn = selection.isEmpty;
                if (typeof isEmptyFn === 'function' && !isEmptyFn()) {
                  // Try to preserve selection bounds
                  editor.setSelection(selection);
                }
              }

              // Focus the editor to ensure cursor is visible
              editor.focus();
            }

            // Update the code state with formatted code
            setCode(codeToSave);
          }
        } catch (formatError) {
          // If formatting fails, still try to clean whitespace
          console.warn('Failed to format code:', formatError);
          codeToSave = aggressivelyCleanWhitespace(codeToSave);
          setCode(codeToSave);
        }
      } else {
        // Even without editor, clean whitespace
        codeToSave = aggressivelyCleanWhitespace(codeToSave);
        setCode(codeToSave);
      }

      localStorage.setItem(storageKey, codeToSave);
      setSaveNotification('Saved');
      // Clear notification after 2 seconds
      setTimeout(() => {
        setSaveNotification(null);
      }, 2000);
    } catch {
      setSaveNotification('Failed to save');
      setTimeout(() => {
        setSaveNotification(null);
      }, 2000);
    }
  }, [code, storageKey, editorRef, setCode]);

  return {
    handleSave,
    saveNotification,
  };
}
