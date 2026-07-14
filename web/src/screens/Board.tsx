import { useMemo, useState } from 'react';
import { api } from '../api';
import { useAsync, Loading, Empty, tid } from '../lib';
import { tick } from '../telegram';

/** The open-task board: a filterable ledger of bounties. Tapping an entry opens
 *  its detail; applying happens back in the bot (mutations stay there). */
export function Board({ onOpen }: { onOpen: (id: number) => void }) {
  const { data, loading, error } = useAsync(() => api.openTasks(), []);
  const [q, setQ] = useState('');

  const tasks = useMemo(() => {
    const list = data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((t) => t.title.toLowerCase().includes(needle) || (t.reward ?? '').toLowerCase().includes(needle));
  }, [data, q]);

  if (loading) return <Loading />;
  if (error) return <Empty mark="⚠" title="Couldn’t load the board" hint="Pull to refresh, or reopen from the bot." />;
  if ((data ?? []).length === 0) return <Empty mark="✦" title="No open tasks yet" hint="New bounties are announced in the channel." />;

  return (
    <>
      <div className="filterbar">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by title or reward…" />
      </div>
      <div className="ledger">
        {tasks.map((t, i) => {
          const full = t.assigned >= t.maxAssignees;
          return (
            <button
              key={t.id}
              className="entry"
              style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
              onClick={() => {
                tick();
                onOpen(t.id);
              }}
            >
              <div className="top">
                <span className="id">{tid(t.id)}</span>
                <span className={`chip ${full ? 'full' : 'open'}`}>{full ? 'full' : `${t.assigned}/${t.maxAssignees}`}</span>
              </div>
              <div className="title">{t.title}</div>
              <div className="meta">
                {t.reward && <span className="reward">◈ {t.reward}</span>}
                {t.deadline && <span className="dim">⏳ {t.deadline}</span>}
              </div>
            </button>
          );
        })}
        {tasks.length === 0 && <Empty mark="⌕" title="No match" hint="Try a different word." />}
      </div>
    </>
  );
}
