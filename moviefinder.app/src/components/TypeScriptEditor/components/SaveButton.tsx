import { SaveIcon } from "../../ui/icons";
import { KeyboardShortcut } from "../../ui/KeyboardShortcut";

export interface SaveButtonProps {
  onClick: () => void;
  label: string;
}

export function SaveButton({ onClick, label }: SaveButtonProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-medium transition-colors text-sm"
      title="Save code"
    >
      <SaveIcon className="w-4 h-4" />
      <span>{label}</span>
      <KeyboardShortcut keys={["mod", "S"]} />
    </button>
  );
}
