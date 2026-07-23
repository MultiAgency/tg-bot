/**
 * Live read of the configured Sputnik DAO via dao.ts readers — verifies the reader
 * shapes against a real contract (get_policy / get_last_proposal_id / get_proposals)
 * and the status mapping. Run:
 *   DAO_CONTRACT_ID=multiagency.sputnikv2.testnet npx tsx scripts/dao-live.ts
 */
import {
  getPolicy,
  getLastProposalId,
  getProposals,
  effectiveProposalStatus,
  formatYoctoNear,
  transferKind,
  buildAddProposalArgs,
  payoutDescription,
  type TransferKind,
} from '../src/near/dao.js';
import { proposalToPayout } from '../src/core/service.js';
import { config } from '../src/config.js';

/** The near-cli command to submit the Transfer proposal — OPS DIAGNOSTIC ONLY,
 *  which is why it lives HERE and not in src/near/dao.ts: a printable,
 *  replayable add_proposal command was the root of the duplicate-proposal
 *  hazard, so production keeps no way to mint one (the OutLayer TEE wallet is
 *  the single proposer). This script prints it for manual shape-verification
 *  against a testnet DAO; `<BOND>` is `get_policy().proposal_bond` (in NEAR). */
function proposalCommand(description: string, kind: TransferKind): string {
  const dao = config.daoContractId || '<dao>.sputnik-dao.near';
  const args = JSON.stringify(buildAddProposalArgs(description, kind));
  return (
    `near contract call-function as-transaction ${dao} add_proposal ` +
    `json-args '${args}' prepaid-gas '270 Tgas' attached-deposit '<BOND> NEAR' ` +
    `sign-as <admin> network-config ${config.nearNetwork} sign-with-legacy-keychain send`
  );
}

async function main(): Promise<void> {
  const dao = process.env.DAO_CONTRACT_ID;
  console.log(`Reading DAO: ${dao}\n`);

  const policy = await getPolicy();
  console.log(`proposal_bond   = ${policy.proposal_bond}  (${formatYoctoNear(policy.proposal_bond)} NEAR)`);
  console.log(`proposal_period = ${policy.proposal_period}  (${(Number(policy.proposal_period) / 1e9 / 86400).toFixed(2)} days)`);

  const last = await getLastProposalId();
  console.log(`last_proposal_id = ${last}`);

  const from = Math.max(0, last - 5);
  const recent = await getProposals(from, 5);
  const now = Date.now();
  console.log(`\nrecent proposals [${from}..${last}) — ${recent.length}:`);
  for (const p of recent) {
    const eff = effectiveProposalStatus(p, policy, now);
    console.log(`  #${p.id}  ${p.status} → ${eff} → ledger:${proposalToPayout(eff).status}  "${p.description.slice(0, 50)}"`);
  }

  // Build (do NOT submit) a sample payout Transfer to the recipient — verifies the
  // builder shapes + the bond against the real policy.
  const recipient = process.env.PAYOUT_RECIPIENT || 'webfoundry.testnet';
  const kind = transferKind(recipient, '10000000000000000000000'); // 0.01 NEAR (raw yocto)
  const desc = payoutDescription(1, 1);
  console.log(`\n--- sample Transfer proposal to ${recipient} (build only, NOT submitted) ---`);
  console.log(`args = ${JSON.stringify(buildAddProposalArgs(desc, kind))}`);
  console.log(`bond = ${policy.proposal_bond} yocto (${formatYoctoNear(policy.proposal_bond)} NEAR)`);
  console.log(`cli  = ${proposalCommand(desc, kind)}`);

  console.log(`\n✅ dao.ts readers + builders live-verified against ${dao}`);
}

main().catch((e) => {
  console.error('✗', e instanceof Error ? e.message : e);
  process.exit(1);
});
