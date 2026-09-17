/** Upstream transport for Cline chat completions. */
import type { AppConfig } from "../config.js";
import { CLINE_CHAT_PATH, defaultClineHeaders } from "./constants.js";

export interface UpstreamRequestContext {
  authorization: string;
  taskId: string;
  signal?: AbortSignal;
}

export function buildUpstreamHeaders(
  config: AppConfig,
  context: UpstreamRequestContext,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    Authorization: context.authorization,
    ...defaultClineHeaders({
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      platform: config.platform,
      platformVersion: config.platformVersion,
      coreVersion: config.coreVersion,
      taskId: context.taskId,
    }),
  };
}

export function chatCompletionsUrl(config: AppConfig): string {
  return `${config.clineApiBaseUrl}${CLINE_CHAT_PATH}`;
}

/** POST a body to the upstream chat endpoint and hand back the raw Response. */
export async function postChatCompletions(
  config: AppConfig,
  body: unknown,
  context: UpstreamRequestContext,
): Promise<Response> {
  return fetch(chatCompletionsUrl(config), {
    method: "POST",
    headers: buildUpstreamHeaders(config, context),
    body: JSON.stringify(body),
    ...(context.signal ? { signal: context.signal } : { signal: AbortSignal.timeout(600_000) }),
  });
}
