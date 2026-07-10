import type { BotContext } from './context.js';
import { getContributor } from '../core/service.js';
import { en } from './locales/en.js';

/**
 * Minimal i18n framework. English is the single source of truth (the `en`
 * catalog). `t()` looks up a keyed string (interpolating params for function
 * entries) in the requested locale, falling back to English for any locale or
 * key that isn't translated. Launch is English-only; adding a language later is
 * a drop-in `locales/<code>.ts` registered below — no call-site changes.
 *
 * Only the bot's own fixed chrome lives here. Interpolated values (task titles,
 * pitches, submission content, ids) are passed as params and never translated.
 */

export type Catalog = typeof en;
export type MessageKey = keyof Catalog;

const catalogs: Record<string, Partial<Catalog>> = { en };

/** Normalize a Telegram language_code ("pt-BR") to a base catalog code ("pt"). */
export function baseCode(code: string | null | undefined): string {
  const base = (code ?? 'en').toLowerCase().split('-')[0];
  return catalogs[base] ? base : 'en';
}

/** The locale for the user who sent the current update. */
export function localeOf(ctx: BotContext): string {
  return baseCode(ctx.from?.language_code);
}

/** The stored locale for any contributor (used for notifications we push to them). */
export function contributorLocale(contributorId: number): string {
  return baseCode(getContributor(contributorId)?.language_code);
}

/**
 * Resolve a keyed message in `locale`, interpolating params for function entries.
 *
 * `params` is required for keys whose catalog entry is a param function and
 * rejected for plain-string keys — the rest-tuple below encodes both, so a
 * function key called without its params is a compile error, not a runtime crash.
 */
export function t<K extends MessageKey>(
  locale: string,
  key: K,
  ...args: Catalog[K] extends (p: infer P) => string ? [params: P] : []
): string {
  const entry = (catalogs[locale]?.[key] ?? en[key]) as Catalog[K];
  if (typeof entry === 'function') {
    return (entry as (p: unknown) => string)(args[0]);
  }
  return entry as string;
}
