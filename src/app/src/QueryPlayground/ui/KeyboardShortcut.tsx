// Simple keyboard shortcut display component

export const KeyboardShortcut = ({keys}: {keys: string[]}) => {
  const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
  const modifierKey = isMac ? '⌘' : 'Ctrl';

  return (
    <span className="flex items-center gap-1 text-xs text-gray-400">
      {keys.map((key, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keys array is static and order never changes
        <span key={`${key}-${index}`} className="flex items-center gap-1">
          {index > 0 && <span className="text-gray-500">+</span>}
          {key === 'mod' ? (
            <kbd className="px-1.5 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs font-mono">
              {modifierKey}
            </kbd>
          ) : (
            <kbd className="px-1.5 py-0.5 bg-gray-800 border border-gray-600 rounded text-xs font-mono">
              {key}
            </kbd>
          )}
        </span>
      ))}
    </span>
  );
};
