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
  // Mini App web server: the port the bot process serves the web app + oRPC API
  // on (Railway injects PORT). 0 (unset) leaves the web server off, so the plain
  // bot deployment is unchanged. Shares this process's Postgres pool.
  webPort: positiveNumber('WEB_PORT', 0) || positiveNumber('PORT', 0),
  // Public HTTPS origin the Mini App is served from (e.g. https://app.example.com)
  // — used to wire the Telegram menu button / web_app button. Empty leaves them off.
  webAppUrl: process.env.WEB_APP_URL ?? '',
  // NEAR payout: the claim-escrow contract account (contracts/escrow — the
  // treasury allocates+funds, the contributor pulls; the bot never signs) and
  // the network it lives on. Empty escrow id leaves the claim UI dormant.
  nearNetwork: process.env.NEAR_NETWORK ?? 'testnet',
  escrowContractId: process.env.ESCROW_CONTRACT_ID ?? '',
  // The escrow owner / treasury account (signs `allocate`). The bot never holds
  // its key — /payouts just prints the exact command for a treasury admin to run.
  nearTreasuryId: process.env.NEAR_TREASURY_ID ?? '',
} as const;

export function isAdmin(telegramId: number | undefined): boolean {
  return telegramId !== undefined && config.adminIds.has(telegramId);
}

if (config.adminIds.size === 0) {
  console.warn(
    '[config] ADMIN_IDS is empty — no one can create, approve, or review tasks. Set ADMIN_IDS in .env.',
  );
}
