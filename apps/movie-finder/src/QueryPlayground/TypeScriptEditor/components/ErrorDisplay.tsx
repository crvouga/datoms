export interface ErrorDisplayProps {
  error: string | null;
}

export function ErrorDisplay({error}: ErrorDisplayProps) {
  if (!error) return null;

  return (
    <div className="p-4 bg-red-900/20 border-l-4 border-red-500">
      <div className="font-semibold text-red-400 mb-1">Error</div>
      <div className="text-red-300 font-mono text-sm whitespace-pre-wrap">{error}</div>
    </div>
  );
}
