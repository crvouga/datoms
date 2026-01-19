import { PlayIcon } from "../../ui/icons";
import { KeyboardShortcut } from "../../ui/KeyboardShortcut";

export interface RunButtonProps {
  onClick: () => void;
  loading: boolean;
  label: string;
}

export function RunButton({ onClick, loading, label }: RunButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded font-medium transition-colors"
      title="Run code"
    >
      <PlayIcon className="w-4 h-4" />
      <span>{loading ? "Running..." : label}</span>
      <KeyboardShortcut keys={["mod", "Enter"]} />
    </button>
  );
}
