/**
 * Live settlement pass: reconcile the EXISTING 'proposed' payout queue against the
 * real DAO — the headless equivalent of the bot's /payouts reconcile-on-view. Use
 * it to advance the live queue from the CLI (before the full bot is deployed), and
 * to verify the last on-chain transition the dry-run couldn't: proposed → paid,
 * once a council member has APPROVED the proposal in the DAO UI.
 *
 * Unlike dao-propose-live.ts this does NOT resetDb / seed — it reconciles the rows
 * already in the DB. It wires the paid-DM notifier exactly as boot does, so a
 * proposed→paid flip enqueues the "paid" notification (observable here; actual
 * Telegram delivery needs the running worker + a real contributor).
 *
 * Run (point DATABASE_URL at the DB holding the proposed rows; NOT a _test DB):
 *   DAO_CONTRACT_ID=multiagency.sputnikv2.testnet \
 *   DATABASE_URL=postgresql://multiagency:multiagency@localhost:5455/multiagency \
 *   BOT_TOKEN=000000:demo ADMIN_IDS=1 npx tsx scripts/dao-settle-live.ts
 * (OUTLAYER_API_KEY is NOT needed — reconcile only READS the chain.)
 */
import {
  listPayoutsByStatus,
  proposalWindow,
  reconcilePayout,
  setPayoutPaidNotifier,
} from '../src/core/service.js';
import { getById } from '../src/core/models/payout.js';
import { findByDedup } from '../src/core/models/notification.js';
import { notifyPayoutPaid } from '../src/bot/notify.js';
import { getProposal, getPolicy, effectiveProposalStatus } from '../src/near/dao.js';
import { runScript } from './run.js';

// Same wiring as src/index.ts boot: the reconciler DMs the owner on proposed→paid.
setPayoutPaidNotifier(notifyPayoutPaid);

async function main(): Promise<void> {
  const proposed = await listPayoutsByStatus(['proposed']);
  if (proposed.length === 0) {
    console.log('No proposed payouts to settle — the queue is empty.');
    return;
  }
  console.log(`Reconciling ${proposed.length} proposed payout(s) against the DAO...\n`);
  const policy = await getPolicy();
  // One shared proposal-window snapshot for the whole run — the per-operation
  // convention every product surface (/payouts, myPayouts, /forget) follows;
  // without it each row's twin-scan refetches an up-to-1000-proposal page.
  const window = proposalWindow();

  let paid = 0;
  for (const p of proposed) {
    console.log(
      `payout #${p.id} (task #${p.task_id}) → ${p.account_id} · ${p.amount_yocto} yocto · proposal_id=${p.proposal_id}`,
    );

    // Context: what the chain says about the pinned proposal right now.
    if (p.proposal_id != null) {
      const proposal = await getProposal(p.proposal_id);
      if (proposal) {
        console.log(
          `  proposal #${p.proposal_id}: raw=${proposal.status} → effective=${effectiveProposalStatus(proposal, policy, Date.now())}`,
        );
      } else {
        console.log(`  proposal #${p.proposal_id}: not found on-chain`);
      }
    }

    const rec = await reconcilePayout(p, window);
    const after = await getById(p.id);
    console.log(`  reconcile: ${JSON.stringify(rec)} → ledger status=${after?.status}`);

    if (after?.status === 'paid') {
      paid += 1;
      // The paid DM enqueues inside the same transaction as the status flip.
      const dm = await findByDedup(`payout-paid:${p.id}`);
      console.log(
        dm
          ? `  ✅ paid DM enqueued (dedup payout-paid:${p.id}, status=${dm.status}): "${dm.text}"`
          : `  ⚠ paid but NO payout-paid:${p.id} row — notifier not wired? (should be impossible)`,
      );
    } else if (rec.attention) {
      console.log('  ⚠ needs a human: transfer FAILED (treasury balance?) or the proposal was voted down.');
    }
    console.log('');
  }

  console.log(
    `Done — ${paid}/${proposed.length} settled to paid this pass.` +
      (paid < proposed.length ? ' The rest are still awaiting a vote / finality; re-run after approval.' : ''),
  );
  console.log(
    '\nNote: this verifies settlement + DM ENQUEUE against the live chain. Real Telegram delivery ' +
      'needs the running worker + a real contributor who has started the bot (the prod pilot pass).',
  );
}

runScript(main);
