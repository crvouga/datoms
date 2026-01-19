import { useEffect, useState } from "react";
import { useKeyboardShortcut } from "../../hooks/useKeyboardShortcut";

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 48;
const FONT_SIZE_STEP = 2;
const LINE_HEIGHT_RATIO = 1.44;

export interface UseFontSizeOptions {
  /**
   * localStorage key for persisting font size (optional)
   */
  storageKey?: string;
  /**
   * Initial font size (defaults to 18)
   */
  initialFontSize?: number;
  /**
   * Reference to the Monaco editor instance
   */
  editorRef: React.RefObject<any>;
}

export interface UseFontSizeReturn {
  /**
   * Current font size
   */
  fontSize: number;
  /**
   * Calculated line height based on font size
   */
  calculatedLineHeight: number;
  /**
   * Function to increase font size
   */
  increaseFontSize: () => void;
  /**
   * Function to decrease font size
   */
  decreaseFontSize: () => void;
}

/**
 * Hook for managing font size in Monaco editor with localStorage persistence
 * and keyboard shortcuts support.
 *
 * @param options - Configuration options
 * @returns Object with fontSize, calculatedLineHeight, and adjustment functions
 */
export function useFontSize({
  storageKey,
  initialFontSize = 18,
  editorRef,
}: UseFontSizeOptions): UseFontSizeReturn {
  // Initialize font size from localStorage if available
  const [fontSize, setFontSize] = useState<number>(() => {
    if (!storageKey) return initialFontSize;
    try {
      const saved = localStorage.getItem(`${storageKey}_fontSize`);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (
          !isNaN(parsed) &&
          parsed >= MIN_FONT_SIZE &&
          parsed <= MAX_FONT_SIZE
        ) {
          return parsed;
        }
      }
    } catch {
      // Ignore errors, use default
    }
    return initialFontSize;
  });

  // Calculate line height based on font size
  const calculatedLineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);

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

  // Update Monaco editor when font size changes
  useEffect(() => {
    if (editorRef.current) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      editorRef.current.updateOptions({
        fontSize,
        lineHeight: calculatedLineHeight,
      });
    }
  }, [fontSize, calculatedLineHeight, editorRef]);

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

  return {
    fontSize,
    calculatedLineHeight,
    increaseFontSize,
    decreaseFontSize,
  };
}
