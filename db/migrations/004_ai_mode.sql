-- 004 — group AI mode. A room can separately opt in (ai_enabled) to
-- conversational AI: members talk to the bot in natural language and it answers,
-- and proposes task drafts / applications via tool use — each shown as a
-- confirmation card a human still taps (the bot never mutates on its own).
-- Independent of signals_enabled and composable with it: a message ADDRESSED to
-- the bot (mention / reply) goes to the agent, everything else is ambient chatter
-- for signal detection. Like signals, no conversation text is stored — the
-- agent's short multi-turn memory is RAM-only (see src/ai/agent.ts).
ALTER TABLE rooms ADD COLUMN ai_enabled INTEGER NOT NULL DEFAULT 0;
