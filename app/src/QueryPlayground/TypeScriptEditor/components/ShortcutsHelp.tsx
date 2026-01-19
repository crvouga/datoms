import { KeyboardShortcut } from "../../ui/KeyboardShortcut";

export interface ShortcutsHelpProps {
  storageKey?: string;
}

export function ShortcutsHelp({ storageKey }: ShortcutsHelpProps) {
  return (
    <div className="p-3 bg-gray-800 border-b border-gray-700">
      <div className="text-sm text-gray-300 space-y-2">
        <div className="font-semibold text-gray-200 mb-2">
          Keyboard Shortcuts:
        </div>
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
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Increase Font Size</span>
          <KeyboardShortcut keys={["mod", "+"]} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-gray-400">Decrease Font Size</span>
          <KeyboardShortcut keys={["mod", "-"]} />
        </div>
      </div>
    </div>
  );
}
