import { WebClient } from "@slack/web-api";
import type { OpenClawConfig } from "../../config/config.js";
import { listSessionsFromStore } from "../../gateway/session-utils.js";
import { resolveSlackAccount } from "../../slack/accounts.js";

const channelNameCache = new Map<string, string>();

async function getSlackBotToken(cfg: OpenClawConfig): Promise<string | undefined> {
  const account = resolveSlackAccount({ cfg, accountId: undefined });
  return account.botToken;
}

async function getChannelName(client: WebClient, channelId: string): Promise<string> {
  if (channelNameCache.has(channelId)) {
    return channelNameCache.get(channelId)!;
  }

  try {
    const response = await client.conversations.info({ channel: channelId });
    const name = response.channel?.name || channelId;
    channelNameCache.set(channelId, name);
    return name;
  } catch (err) {
    console.log("[DEBUG] Failed to get channel info for", channelId, ":", err);
    return channelId;
  }
}

async function getChannelMessages(
  client: WebClient,
  channelId: string,
  limit: number = 5,
): Promise<Array<{ user: string; text: string }>> {
  try {
    const response = await client.conversations.history({
      channel: channelId,
      limit,
    });

    if (!response.ok || !response.messages) {
      return [];
    }

    return response.messages
      .toReversed()
      .filter((msg) => !msg.subtype || msg.subtype === "file_share")
      .map((msg) => ({
        user: msg.user || "unknown",
        text: msg.text || "",
      }));
  } catch (err) {
    console.log("[DEBUG] Failed to get messages for", channelId, ":", err);
    return [];
  }
}

async function getRecentSlackChannelIds(
  cfg: OpenClawConfig,
  storePath: string | undefined,
  limit: number = 10,
): Promise<Array<{ channelId: string; updatedAt: number | null }>> {
  if (!storePath) {
    return [];
  }

  const { loadSessionStore } = await import("../../config/sessions.js");
  const store = loadSessionStore(storePath);
  const activeMinutes = 60 * 24;

  const result = listSessionsFromStore({
    cfg,
    storePath,
    store,
    opts: {
      activeMinutes,
      includeGlobal: false,
      includeUnknown: false,
    },
  });

  const channelMap = new Map<string, number>();

  for (const session of result.sessions) {
    if (session.key.includes("slack:channel:")) {
      const match = session.key.match(/slack:channel:([^:]+)/);
      if (match) {
        const channelId = match[1].toUpperCase();
        const updatedAt = session.updatedAt ?? 0;
        if (!channelMap.has(channelId) || updatedAt > (channelMap.get(channelId) || 0)) {
          channelMap.set(channelId, updatedAt);
        }
      }
    }
  }

  return Array.from(channelMap.entries())
    .toSorted((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .slice(0, limit)
    .map(([channelId, updatedAt]) => ({ channelId, updatedAt }));
}

export async function buildActivitySummaryPrompt(params: {
  cfg: OpenClawConfig;
  storePath?: string;
}): Promise<string> {
  const { cfg } = params;

  const botToken = await getSlackBotToken(cfg);
  if (!botToken) {
    return "Slack bot token not configured.";
  }

  const client = new WebClient(botToken);

  const channels = await getRecentSlackChannelIds(cfg, params.storePath, 10);

  if (channels.length === 0) {
    return "No recent Slack activity found.";
  }

  console.log("[DEBUG] Processing", channels.length, "Slack channels");

  const channelSections: string[] = [];

  for (const { channelId } of channels) {
    const channelName = await getChannelName(client, channelId);
    console.log("[DEBUG] Processing channel:", channelName, "(", channelId, ")");

    const messages = await getChannelMessages(client, channelId, 5);
    console.log("[DEBUG] Got", messages.length, "messages for", channelName);

    if (messages.length === 0) {
      channelSections.push(`**#${channelName}**\nNothing new`);
      continue;
    }

    const messageLines = messages.map((msg) => {
      const truncated = msg.text;
      return `<@${msg.user}>: ${truncated}`;
    });

    channelSections.push(`**#${channelName}**\n${messageLines.join("\n")}`);
  }

  const prompt = `Ignore all previous conversation history. Focus only on the information provided below.

Extract and report the important information from each Slack channel. For each channel:
1. What important tasks, questions, decisions, or blockers were discussed
2. Current status: in progress, completed, or blocked
3. Key details and context needed to understand the status

If no important work was done in a channel, say "Nothing new".

${channelSections.join("\n\n")}

Format your response as:
**#channel-name**: Important information and status

For example:
**#general**: Working on API integration (in progress) - awaiting feedback from backend team. Key: need to coordinate with team on timeline. Completed: user authentication flow.
**#random**: Nothing new.

NOTE: DO NOT use any information from previous conversations!!`;

  return prompt;
}
