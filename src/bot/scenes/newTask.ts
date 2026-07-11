import { Scenes } from 'telegraf';
import {
  type BotContext,
  SCENES,
  messageText,
  wizardState,
  handledWizardInterrupt,
  isCommand,
  requirePrivateChat,
} from '../context.js';
import * as ai from '../../ai/assist.js';
import { shutdownSignal } from '../background.js';
import { createTask } from '../../core/service.js';
import { MAX_ASSIGNEES, isValidMaxAssignees } from '../../core/workflow.js';
import { taskDetail } from '../format.js';
import { t, localeOf } from '../i18n.js';

const hint = (locale: string) => (ai.aiEnabled() ? t(locale, 'nt.aiHint') : '');

function normalizeOptional(text: string): string | undefined {
  const s = text.trim();
  return s === '-' || s === '' ? undefined : s;
}

/**
 * Shared "/ai" branch for wizard steps that support AI drafting. Returns the
 * draft, or null (meaning: stay on this step and wait for manual input).
 */
async function aiDraft(
  ctx: BotContext,
  generate: () => Promise<string | null>,
  msgs: { working: string; disabled: string; unavailable: string; result: (draft: string) => string },
): Promise<string | null> {
  if (!ai.aiEnabled()) {
    await ctx.reply(msgs.disabled);
    return null;
  }
  await ctx.reply(msgs.working);
  const draft = await generate();
  if (!draft) {
    await ctx.reply(msgs.unavailable);
    return null;
  }
  await ctx.reply(msgs.result(draft));
  return draft;
}

export const newTaskScene = new Scenes.WizardScene<BotContext>(
  SCENES.newTask,
  // step 0 — prompt for title
  async (ctx) => {
    if (!(await requirePrivateChat(ctx))) return ctx.scene.leave();
    await ctx.reply(t(localeOf(ctx), 'nt.title'));
    return ctx.wizard.next();
  },
  // step 1 — title → ask description
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.titleText'));
      return;
    }
    wizardState(ctx).title = text;
    await ctx.reply(t(L, 'nt.describe', { aiHint: hint(L) }));
    return ctx.wizard.next();
  },
  // step 2 — description → ask reward
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text, { allow: ['ai'] })) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.descriptionText'));
      return;
    }
    const st = wizardState(ctx);
    if (isCommand(text, 'ai')) {
      const draft = await aiDraft(ctx, () => ai.suggestTaskDescription(st.title!, shutdownSignal), {
        working: t(L, 'ai.draftDescriptionWorking'),
        disabled: t(L, 'ai.disabledDescription'),
        unavailable: t(L, 'ai.draftUnavailableDescription'),
        result: (d) => t(L, 'ai.draftDescriptionResult', { draft: d }),
      });
      if (!draft) return; // stay on this step; never record "/ai" as content
      st.description = draft;
    } else {
      st.description = text;
    }
    await ctx.reply(t(L, 'nt.reward'));
    return ctx.wizard.next();
  },
  // step 3 — reward → ask deadline
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.rewardText'));
      return;
    }
    wizardState(ctx).reward = normalizeOptional(text);
    await ctx.reply(t(L, 'nt.deadline'));
    return ctx.wizard.next();
  },
  // step 4 — deadline → ask required output
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.deadlineText'));
      return;
    }
    wizardState(ctx).deadline = normalizeOptional(text);
    await ctx.reply(t(L, 'nt.output', { aiHint: hint(L) }));
    return ctx.wizard.next();
  },
  // step 5 — required output → ask max assignees
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text, { allow: ['ai'] })) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.outputText'));
      return;
    }
    const st = wizardState(ctx);
    if (isCommand(text, 'ai')) {
      const draft = await aiDraft(ctx, () => ai.suggestRequiredOutput(st.title!, st.description!, shutdownSignal), {
        working: t(L, 'ai.draftOutputWorking'),
        disabled: t(L, 'ai.disabledOutput'),
        unavailable: t(L, 'ai.draftUnavailableOutput'),
        result: (d) => t(L, 'ai.draftOutputResult', { draft: d }),
      });
      if (!draft) return; // stay on this step; never record "/ai" as content
      st.requiredOutput = draft;
    } else {
      st.requiredOutput = normalizeOptional(text);
    }
    await ctx.reply(t(L, 'nt.maxAssignees'));
    return ctx.wizard.next();
  },
  // step 6 — max assignees → create draft
  async (ctx) => {
    const L = localeOf(ctx);
    const text = messageText(ctx);
    if (await handledWizardInterrupt(ctx, text)) return;
    if (!text) {
      await ctx.reply(t(L, 'nt.maxAssigneesText'));
      return;
    }
    const st = wizardState(ctx);
    if (text !== '-') {
      const n = Number(text);
      if (!isValidMaxAssignees(n)) {
        await ctx.reply(t(L, 'nt.maxAssigneesRange', { max: MAX_ASSIGNEES }));
        return; // stay on this step
      }
      st.maxAssignees = n;
    }

    const task = await createTask({
      title: st.title!,
      description: st.description!,
      reward: st.reward ?? null,
      deadline: st.deadline ?? null,
      requiredOutput: st.requiredOutput ?? null,
      maxAssignees: st.maxAssignees ?? 1,
      createdBy: ctx.from!.id,
    });
    await ctx.reply(t(L, 'nt.created', { detail: taskDetail(task) }));
    return ctx.scene.leave();
  },
);
