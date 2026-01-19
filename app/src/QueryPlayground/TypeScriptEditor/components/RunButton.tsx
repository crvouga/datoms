import { PlayIcon } from "../../ui/icons";
import { Button } from "../../ui/Button";

export interface RunButtonProps {
  onClick: () => void;
  loading: boolean;
  label: string;
}

export function RunButton({ onClick, loading, label }: RunButtonProps) {
  return (
    <Button
      onClick={onClick}
      loading={loading}
      loadingText="Running..."
      variant="primary"
      icon={<PlayIcon className="w-4 h-4" />}
      keyboardShortcut={["mod", "Enter"]}
      title="Run code"
    >
      {label}
    </Button>
  );
}
