import { useEffect, useState } from 'react';

/** Minimal data-fetch hook: runs `fn` on mount (and when `deps` change), tracking
 *  loading / data / error. Ignores a resolution after unmount. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    fn().then(
      (data) => alive && setState({ data, loading: false }),
      (err: unknown) => alive && setState({ error: err instanceof Error ? err.message : 'Something went wrong', loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export const Loading = () => (
  <div className="loading">
    <div className="spinner" />
  </div>
);

export const Empty = ({ mark, title, hint }: { mark: string; title: string; hint?: string }) => (
  <div className="empty">
    <span className="mark">{mark}</span>
    <p>{title}</p>
    {hint && <p className="dim">{hint}</p>}
  </div>
);

/** Zero-padded ledger id, e.g. #007. */
export const tid = (id: number) => `#${String(id).padStart(3, '0')}`;
