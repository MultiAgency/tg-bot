import { Markup } from 'telegraf';
import type { Task } from '../core/models/task.js';
import type { Application } from '../core/models/application.js';
import type { Submission } from '../core/models/submission.js';
import { submissionTruncated } from './format.js';
import { t } from './i18n.js';

/**
 * Every builder takes the recipient's locale: labels are user-facing chrome and
 * route through the catalog like all other chrome (the i18n drop-in-locale
 * invariant). Command handlers pass localeOf(ctx); notification producers pass
 * the recipient's stored locale.
 */

/** Bare Apply button (callback form; `apply:<id>` starts the pitch wizard) —
 *  the ONE encoding of that callback contract, composable into ad-hoc rows. */
export const applyBtn = (task: Task, locale: string) =>
  Markup.button.callback(t(locale, 'btn.apply', { id: task.id }), `apply:${task.id}`);

/**
 * Bare Apply button as a deep link into the bot's private chat (?start=t<id> is
 * handled in bot.start — the ONE encoding of that payload) — used wherever the
 * pitch wizard can't run in place: the announcement channel, group chats, and
 * inline-shared cards, since none deliver the free-form replies the wizard
 * collects. Needs the bot's @username.
 */
export const applyDeepLinkBtn = (task: Task, botUsername: string, locale: string) =>
  Markup.button.url(t(locale, 'btn.apply', { id: task.id }), `https://t.me/${botUsername}?start=t${task.id}`);

export const deepLinkApplyButton = (task: Task, botUsername: string, locale: string) =>
  Markup.inlineKeyboard([applyDeepLinkBtn(task, botUsername, locale)]);

/**
 * The apply affordance for one open task — the ONE encoding of the placement
 * rule (shared by the /open paginator and the agent's propose_apply): a callback
 * in a private chat (the pitch wizard needs replies groups never deliver), a
 * deep link into the DM from a group, and nothing when the bot @username is
 * unknown (a callback there would dead-end in the private-chat guard).
 */
export const applyAffordanceBtn = (task: Task, isPrivate: boolean, botUsername: string, locale: string) =>
  isPrivate ? applyBtn(task, locale) : botUsername ? applyDeepLinkBtn(task, botUsername, locale) : null;

export const approveButton = (task: Task, locale: string) =>
  Markup.inlineKeyboard([
    Markup.button.callback(t(locale, 'btn.approveOpen', { id: task.id }), `approve:${task.id}`),
  ]);

/** Bare assign / decline row for one applicant (keyed by application id) —
 *  the ONE encoding of those callbacks, composable into ad-hoc keyboards. */
export const applicantRow = (app: Application, locale: string) => [
  Markup.button.callback(t(locale, 'btn.assign'), `assign:${app.id}`),
  Markup.button.callback(t(locale, 'btn.decline'), `decline:${app.id}`),
];

export const applicantButtons = (app: Application, locale: string) =>
  Markup.inlineKeyboard([applicantRow(app, locale)]);

export const submitButton = (app: Application, locale: string) =>
  Markup.inlineKeyboard([Markup.button.callback(t(locale, 'btn.submit'), `submit:${app.id}`)]);

export const withdrawButton = (app: Application, locale: string) =>
  Markup.inlineKeyboard([Markup.button.callback(t(locale, 'btn.withdraw'), `withdraw:${app.id}`)]);

/** The "Next page ▶" button under a review page — anchored by the last submission
 *  id shown (not an offset: deciding cards shrinks the re-derived backlog). */
export const reviewNextButton = (afterId: number, locale: string) =>
  Markup.inlineKeyboard([Markup.button.callback(t(locale, 'btn.reviewNext'), `rev:more:${afterId}`)]);

/**
 * Approve / reject / revise buttons for one submission version. When the card
 * had to clip the content, a "Full submission" row lets the reviewer read every
 * character before deciding.
 */
export const reviewButtons = (submission: Submission, locale: string) => {
  const rows = [
    [
      Markup.button.callback(t(locale, 'btn.revApprove'), `rev:approve:${submission.id}`),
      Markup.button.callback(t(locale, 'btn.revReject'), `rev:reject:${submission.id}`),
      Markup.button.callback(t(locale, 'btn.revRevise'), `rev:revise:${submission.id}`),
    ],
  ];
  if (submissionTruncated(submission)) {
    rows.push([Markup.button.callback(t(locale, 'btn.full'), `full:${submission.id}`)]);
  }
  return Markup.inlineKeyboard(rows);
};
