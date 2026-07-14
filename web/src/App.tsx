import { useState } from 'react';
import { initData } from './telegram';
import { Board } from './screens/Board';
import { MyWork } from './screens/MyWork';
import { Claim } from './screens/Claim';
import { TaskDetail } from './screens/TaskDetail';

type Tab = 'board' | 'mine' | 'claim';
export type View = { tab: Tab } | { tab: Tab; taskId: number };

export function App() {
  const [view, setView] = useState<View>({ tab: 'board' });

  // No initData means we're not inside Telegram — the API can't authenticate,
  // so guide the user there rather than showing perpetual spinners.
  if (!initData) {
    return (
      <div className="empty">
        <span className="mark">✦</span>
        <p>Open this inside Telegram</p>
        <p className="dim">The MultiAgency board runs as a Telegram Mini App.</p>
      </div>
    );
  }

  const openTask = (taskId: number) => setView({ tab: view.tab, taskId });
  const clearTask = () => setView({ tab: view.tab });
  const goTab = (tab: Tab) => setView({ tab });

  return (
    <>
      <header className="masthead">
        <h1>MultiAgency</h1>
        <span className="edition">the ledger</span>
      </header>

      {'taskId' in view ? (
        <TaskDetail taskId={view.taskId} onBack={clearTask} />
      ) : view.tab === 'board' ? (
        <Board onOpen={openTask} />
      ) : view.tab === 'mine' ? (
        <MyWork onOpen={openTask} />
      ) : (
        <Claim />
      )}

      <nav className="tabs">
        <button className={view.tab === 'board' && !('taskId' in view) ? 'active' : ''} onClick={() => goTab('board')}>
          Board
        </button>
        <button className={view.tab === 'mine' && !('taskId' in view) ? 'active' : ''} onClick={() => goTab('mine')}>
          My work
        </button>
        <button className={view.tab === 'claim' && !('taskId' in view) ? 'active' : ''} onClick={() => goTab('claim')}>
          Payouts
        </button>
      </nav>
    </>
  );
}
