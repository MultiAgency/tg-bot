import { api, fetchBotUsername } from '../api';
import { useAsync, Loading, Empty, tid } from '../lib';
import { openBot } from '../telegram';

/** Full task view. Apply/submit stay in the bot, so the primary action deep-links
 *  into the bot's apply wizard rather than mutating from here. */
export function TaskDetail({ taskId, onBack }: { taskId: number; onBack: () => void }) {
  const { data, loading, error } = useAsync(() => api.taskDetail({ taskId }), [taskId]);
  const botQuery = useAsync(() => fetchBotUsername(), []);
  const bot = botQuery.data ?? '';

  if (loading) return <Loading />;
  if (error) return <Empty mark="⚠" title="Couldn’t load the task" hint="Reopen it from the board, or try again in a moment." />;
  if (!data)
    return (
      <div className="detail">
        <button className="back" onClick={onBack}>
          ‹ back to board
        </button>
        <Empty mark="∅" title="Task not found" hint="It may have been closed or erased." />
      </div>
    );

  const full = data.assigned >= data.maxAssignees;
  const canApply = data.status === 'open' && !full;

  return (
    <div className="detail">
      <button className="back" onClick={onBack}>
        ‹ back to board
      </button>
      <h2>{data.title}</h2>

      <div className="facts">
        <div className="fact">
          <span className="k">Task</span>
          <span className="v">{tid(data.id)}</span>
        </div>
        <div className="fact">
          <span className="k">Reward</span>
          <span className="v" style={{ color: 'var(--accent)' }}>{data.reward ? `◈ ${data.reward}` : '—'}</span>
        </div>
        <div className="fact">
          <span className="k">Deadline</span>
          <span className="v">{data.deadline ?? '—'}</span>
        </div>
        <div className="fact">
          <span className="k">Slots</span>
          <span className="v">
            {data.assigned}/{data.maxAssignees}
          </span>
        </div>
        <div className="fact">
          <span className="k">Status</span>
          <span className="v">{data.status}</span>
        </div>
      </div>

      <div className="section-label">Brief</div>
      <div className="prose">{data.description}</div>

      {data.requiredOutput && (
        <>
          <div className="section-label">Definition of done</div>
          <div className="prose">{data.requiredOutput}</div>
        </>
      )}

      {canApply ? (
        botQuery.loading ? (
          <button className="cta" disabled>
            Loading…
          </button>
        ) : bot ? (
          <button className="cta" onClick={() => openBot(`https://t.me/${bot}?start=t${data.id}`)}>
            Apply in the bot →
          </button>
        ) : (
          <button className="cta ghost" disabled>
            Reopen from the bot to apply
          </button>
        )
      ) : (
        <button className="cta ghost" disabled>
          {full ? 'Fully assigned' : `Not open (${data.status})`}
        </button>
      )}
    </div>
  );
}
