import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { RPCHandler } from '@orpc/server/fetch';
import { config } from '../config.js';
import { one } from '../core/db.js';
import {
  upsertContributor,
  getPayoutAccount,
  setPayoutAccount,
  WorkflowError,
} from '../core/service.js';
import { validateInitData, type TelegramUser } from './auth.js';
import { router } from './api.js';

/** Hono context variables set by the auth middleware. */
type Vars = { user: TelegramUser };

/**
 * Gate: every /api route requires a valid Telegram Mini App initData, passed as
 * `Authorization: tma <initData>` (the Mini App convention). It is re-validated
 * per request — initData is small and cheap to check, and this keeps the web
 * tier stateless (no session store). On success the verified Telegram user is on the
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
 * connection pool. Read-mostly by design: every workflow mutation stays in the
 * bot; this tier reads (open tasks, a contributor's own work) plus one mutation —
 * the caller's own DAO-push payout account (POST /api/payout-account). Kept
 * behind the port flag so the plain bot deployment is unchanged until the web
 * app is wired up.
 */
export function createWebApp(): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>();

  // Minimal hardening on every response. `no-referrer` keeps any URL (query
  // string included) out of the Referer header sent to telegram.org — the only
  // third-party host the page touches (fonts are self-hosted); `nosniff` blocks
  // MIME-type confusion on static assets. The CSP is defense-in-depth behind
  // React's escaping: scripts only from ourselves and the telegram.org bridge,
  // network calls only same-origin (the oRPC API), no plugins/embeds.
  // `style-src 'unsafe-inline'` is required for React inline style attributes;
  // `img-src data:` covers the empty favicon.
  // Deliberately NOT setting X-Frame-Options/CSP frame-ancestors — Telegram Web
  // embeds the Mini App in a cross-origin iframe, which those would break.
  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Content-Security-Policy', CSP);
  });

  // Liveness + DB reachability — for Railway's health check and local smoke tests.
  // `poller` reports the long-polling loop's state (index.ts feeds it): the web
  // tier being up says nothing about the bot RECEIVING updates — a poller wedged
  // in the 409 backoff loop would otherwise serve a green /healthz forever.
  // Reported, not failed: a new container legitimately sits in backoff during a
  // deploy rollover, and 503ing then would fail every deploy's health check.
  app.get('/healthz', async (c) => {
    try {
      await one<{ ok: number }>('SELECT 1 AS ok');
      return c.json({ ok: true, db: 'up', ...(pollerStatus ? { poller: pollerStatus() } : {}) });
    } catch (err) {
      console.error('[web] healthz DB check failed:', err instanceof Error ? err.message : err);
      return c.json({ ok: false, db: 'down' }, 503);
    }
  });

  // Everything under /api is Telegram-authenticated. /api/me echoes the verified
  // caller and their saved DAO-push payout account (if any).
  app.use('/api/*', requireTelegramAuth);
  app.get('/api/me', async (c) => {
    const user = c.get('user');
    return c.json({
      user,
      payoutAccount: await getPayoutAccount(user.id),
    });
  });

  // ---- DAO-push payout account (typed, no wallet — see PAYOUTS.md) ----
  // The caller sets the NEAR account their payouts are sent to. No signature: in
  // push they only RECEIVE, and each sets only their OWN account (initData-scoped),
  // so proof-of-control is unnecessary — setPayoutAccount validates the account
  // exists on-chain to catch a typo. Disclosure: the account + task ids land on the
  // public chain permanently when paid; the screen driving this must say so.
  // bodyLimit before the parse: c.req.json() buffers the whole body in this
  // process (shared with the bot), and any Telegram account can mint valid
  // initData just by opening the Mini App — without a cap that's an
  // authenticated-but-anyone memory-pressure lever. A NEAR account is ≤64
  // chars; 1 KB fits any honest payload.
  app.post('/api/payout-account', bodyLimit({ maxSize: 1024 }), async (c) => {
    const user = c.get('user');
    // Same gate as /payto: with no DAO configured the payout rail is dormant —
    // the Payouts screen hides this form, so an honest client never posts here.
    if (!config.daoContractId) return c.json({ error: 'payouts are not enabled' }, 400);
    const body = (await c.req.json().catch(() => null)) as { account?: string } | null;
    if (!body?.account) return c.json({ error: 'account required' }, 400);
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || null;
    await upsertContributor(user.id, user.username ?? null, name, user.language_code ?? null);
    try {
      await setPayoutAccount(user.id, body.account);
    } catch (err) {
      if (err instanceof WorkflowError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json({ payoutAccount: body.account });
  });

  // The typesafe oRPC API (read-only) — same initData gate, and the verified
  // user is threaded into each procedure's context so myApplications is caller-scoped.
  const rpc = new RPCHandler(router);
  app.use('/rpc/*', requireTelegramAuth);
  // Same bodyLimit rationale as /api/payout-account: oRPC buffers the whole
  // request body in this shared process before any zod schema runs, and any
  // Telegram account can mint valid initData — without a cap that's an
  // authenticated-but-anyone memory-pressure lever. Every real oRPC call here
  // is a small JSON envelope; 8 KB clears them with room to spare.
  app.use('/rpc/*', bodyLimit({ maxSize: 8 * 1024 }));
  app.all('/rpc/*', async (c) => {
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: '/rpc',
      context: { user: c.get('user') },
    });
    return matched ? response : c.notFound();
  });

  // Public config the Mini App reads before it can authenticate: the bot
  // @username (Apply deep link) and the DAO contract id the Payouts screen keys
  // off. All public — no PII, no keys.
  app.get('/config', (c) =>
    c.json({
      botUsername: config.botUsername,
      daoContractId: config.daoContractId,
    }),
  );

  // The built Mini App (web/dist), served last so the API routes above win.
  // Missing when the frontend hasn't been built (e.g. the web smoke test) — the
  // static handler just 404s, which those tests never hit.
  // Cache split: serveStatic emits Last-Modified but no freshness directive, and
  // a 200 with only a validator is HEURISTICALLY cacheable — a webview could keep
  // a stale index.html across a deploy and request hashed bundles the new build
  // purged (vite emptyOutDir), blanking the Mini App until the heuristic TTL
  // lapses. So: hashed /assets are immutable (a new build references new names),
  // while the entry document must always revalidate.
  const cached = (value: string): MiddlewareHandler => async (c, next) => {
    await next();
    if (c.res.ok) c.res.headers.set('Cache-Control', value);
  };
  app.use('/assets/*', cached('public, max-age=31536000, immutable'));
  app.use('/assets/*', serveStatic({ root: './web/dist' }));
  app.get('/', cached('no-cache'), serveStatic({ root: './web/dist', path: 'index.html' }));
  app.get('/index.html', cached('no-cache'), serveStatic({ root: './web/dist' }));

  return app;
}

let server: ReturnType<typeof serve> | undefined;

/** Start the web server on `port`. A second call while running is a no-op. */
// Injected by index.ts (the module that owns the launch/backoff loop) so this
// tier never imports bot code. Null — never set, as in web-smoke or tooling —
// omits the field from /healthz rather than guessing.
let pollerStatus: (() => 'up' | 'backoff') | null = null;
export function setPollerStatus(fn: () => 'up' | 'backoff'): void {
  pollerStatus = fn;
}

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
