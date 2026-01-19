import { useCallback, useState } from "react";

export interface UseCodeStorageReturn {
  handleSave: () => void;
  saveNotification: string | null;
}

/**
 * Hook for managing code persistence in localStorage
 * @param storageKey - localStorage key for persistence (optional)
 * @param code - Current code value
 * @param defaultValue - Default code value if nothing is saved
 * @returns Object with handleSave function and saveNotification
 */
export function useCodeStorage(
  storageKey: string | undefined,
  code: string,
  _defaultValue: string
): UseCodeStorageReturn {
  const [saveNotification, setSaveNotification] = useState<string | null>(null);

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

  return {
    handleSave,
    saveNotification,
  };
}
