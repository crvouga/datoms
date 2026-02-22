export interface LatencyDisplayProps {
  latency: number | null;
}

export function LatencyDisplay({latency}: LatencyDisplayProps) {
  if (latency === null) return null;

  const formattedLatency =
    latency < 1
      ? `${(latency * 1000).toFixed(2)}μs`
      : latency < 1000
        ? `${latency.toFixed(2)}ms`
        : `${(latency / 1000).toFixed(2)}s`;

  return (
    <div className="px-4 py-2 text-sm text-gray-400 font-mono border-b border-gray-700">
      Execution time: {formattedLatency}
    </div>
  );
}
