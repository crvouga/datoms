import {SaveIcon} from '../../ui/icons';
import {Button} from '../../ui/Button';

export interface SaveButtonProps {
  onClick: () => void;
  label: string;
}

export function SaveButton({onClick, label}: SaveButtonProps) {
  return (
    <Button
      onClick={onClick}
      variant="secondary"
      size="sm"
      icon={<SaveIcon className="w-4 h-4" />}
      keyboardShortcut={['mod', 'S']}
      title="Save code"
    >
      {label}
    </Button>
  );
}
