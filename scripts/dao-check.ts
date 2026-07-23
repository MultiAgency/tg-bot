/**
 * Standalone check for dao.ts's pure proposal-status mapping — no network, no DB.
 * Part of the `npm test` gate (`npm run dao-check`); the live counterpart
 * (scripts/dao-live.ts) verifies the same readers against a real DAO.
 */
import { effectiveProposalStatus, type Proposal, type Policy } from '../src/near/dao.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = 1_800_000_000_000; // fixed "now" in ms
const policy: Policy = {
  proposal_bond: '100000000000000000000000', // 0.1 NEAR
  proposal_period: String(7n * 24n * 60n * 60n * 1_000_000_000n), // 7 days, nanos
};

function prop(status: Proposal['status'], submittedMsAgo: number): Proposal {
  return {
    id: 1,
    description: 'multiagency payout #1 task #1',
    kind: {},
    status,
    submission_time: String(BigInt(now - submittedMsAgo) * 1_000_000n), // ms → nanos
  };
}

let failed = 0;
function eq(label: string, got: string, want: string): void {
  if (got !== want) {
    console.error(`  ✗ ${label}: got ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`  ✓ ${label} → ${got}`);
  }
}

eq('Approved → Executed', effectiveProposalStatus(prop('Approved', 0), policy, now), 'Executed');
eq('Failed → Failed', effectiveProposalStatus(prop('Failed', 0), policy, now), 'Failed');
eq('Rejected → Rejected', effectiveProposalStatus(prop('Rejected', 0), policy, now), 'Rejected');
eq('Removed → Removed', effectiveProposalStatus(prop('Removed', 0), policy, now), 'Removed');
eq('Moved → Moved', effectiveProposalStatus(prop('Moved', 0), policy, now), 'Moved');
eq('Expired(raw) → Expired', effectiveProposalStatus(prop('Expired', 0), policy, now), 'Expired');
eq('InProgress 6d ago (within window) → Pending', effectiveProposalStatus(prop('InProgress', 6 * DAY_MS), policy, now), 'Pending');
eq('InProgress 8d ago (past window) → Expired', effectiveProposalStatus(prop('InProgress', 8 * DAY_MS), policy, now), 'Expired');

if (failed) {
  console.error(`\n${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\n✅ dao status mapping OK');
