import OpenAI, { type ClientOptions } from 'openai';
import { config } from '../config.js';

/**
 * The single NEAR AI Cloud client (OpenAI-compatible), shared by every AI
 * subsystem — signal scoring / assistance (assist.ts) and the conversational
 * agent (agent.ts). Null when no API key is configured, which is how all AI
 * features degrade off cleanly.
 */
export const client = config.nearAiApiKey
  ? new OpenAI({
      apiKey: config.nearAiApiKey,
      baseURL: config.nearAiBaseUrl,
      // A hung request must not block a user's serialized update queue for
      // minutes; one retry absorbs a transient blip.
      timeout: 30_000,
      maxRetries: 1,
      // Late-bound platform fetch (the SDK otherwise captures its own bundled
      // one): identical in production (Node's built-in fetch), and it lets the
      // demo suites stub this network boundary the way they stub Telegram's.
      // Cast: the SDK's option is typed against node-fetch, but any
      // fetch-compatible function (Node's built-in included) is accepted.
      fetch: ((...args: Parameters<typeof globalThis.fetch>) =>
        globalThis.fetch(...args)) as unknown as ClientOptions['fetch'],
    })
  : null;

export function aiEnabled(): boolean {
  return client !== null;
}
