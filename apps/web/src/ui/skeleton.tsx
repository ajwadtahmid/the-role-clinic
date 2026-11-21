// A grey placeholder shaped like the content that is loading, so a slow screen never looks empty or broken.
export function Skeleton({ lines = 3, label = 'Loading…' }: { lines?: number; label?: string }) {
  return <div className="skeleton" role="status" aria-busy="true"><span className="sr-only">{label}</span>{Array.from({ length: lines }, (_, i) => <i key={i} className="skeleton-line" style={{ width: `${i === lines - 1 ? 55 : 100 - (i % 3) * 12}%` }} aria-hidden="true" />)}</div>
}
