import {useEffect, useRef} from 'react';

export interface UseKeyboardShortcutOptions {
  /**
   * Array of keys for the shortcut, e.g., ["mod", "Enter"] or ["mod", "S"]
   * "mod" represents Command on Mac or Ctrl on Windows/Linux
   */
  keys: string[];
  /**
   * Callback function to execute when the shortcut is pressed
   */
  callback: () => void;
  /**
   * Whether the shortcut is enabled (defaults to true)
   */
  enabled?: boolean;
}

/**
 * Reusable hook for handling keyboard shortcuts.
 *
 * @example
 * ```tsx
 * useKeyboardShortcut({
 *   keys: ["mod", "Enter"],
 *   callback: handleRunQuery,
 *   enabled: !loading
 * });
 *
 * useKeyboardShortcut({
 *   keys: ["mod", "S"],
 *   callback: handleSaveQuery
 * });
 * ```
 */
export function useKeyboardShortcut({
  keys,
  callback,
  enabled = true,
}: UseKeyboardShortcutOptions): void {
  // Use ref to store the latest callback to avoid stale closures
  const callbackRef = useRef(callback);

  // Update the ref whenever the callback changes
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Command (Mac) or Ctrl (Windows/Linux)
      const isModifierPressed = event.metaKey || event.ctrlKey;

      // Check if "mod" is required in keys
      const requiresMod = keys.includes('mod');

      // If mod is required but not pressed, or mod is not required but pressed, skip
      if (requiresMod !== isModifierPressed) {
        return;
      }

      // Get the non-modifier key(s) from the keys array
      const nonModKeys = keys.filter(key => key !== 'mod');

      // Check if the pressed key matches any of the non-modifier keys
      // Normalize key comparison (case-insensitive for letter keys)
      const pressedKey = event.key;
      const keyMatches = nonModKeys.some(key => {
        // Case-insensitive comparison for letter keys
        if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
          return pressedKey.toLowerCase() === key.toLowerCase();
        }
        // Exact match for special keys like "Enter", "Escape", etc.
        return pressedKey === key;
      });

      if (keyMatches) {
        event.preventDefault();
        callbackRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [keys, enabled]);
}
