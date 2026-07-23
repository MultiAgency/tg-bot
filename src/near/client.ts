import { Near } from 'near-kit';
import { config } from '../config.js';

/** The one NEAR client every chain read goes through (dao.ts, account.ts) —
 *  keyless: the bot only views; writes are signed elsewhere (see dao.ts). */
export const near = new Near({ network: config.nearNetwork });

const RPC_TIMEOUT_MS = 15_000;

/**
 * Bound a chain read: near-kit exposes no timeout, and Telegraf awaits each
 * update batch — one RPC that accepts the connection and then hangs would stall
 * every bot handler (and any web request awaiting it) for undici's multi-minute
 * default, not just the caller. Rejects like any RPC failure, so the existing
 * fail-closed paths (assertPayableAccount, reconcile's held state) apply.
 */
export function timebox<T>(read: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${what}: NEAR RPC gave no response within ${RPC_TIMEOUT_MS / 1000}s`)),
      RPC_TIMEOUT_MS,
    );
    read.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
