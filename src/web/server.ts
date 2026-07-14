import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { RPCHandler } from '@orpc/server/fetch';
import { config } from '../config.js';
import { one } from '../core/db.js';
import { upsertContributor, getWalletLink, upsertWalletLink, WorkflowError } from '../core/service.js';
import { validateInitData, type TelegramUser } from './auth.js';
import { router } from './api.js';
import { issueNonce, consumeNonce, verifyLinkProof, LINK_MESSAGE, LINK_RECIPIENT, linkNetwork } from './near.js';

/** Hono context variables set by the auth middleware. */
type Vars = { user: TelegramUser };

/**
 * Gate: every /api route requires a valid Telegram Mini App initData, passed as
 * `Authorization: tma <initData>` (the Mini App convention). It is re-validated
 * per request — initData is small and cheap to check, and this keeps the web
 * tier stateless (no session store) until Better Auth + the NEAR wallet link
 * arrive in a later stage. On success the verified Telegram user is on the
 * context; a forged/absent/stale payload is a flat 401.
 */
const requireTelegramAuth: MiddlewareHandler<{ Variables: Vars }> = async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  const initData = auth.startsWith('tma ') ? auth.slice(4) : '';
  // A 401's reason (absent header vs which validation check failed) is an
  // operational signal worth a log line; neither branch logs payload content —
  // initData is replayable within its freshness window, i.e. a credential.
  if (!initData) {
    console.warn(`[web] 401 no-initData path=${c.req.path}`);
    return c.json({ error: 'unauthorized' }, 401);
  }
  try {
    c.set('user', validateInitData(initData).user);
  } catch (err) {
    console.warn(`[web] 401 invalid-initData path=${c.req.path} reason="${err instanceof Error ? err.message : err}"`);
    return c.json({ error: 'invalid initData' }, 401);
  }
  return next();
};

/**
 * The Mini App's web tier: a Hono app served INSIDE the bot process (started
 * from main() in src/index.ts when WEB_PORT/PORT is set), sharing this process's
 * Postgres pool through ../core/db — one Railway service, one database, one
 * connection pool. Read-mostly by design: every mutation stays in the bot, so
 * this tier only reads (open tasks, a contributor's own work) and, in later
 * stages, links a NEAR wallet and settles approved payouts. Kept behind the port
 * flag so the plain bot deployment is unchanged until the web app is wired up.
 */
export function createWebApp(): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();

  // Minimal hardening on every response. `no-referrer` keeps any URL (query
  // string included) out of the Referer header sent to telegram.org and the font
  // CDNs the page loads; `nosniff` blocks MIME-type confusion on static assets.
  // Deliberately NOT setting X-Frame-Options/CSP frame-ancestors — Telegram Web
  // embeds the Mini App in a cross-origin iframe, which those would break.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  // Liveness + DB reachability — for Railway's health check and local smoke tests.
  app.get('/healthz', async (c) => {
    try {
      await one<{ ok: number }>('SELECT 1 AS ok');
      return c.json({ ok: true, db: 'up' });
    } catch (err) {
      console.error('[web] healthz DB check failed:', err instanceof Error ? err.message : err);
      return c.json({ ok: false, db: 'down' }, 503);
    }
  });

  // Everything under /api is Telegram-authenticated. /api/me echoes the verified
  // caller and their linked NEAR account (if any).
  app.use('/api/*', requireTelegramAuth);
  app.get('/api/me', async (c) => {
    const link = await getWalletLink(c.get('user').id);
    return c.json({ user: c.get('user'), linkedNearAccount: link?.account_id ?? null });
  });

  // ---- NEAR wallet linking (NEP-413) ----
  // Issue a fresh single-use challenge for this Telegram user; the client signs
  // it with their wallet and posts the proof back.
  app.post('/api/wallet/nonce', (c) => {
    const nonce = issueNonce(c.get('user').id);
    return c.json({
      nonce: Buffer.from(nonce).toString('base64'),
      message: LINK_MESSAGE,
      recipient: LINK_RECIPIENT,
      network: linkNetwork,
    });
  });

  // Verify the NEP-413 proof against the issued nonce (signature valid AND the
  // key is full-access on the account), then record the link for this user. The
  // caller is already Telegram-verified, so the NEAR account attaches to that id.
  //
  // Disclosure contract for the linking UI: linking leads to allocate/claim
  // transactions that put this account + task ids on the PUBLIC chain, forever —
  // beyond /forget (which erases only the stored Telegram↔account link). The
  // screen that drives this endpoint must say so at the moment of linking, in
  // line with /privacy (privacy.text) and SCOPE.md.
  app.post('/api/wallet/link', async (c) => {
    const user = c.get('user');
    const body = (await c.req.json().catch(() => null)) as
      | { accountId?: string; publicKey?: string; signature?: string; nonce?: string }
      | null;
    if (!body?.accountId || !body.publicKey || !body.signature || !body.nonce) {
      return c.json({ error: 'accountId, publicKey, signature, nonce required' }, 400);
    }
    const nonce = consumeNonce(user.id, body.nonce);
    if (!nonce) return c.json({ error: 'unknown or expired nonce — request a new one' }, 400);
    const ok = await verifyLinkProof({ accountId: body.accountId, publicKey: body.publicKey, signature: body.signature }, nonce);
    if (!ok) return c.json({ error: 'invalid signature or the key is not full-access on that account' }, 400);
    // Ensure the contributor row exists (the wallet_links FK + erasure depend on
    // it), from the verified initData profile — the same fields the bot records.
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || null;
    await upsertContributor(user.id, user.username ?? null, name, user.language_code ?? null);
    try {
      await upsertWalletLink(user.id, body.accountId, body.publicKey, linkNetwork);
    } catch (err) {
      // The service's money guards (re-link while a payout is funded to the old
      // account; an account already linked by someone else) — user-safe messages.
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 409);
      throw err;
    }
    return c.json({ accountId: body.accountId, network: linkNetwork });
  });

  // The typesafe oRPC API (read-only) — same initData gate, and the verified
  // user is threaded into each procedure's context so myApplications is caller-scoped.
  const rpc = new RPCHandler(router);
  app.use('/rpc/*', requireTelegramAuth);
  app.all('/rpc/*', async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/rpc',
      context: { user: c.get('user') },
    });
    return matched ? response : c.notFound();
  });

  // Public config the Mini App reads before it can authenticate: the bot
  // @username (Apply deep link) and the NEAR claim-escrow coordinates (so the
  // Payouts screen can query on-chain allocations and build a claim call). All
  // public — no PII, no keys.
  app.get('/config', (c) =>
    c.json({
      botUsername: config.botUsername,
      nearNetwork: config.nearNetwork,
      escrowContractId: config.escrowContractId,
    }),
  );

  // The built Mini App (web/dist), served last so the API routes above win.
  // Missing when the frontend hasn't been built (e.g. the web smoke test) — the
  // static handler just 404s, which those tests never hit.
  app.use('/assets/*', serveStatic({ root: './web/dist' }));
  app.get('/', serveStatic({ root: './web/dist', path: 'index.html' }));
  app.get('/index.html', serveStatic({ root: './web/dist' }));

  return app;
}

let server: ReturnType<typeof serve> | undefined;

/** Start the web server on `port`. A second call while running is a no-op. */
export function startWebServer(port: number): void {
  if (server) return;
  server = serve({ fetch: createWebApp().fetch, port }, (info) => {
    console.log(`🌐 Mini App web server listening on :${info.port}`);
  });
}

/** Graceful shutdown: stop accepting connections and wait for in-flight ones. */
export async function stopWebServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = undefined;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}
