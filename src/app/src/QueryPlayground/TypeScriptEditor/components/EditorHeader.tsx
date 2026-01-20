import {HelpIcon} from '../../ui/icons';
import {RunButton} from './RunButton';
import {SaveButton} from './SaveButton';

export interface EditorHeaderProps {
  title: string;
  showShortcutsHelp: boolean;
  onToggleShortcuts: () => void;
  saveNotification: string | null;
  storageKey?: string;
  onSave: () => void;
  saveButtonLabel: string;
  onRun: () => void;
  loading: boolean;
  runButtonLabel: string;
}

export function EditorHeader({
  title,
  showShortcutsHelp,
  onToggleShortcuts,
  saveNotification,
  storageKey,
  onSave,
  saveButtonLabel,
  onRun,
  loading,
  runButtonLabel,
}: EditorHeaderProps) {
  return (
    <div className="flex items-center justify-between p-2 border-b border-gray-700 bg-gray-900">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">{title}</h2>
        {showShortcutsHelp && (
          <button
            onClick={onToggleShortcuts}
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
        {storageKey && <SaveButton onClick={onSave} label={saveButtonLabel} />}
        <RunButton onClick={onRun} loading={loading} label={runButtonLabel} />
      </div>
    </div>
  );
}
