import dotenv from 'dotenv';

// Local developer overrides load FIRST (first file wins in dotenv), so a
// gitignored .env.local can carry machine-local values — the throwaway bot
// token for live local runs, a web port, a tunnel URL — without touching the
// shared .env. Real environment variables still beat both (dotenv never
// overrides an already-set var), which is what the demo scripts rely on.
// .env.local is never deployed; production reads real env vars via .env alone.
dotenv.config({ path: ['.env.local', '.env'] });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example.`);
  }
  return value;
}

/**
 * Numeric env var, or `fallback` when unset. A malformed value falls back too
 * (with a warning) instead of propagating NaN — NaN here would silently disable
 * the guardrail the variable configures (rate limiting, the application cap).
 */
function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`[config] ${name}="${raw}" is not a positive number — using ${fallback}.`);
    return fallback;
  }
  return n;
}

const adminIds = new Set(
  (process.env.ADMIN_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map(Number)
    // Drop malformed entries so a typo can't silently suppress the empty-admins
    // warning below (a NaN entry never matches a real user, but inflates .size).
    .filter((id) => Number.isInteger(id)),
);

export const config = {
  botToken: required('BOT_TOKEN'),
  adminIds,
  // PostgreSQL connection string (Railway injects DATABASE_URL). Local dev/CI use
  // the docker-compose Postgres; see README.
  databaseUrl: required('DATABASE_URL'),
  // AI assistance runs on NEAR AI Cloud (OpenAI-compatible API).
  nearAiApiKey: process.env.NEAR_AI_API_KEY ?? '',
  nearAiBaseUrl: process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1',
  // Default is a NEAR-native private-TEE chat model, verified against the gateway.
  // Avoid reasoning-style models (gpt-oss, qwen3.x) — they spend the whole token
  // budget on reasoning_content and return empty content for short completions.
  aiModel: process.env.AI_MODEL ?? 'deepseek-ai/DeepSeek-V4-Flash',
  // The conversational agent (group /ai mode) runs a tool-calling loop, which
  // needs reliable, well-formed tool_calls — DeepSeek-Flash emits malformed
  // arguments, so the agent defaults to a stronger model on the same NEAR AI
  // endpoint. Signal scoring stays on the cheaper aiModel.
  agentModel: process.env.AGENT_MODEL ?? 'anthropic/claude-haiku-4-5',
  // Public-launch guardrails: cap how many open (undecided) applications one
  // contributor can hold at once, to stop apply-spam.
  maxOpenApplications: positiveNumber('MAX_OPEN_APPLICATIONS', 5),
  // Optional group/channel (numeric id or @username) where newly opened tasks
  // are announced. The primary public-discovery surface; never carries state.
  // Accepts any chat — a private/public group or a broadcast channel (Telegram
  // calls them all "chats").
  announceChatId: process.env.ANNOUNCE_CHAT_ID ?? '',
  // Bot @username (without the @). When set, the announcement post carries a
  // deep-link "Apply" button (t.me/<username>?start=t<taskId>); without it the
  // post falls back to a "/open" instruction.
  botUsername: (process.env.BOT_USERNAME ?? '').replace(/^@/, ''),
  // Global cap on outbound notifications per second, applied across the whole
  // queue by the single delivery worker (Telegram's bulk limit is ~30/s).
  // Fractional rates are honored — sub-1 values are a deliberate slow-down.
  notifyRatePerSec: positiveNumber('NOTIFY_RATE_PER_SEC', 25),
  // Signal detection (opt-in per group via /enablesignals): minimum AI score
  // (0–10) a message must reach to become a Draft task — an operator-tunable
  // gate on top of the model's own judgment.
  signalScoreThreshold: positiveNumber('SIGNAL_SCORE_THRESHOLD', 6),
  // Cap on AI evaluations per room per hour, enforced against stored signal
  // rows so it survives restarts. Bounds the AI bill of a flooded group.
  signalMaxPerHour: positiveNumber('SIGNAL_MAX_PER_HOUR', 20),
  // Global (all rooms combined) hourly cap on signal evaluations. The per-room
  // cap alone scales linearly with rooms, and any group join registers a room —
  // this is the actual ceiling on the signal-scoring AI bill.
  signalGlobalMaxPerHour: positiveNumber('SIGNAL_GLOBAL_MAX_PER_HOUR', 200),
  // Cap on conversational-agent turns per room per hour (group /ai mode). The
  // agent is the EXPENSIVE path — up to several completions on the stronger
  // agentModel per addressed message — and /ai on is reachable by anyone who
  // adds the bot to a group, so without this a scripted @mention loop buys
  // unbounded model spend. RAM-only counter (see claimAgentSlot in ai/agent.ts).
  agentMaxPerHour: positiveNumber('AGENT_MAX_PER_HOUR', 20),
  // Global (all rooms combined) hourly cap on agent turns — the ceiling on the
  // expensive model's bill, for the same reason as SIGNAL_GLOBAL_MAX_PER_HOUR.
  // RAM-only like the per-room counter (see claimAgentSlot).
  agentGlobalMaxPerHour: positiveNumber('AGENT_GLOBAL_MAX_PER_HOUR', 200),
  // Days an Assigned task can sit with no submission activity before /admin
  // counts it as stale (claim-and-abandon surfacing; act via /active, /unassign).
  staleAssignedDays: positiveNumber('STALE_ASSIGNED_DAYS', 7),
  // Mini App web server: the port the bot process serves the web app + oRPC API
  // on (Railway injects PORT). 0 (unset) leaves the web server off, so the plain
  // bot deployment is unchanged. Shares this process's Postgres pool.
  webPort: positiveNumber('WEB_PORT', 0) || positiveNumber('PORT', 0),
  // Public HTTPS origin the Mini App is served from (e.g. https://app.example.com)
  // — used to wire the Telegram menu button / web_app button. Empty leaves them off.
  webAppUrl: process.env.WEB_APP_URL ?? '',
  // The NEAR network payouts settle on. Normalized to EXACTLY 'mainnet' |
  // 'testnet': downstream code compares this string (chain clients, account
  // existence checks), so an unnormalized value ("Mainnet", "sandbox") would
  // silently misbehave.
  nearNetwork: ((): 'mainnet' | 'testnet' => {
    const raw = (process.env.NEAR_NETWORK ?? 'testnet').trim().toLowerCase();
    if (raw === 'mainnet') return 'mainnet';
    if (raw !== 'testnet' && raw !== '') {
      console.warn(`[config] NEAR_NETWORK="${process.env.NEAR_NETWORK}" is not mainnet/testnet — using testnet.`);
    }
    return 'testnet';
  })(),
  // The Sputnik DAO the push-payout model settles through (add_proposal Transfer,
  // council-approved — see PAYOUTS.md). This id drives read-only reconciliation;
  // the add_proposal WRITE is signed via OutLayer below (or an admin's own
  // wallet), never with a fund-moving key. Empty leaves the DAO path dormant.
  daoContractId: process.env.DAO_CONTRACT_ID ?? '',
  // OutLayer agent custody (fastnear.com): the bot's DAO-Requestor wallet whose
  // signing key lives in a TEE — the bot holds only this API key, never a key that
  // can move funds. Used ONLY to submit add_proposal (propose-only, non-custodial;
  // the DAO's human Approver vote still gates payment). It is the ONLY proposer
  // path: empty leaves /pay refusing with guidance (no printed-command fallback —
  // a replayable out-of-band command was the root of the duplicate-proposal
  // hazard). Base URL derives from NEAR_NETWORK when unset.
  outlayerApiKey: process.env.OUTLAYER_API_KEY ?? '',
  outlayerBaseUrl: process.env.OUTLAYER_BASE_URL ?? '',
  // URL template for viewing a DAO proposal in a governance UI (the operator's
  // dashboard, Astro, etc.), with `{id}` replaced by the proposal id. Powers the
  // "verify before voting" deep links on /pay and /payouts. Empty → no links
  // (ids are still shown). The vote itself always happens in that external UI —
  // the bot never carries a voting affordance.
  daoProposalUrl: process.env.DAO_PROPOSAL_URL ?? '',
  // Where a confused user (or one with a payout question) can reach a human —
  // an @handle, URL, or email, surfaced verbatim in /help, /privacy, and
  // /terms. Empty hides the line; set it before a public launch.
  supportContact: process.env.SUPPORT_CONTACT ?? '',
} as const;

export function isAdmin(telegramId: number | undefined): boolean {
  return telegramId !== undefined && config.adminIds.has(telegramId);
}

if (config.adminIds.size === 0) {
  console.warn(
    '[config] ADMIN_IDS is empty — no one can create, approve, or review tasks. Set ADMIN_IDS in .env.',
  );
}

if (config.daoProposalUrl !== '' && !config.daoProposalUrl.includes('{id}')) {
  console.warn('[config] DAO_PROPOSAL_URL has no {id} placeholder — proposal links will not resolve per-proposal.');
}
