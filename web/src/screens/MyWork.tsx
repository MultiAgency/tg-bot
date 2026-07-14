import { api } from '../api';
import { useAsync, Loading, Empty, tid } from '../lib';
import { tick } from '../telegram';

const STATUS_CLASS: Record<string, string> = {
  applied: 'applied',
  assigned: 'assigned',
  completed: 'completed',
  rejected: 'rejected',
  declined: 'declined',
};

/** The caller's own applications with live submission status. Server-scoped to
 *  the verified Telegram user — never anyone else's work. */
export function MyWork({ onOpen }: { onOpen: (id: number) => void }) {
  const { data, loading, error } = useAsync(() => api.myApplications(), []);

  if (loading) return <Loading />;
  if (error) return <Empty mark="⚠" title="Couldn’t load your work" hint="Pull to refresh, or reopen from the bot." />;
  const apps = data ?? [];
  if (apps.length === 0) return <Empty mark="✎" title="No applications yet" hint="Browse the board and apply to a task." />;

  return (
    <div className="ledger">
      {apps.map((a, i) => (
        <button
          key={a.applicationId}
          className="entry"
          style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
          onClick={() => {
            tick();
            onOpen(a.taskId);
          }}
        >
          <div className="top">
            <span className="id">{tid(a.taskId)}</span>
            <span className={`chip ${STATUS_CLASS[a.status] ?? ''}`}>{a.status}</span>
          </div>
          <div className="title">{a.title}</div>
          <div className="meta">
            {a.submission ? (
              <span className="dim">work v{a.submission.version} · {a.submission.status}</span>
            ) : (
              <span className="dim">no submission yet</span>
            )}
          </div>
        </button>
      ))}
    </div>
  );
}
