/**
 * Live smoke test for signal evaluation — the one path the stubbed demos can't
 * cover: whether the REAL model (AI_MODEL on NEAR AI Cloud) returns the new JSON
 * shape well under the slimmed house style. Calls evaluateSignal directly (no DB,
 * no Telegram) against a spread of messages straddling the draft/skip boundary,
 * and prints each parsed draft so a human can eyeball quality.
 *
 * Run (key + model come from .env; DATABASE_URL is only to satisfy config's
 * import-time check — nothing here connects):
 *   DATABASE_URL=postgresql://x tsx scripts/ai-smoke.ts
 */
import { config } from '../src/config.js';
import { aiEnabled, evaluateSignal } from '../src/ai/assist.js';

interface Case {
  label: string;
  message: string;
  /** What a well-behaved model should do — for a pass/fail hint, not a hard assert. */
  expectDraft: boolean;
  /** Prior room chatter, oldest first — exercises the context window. */
  context?: string[];
}

// A spread across the decision boundary: clear commissions that should draft,
// and banter / vague / questions that a conservative detector should skip.
const CASES: Case[] = [
  {
    label: 'clear multi-deliverable commission',
    message:
      'Hey team, we just shipped the v2 vault contract on mainnet. Can someone put together a short ' +
      'explainer thread and a 30s demo video before the Korea meetup this Friday?',
    expectDraft: true,
  },
  {
    label: 'clear single-deliverable ask with a deadline',
    message: 'Can someone translate our onboarding docs into Spanish before next week’s community call?',
    expectDraft: true,
  },
  {
    label: 'milestone worth amplifying',
    message: 'We just crossed 10,000 registered builders on the platform — big one for the ecosystem.',
    expectDraft: true,
  },
  {
    label: 'banter (should skip)',
    message: 'lol that meme in the other channel was hilarious, whoever made it is a genius',
    expectDraft: false,
  },
  {
    label: 'vague idea (should skip)',
    message: 'we should probably do more marketing at some point, feels like nobody knows about us',
    expectDraft: false,
  },
  {
    label: 'question (should skip)',
    message: 'does anyone know when the next NEAR hackathon is happening?',
    expectDraft: false,
  },
  {
    label: 'thin alone, but context supplies the deadline + scope',
    message: 'yeah someone should make that video',
    expectDraft: true,
    context: [
      'the Seoul meetup recap footage is all uploaded to the drive folder',
      'we should turn it into a 60-second highlight reel for Twitter',
      'ideally before the next meetup announcement goes out Thursday',
    ],
  },
];

function render(c: Case): Promise<boolean> {
  const { label, message, expectDraft, context = [] } = c;
  return evaluateSignal(message, context).then((ev) => {
    console.log(`\n── ${label}`);
    if (context.length) console.log(`   context: ${context.join(' | ')}`);
    console.log(`   msg: ${message}`);
    if (ev === null) {
      console.log('   ⚠️  null — API error or unparseable reply');
      return false;
    }
    const drafts = ev.shouldDraft && ev.score >= config.signalScoreThreshold;
    const agree = drafts === expectDraft;
    console.log(
      `   score=${ev.score} shouldDraft=${ev.shouldDraft} → ${drafts ? 'DRAFT' : 'skip'} ` +
        `${agree ? '✅' : '❌ (expected ' + (expectDraft ? 'DRAFT' : 'skip') + ')'}`,
    );
    if (drafts) {
      console.log(`   title:        ${ev.title ?? '(none)'}`);
      console.log(`   deadline:     ${ev.deadline ?? '(none)'}`);
      console.log(`   maxAssignees: ${ev.maxAssignees ?? '(default 1)'}`);
      console.log(`   description:  ${ev.description ?? '(none)'}`);
      console.log(`   requiredOutput:\n${(ev.requiredOutput ?? '(none)').replace(/^/gm, '     ')}`);
    }
    return agree;
  });
}

async function main(): Promise<void> {
  if (!aiEnabled()) {
    console.error('AI is disabled — set NEAR_AI_API_KEY in .env.');
    process.exit(1);
  }
  console.log(`Model: ${config.aiModel}   Threshold: ${config.signalScoreThreshold}`);
  let agreed = 0;
  // Sequential on purpose: readable output, and it stays inside a single room's
  // real-world pace rather than hammering the endpoint.
  for (const c of CASES) {
    if (await render(c)) agreed += 1;
  }
  console.log(`\n${agreed}/${CASES.length} matched the expected draft/skip call.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
