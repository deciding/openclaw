import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { updateSessionStore } from "../../config/sessions.js";
import path from "node:path";
import { applyLinkUnderstanding } from "../../link-understanding/apply.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { editSlackMessage } from "../../slack/actions.js";
import { sendMessageSlack } from "../../slack/send.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runOpencodeCommand, runOpencodeCommandStreaming, runClaudeCodeCommand, runClaudeCodeCommandStreaming, runCodexCommand, runCodexCommandStreaming, validateProjectDir } from "./commands-opencode.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

async function recordUserInstruction(params: {
  projectDir: string;
  mode: string;
  instruction: string;
}): Promise<void> {
  const { projectDir, mode, instruction } = params;
  if (!projectDir || !mode || !instruction) {
    return;
  }

  const { mkdir, appendFile, writeFile } = await import("node:fs/promises");
  const { existsSync, readFileSync } = await import("node:fs");
  const handclawDir = path.join(projectDir, ".handclaw");
  const fileName = `USER_INSTRUCTIONS_${mode.toUpperCase()}.md`;
  const filePath = path.join(handclawDir, fileName);

  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n\n${instruction.trim()}\n\n---\n`;

  try {
    await mkdir(handclawDir, { recursive: true });
    await appendFile(filePath, entry);

    const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
    const lineCount = content.split("\n").filter((l: string) => l.trim()).length;

    if (lineCount > 500) {
      console.log(`[USER_FEEDBACK] Instructions file exceeds 500 lines (${lineCount}), triggering summarization`);
      await summarizeUserInstructions({
        projectDir,
        mode,
        instructionsFilePath: filePath,
      });
    }
  } catch (err) {
    console.log("[DEBUG] Failed to record user instruction:", err);
  }
}

async function summarizeUserInstructions(params: {
  projectDir: string;
  mode: string;
  instructionsFilePath: string;
}): Promise<void> {
  const { projectDir, mode, instructionsFilePath } = params;
  const { readFileSync, existsSync } = await import("node:fs");
  const { writeFile } = await import("node:fs/promises");

  try {
    const content = existsSync(instructionsFilePath) ? readFileSync(instructionsFilePath, "utf-8") : "";
    const lines = content.split("\n");
    const recentLines = lines.slice(-600);
    const recentContent = recentLines.join("\n");

    const prompt = `Analyze the following user instructions for a ${mode} coding session.

For each instruction entry (separated by "---"), determine:
1. Is this a "coding request" (non-plan, i.e., asking for code/implementation/something to be done)?
2. Was this request "accepted" (user approved/went ahead with the proposed code or the request was fulfilled)?

Count and report ONLY these two numbers in this exact format:
total_coding_requests: <number>
total_codes_accepted: <number>

Instructions:
${recentContent}`;

    let resultText = "";
    let resultError = "";

    if (mode === "opencode") {
      const { runOpencodeCommand } = await import("./commands-opencode.js");
      const result = await runOpencodeCommand({
        message: prompt,
        projectDir,
        agent: "plan",
      });
      resultText = result.text;
      resultError = result.error || "";
    } else if (mode === "claude") {
      const { runClaudeCodeCommand } = await import("./commands-opencode.js");
      const result = await runClaudeCodeCommand({
        message: prompt,
        projectDir,
        agent: "plan",
      });
      resultText = result.text;
      resultError = result.error || "";
    } else if (mode === "codex") {
      const { runCodexCommand } = await import("./commands-opencode.js");
      const result = await runCodexCommand({
        message: prompt,
        projectDir,
        agent: "plan",
      });
      resultText = result.text;
      resultError = result.error || "";
    }

    console.log("[USER_FEEDBACK] LLM response:", resultText);

    const codingRequestsMatch = resultText.match(/total_coding_requests:\s*(\d+)/i);
    const codesAcceptedMatch = resultText.match(/total_codes_accepted:\s*(\d+)/i);

    const newCodingRequests = codingRequestsMatch ? parseInt(codingRequestsMatch[1], 10) : 0;
    const newCodesAccepted = codesAcceptedMatch ? parseInt(codesAcceptedMatch[1], 10) : 0;

    if (newCodingRequests > 0 || newCodesAccepted > 0) {
      await updateUserFeedback({
        projectDir,
        mode,
        newCodingRequests,
        newCodesAccepted,
      });
    }

    await writeFile(instructionsFilePath, "");
    console.log("[USER_FEEDBACK] Instructions file cleared after summarization");
  } catch (err) {
    console.log("[USER_FEEDBACK] Failed to summarize instructions:", err);
  }
}

async function updateUserFeedback(params: {
  projectDir: string;
  mode: string;
  newCodingRequests: number;
  newCodesAccepted: number;
}): Promise<void> {
  const { projectDir, mode, newCodingRequests, newCodesAccepted } = params;
  const { mkdir, readFile, writeFile } = await import("node:fs/promises");
  const { existsSync } = await import("node:fs");
  const handclawDir = path.join(projectDir, ".handclaw");
  const fileName = `USER_FEEDBACK_${mode.toUpperCase()}.md`;
  const filePath = path.join(handclawDir, fileName);

  let existingCodingRequests = 0;
  let existingCodesAccepted = 0;

  try {
    if (existsSync(filePath)) {
      const content = await readFile(filePath, "utf-8");
      const codingMatch = content.match(/coding_requests:\s*(\d+)/i);
      const acceptedMatch = content.match(/codes_accepted:\s*(\d+)/i);
      existingCodingRequests = codingMatch ? parseInt(codingMatch[1], 10) : 0;
      existingCodesAccepted = acceptedMatch ? parseInt(acceptedMatch[1], 10) : 0;
    }

    const totalCodingRequests = existingCodingRequests + newCodingRequests;
    const totalCodesAccepted = existingCodesAccepted + newCodesAccepted;
    const timestamp = new Date().toISOString();

    const feedbackContent = `# Code Feedback - ${mode}

coding_requests: ${totalCodingRequests}
codes_accepted: ${totalCodesAccepted}
last_updated: ${timestamp}
`;

    await mkdir(handclawDir, { recursive: true });
    await writeFile(filePath, feedbackContent);
    console.log(`[USER_FEEDBACK] Updated feedback: ${totalCodingRequests} requests, ${totalCodesAccepted} accepted`);
  } catch (err) {
    console.log("[USER_FEEDBACK] Failed to update feedback:", err);
  }
}

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return list.map((entry) => String(entry).trim()).filter(Boolean);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = configOverride ?? loadConfig();
  const targetSessionKey =
    ctx.CommandSource === "native" ? ctx.CommandTargetSessionKey?.trim() : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      opts.heartbeatModelOverride?.trim() ?? agentCfg?.heartbeat?.model?.trim() ?? "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = await ensureAgentWorkspace({
    dir: workspaceDirRaw,
    ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
  });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);

  if (!isFastTestEnv) {
    await applyMediaUnderstanding({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider, model },
    });
    await applyLinkUnderstanding({
      ctx: finalized,
      cfg,
    });
  }

  const commandAuthorized = finalized.CommandAuthorized;
  resolveCommandAuthorization({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  const sessionState = await initSessionState({
    ctx: finalized,
    cfg,
    commandAuthorized,
  });
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;

  // Check channel name for auto-enter coding agent mode (e.g., #opencode-myrepo, #claude-myrepo, #codex-myrepo)
  // Use GroupSubject FIRST (fresh from Slack API), then fall back to session origin
  const channelLabel = finalized.GroupSubject ?? finalized.GroupChannel ?? sessionEntry?.origin?.label;
  console.log("[DEBUG] Channel label:", channelLabel);
  console.log("[DEBUG] Source: GroupSubject:", finalized.GroupSubject, "| GroupChannel:", finalized.GroupChannel, "| origin.label:", sessionEntry?.origin?.label);
  const channelNameMatch = channelLabel?.match(/^#?(opencode|claude|codex)[-:](.+)$/i);
  console.log("[DEBUG] Channel name match:", channelNameMatch);

  if (channelNameMatch) {
    const [, mode, projectName] = channelNameMatch;
    const modeLower = mode.toLowerCase();
    const isOpencode = modeLower === "opencode";
    const isClaudeCode = modeLower === "claude";
    const isCodex = modeLower === "codex";
    console.log("[DEBUG] Mode detected:", modeLower, "project:", projectName);

    // Check if we need to enter or switch mode
    const currentMode =
      sessionEntry?.opencodeMode ||
      (sessionEntry?.claudeCodeMode && "claude") ||
      (sessionEntry?.codexMode && "codex");
    console.log("[DEBUG] Current mode:", currentMode);

    const needsSwitch =
      (isOpencode && !sessionEntry?.opencodeMode) ||
      (isClaudeCode && !sessionEntry?.claudeCodeMode) ||
      (isCodex && !sessionEntry?.codexMode);
    console.log("[DEBUG] Needs switch:", needsSwitch);

    // Resolve project directory
    let projectDir = "";
    if (isOpencode) {
      projectDir = sessionEntry?.opencodeProjectDir ?? "";
    } else if (isClaudeCode) {
      projectDir = sessionEntry?.claudeCodeProjectDir ?? "";
    } else if (isCodex) {
      projectDir = sessionEntry?.codexProjectDir ?? "";
    }

    // Validate and resolve project directory
    if (!projectDir && projectName) {
      // Try workspace first
      const workspaceProjectDir = path.join(workspaceDir, projectName);
      const { access } = await import("node:fs/promises");
      try {
        await access(workspaceProjectDir);
        projectDir = workspaceProjectDir;
      } catch {
        // Fall back to regular validation
        const { validateProjectDir } = await import("./commands-opencode.js");
        projectDir = validateProjectDir(projectName) ?? "";
      }
    }
    console.log("[DEBUG] Project dir:", projectDir);

// Check if mode is changing (e.g., codex → opencode)
// Use OLD mode's project directory to detect the change
    const previousMode = sessionEntry?.codexMode ? "codex" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.opencodeMode ? "opencode" : null;
    console.log("[DEBUG] Session flags - opencodeMode:", sessionEntry?.opencodeMode, "| claudeCodeMode:", sessionEntry?.claudeCodeMode, "| codexMode:", sessionEntry?.codexMode);
    const previousProjectDir = previousMode === "codex"
      ? sessionEntry?.codexProjectDir
      : previousMode === "claude"
        ? sessionEntry?.claudeCodeProjectDir
        : previousMode === "opencode"
          ? sessionEntry?.opencodeProjectDir
          : null;
    const modeChanged = previousMode && previousMode !== modeLower && previousProjectDir;
    console.log("[MODE] Previous mode:", previousMode, "| Current mode:", modeLower, "| Project dir:", previousProjectDir);
    console.log("[MODE] Migration needed:", modeChanged ? "YES" : "NO");
    let migrationMessage = "";

    // Run migration if mode changed
    if (modeChanged && previousMode && previousMode !== modeLower) {
      typing.cleanup();
      
      console.log("[MIGRATION] Starting:", previousMode, "→", modeLower);
      
      const migrationFileName = `migration_from_${previousMode}.md`;
      const migrationPath = path.join(projectDir, ".handclaw", migrationFileName);
      console.log("[MIGRATION] Migration file:", migrationPath);

      const migrationPrompt = `Provide a detailed prompt for continuing our conversation above.
Focus on information that would be helpful for continuing the conversation, including what we did, what we're doing, which files we're working on, and what we're going to do next.
The summary that you construct will be used so that another agent can read it and continue the work.

When constructing the summary, try to stick to this template:
---
## Goal

[What goal(s) is the user trying to accomplish?]

## Instructions

- [What important instructions did the user give you that are relevant]
- [If there is a plan or spec, include information about it so next agent can continue using it]

## Discoveries

[What notable things were learned during this conversation that would be useful for the next agent to know when continuing the work]

## Accomplished

[What work has been completed, what work is still in progress, and what work is left?]

## Relevant files / directories

[Construct a structured list of relevant files that have been read, edited, or created that pertain to the task at hand. If all the files in a directory are relevant, include the path to the directory.]
---

Now generate the summary for continuing with ${modeLower}:`;

      const {
        runOpencodeCommand,
        runClaudeCodeCommand,
        runCodexCommand,
        runOpencodeCommandStreaming,
        runClaudeCodeCommandStreaming,
        runCodexCommandStreaming,
      } = await import("./commands-opencode.js");

      const isSlack =
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack";

      let channelId: string | null = null;
      let threadId: string | null = null;

      if (isSlack) {
        if (sessionEntry?.origin?.from) {
          const match = sessionEntry.origin.from.match(/slack:channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }
        if (!channelId && sessionEntry.origin?.to) {
          const match = sessionEntry.origin.to.match(/channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }
        if (!channelId) {
          const channelMatch = sessionKey?.match(/slack:channel:([^:]+)/i);
          if (channelMatch) {
            channelId = channelMatch[1].toUpperCase();
          }
        }
        const threadMatch = sessionKey?.match(/slack:channel:[^:]+:thread:([^:]+)/);
        threadId = threadMatch ? threadMatch[1] : null;
      }

      let oldProjectDir = previousProjectDir || projectDir;
      let summaryText = "";
      let summaryError = "";
      const responsePrefix = `[${modeLower}:${projectName}|plan]`;

      if (isSlack && channelId) {
        const target = `channel:${channelId}`;
        const threadOpts = threadId ? { threadTs: threadId } : {};

        const thinkingMsg = await sendMessageSlack(
          target,
          `${responsePrefix} 🤔 Generating migration summary...`,
          threadOpts,
        );

        let fullOutput = "";
        let lastUpdate = Date.now();

        const runStreaming = async (
          streamingFn: (params: {
            message: string;
            projectDir: string;
            agent: string;
            onChunk: (chunk: string) => void;
          }) => Promise<{ error?: string }>,
        ) => {
          await streamingFn({
            message: migrationPrompt,
            projectDir: oldProjectDir,
            agent: "plan",
            onChunk: async (chunk: string) => {
              fullOutput += chunk;
              const now = Date.now();
              if (now - lastUpdate >= 1000 || chunk.includes("❌") || chunk.includes("⚠️")) {
                lastUpdate = now;
                const displayText = fullOutput.slice(-3000);
                await editSlackMessage(channelId!, thinkingMsg.messageId, `${responsePrefix}\n${displayText}`);
              }
            },
          });
          summaryText = fullOutput;
        };

        if (previousMode === "codex") {
          console.log("[MIGRATION] Running Codex plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          await runStreaming(runCodexCommandStreaming);
        } else if (previousMode === "claude") {
          console.log("[MIGRATION] Running Claude Code plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          await runStreaming(runClaudeCodeCommandStreaming);
        } else if (previousMode === "opencode") {
          console.log("[MIGRATION] Running OpenCode plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          await runStreaming(runOpencodeCommandStreaming);
        }

        const finalText = summaryText.slice(-3000);
        await editSlackMessage(channelId, thinkingMsg.messageId, `${responsePrefix}\n${finalText}`);
      } else {
        if (previousMode === "codex") {
          console.log("[MIGRATION] Running Codex plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          const result = await runCodexCommand({
            message: migrationPrompt,
            projectDir: oldProjectDir,
            agent: "plan",
          });
          summaryText = result.text;
          summaryError = result.error || "";
        } else if (previousMode === "claude") {
          console.log("[MIGRATION] Running Claude Code plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          const result = await runClaudeCodeCommand({
            message: migrationPrompt,
            projectDir: oldProjectDir,
            agent: "plan",
          });
          summaryText = result.text;
          summaryError = result.error || "";
        } else if (previousMode === "opencode") {
          console.log("[MIGRATION] Running OpenCode plan command with:", { projectDir: oldProjectDir, agent: "plan" });
          const result = await runOpencodeCommand({
            message: migrationPrompt,
            projectDir: oldProjectDir,
            agent: "plan",
          });
          summaryText = result.text;
          summaryError = result.error || "";
        }
      }

      const { mkdir, writeFile } = await import("node:fs/promises");
      const migrationDir = path.join(oldProjectDir, ".handclaw");
      try {
        await mkdir(migrationDir, { recursive: true });
        await writeFile(migrationPath, summaryText || summaryError || "No summary generated");
        console.log("[DEBUG] Migration saved to:", migrationPath);
      } catch (writeErr) {
        console.log("[DEBUG] Failed to write migration file:", writeErr);
      }

      migrationMessage = `\n\n📦 Migrated from ${previousMode} → ${modeLower}. Summary saved to \`${migrationPath}\``;
      console.log("[DEBUG] Migration completed for:", previousMode, "→", modeLower);
    }

    // Enter/switch mode if needed
    // Use previousProjectDir if modeChanged (migration case), otherwise use projectDir
    const effectiveProjectDir = modeChanged ? (previousProjectDir || projectDir) : projectDir;
    if (effectiveProjectDir && (needsSwitch || !currentMode || modeChanged)) {
      typing.cleanup();

      // Clear all old mode fields first
      sessionEntry.opencodeMode = false;
      sessionEntry.opencodeProjectDir = undefined;
      sessionEntry.opencodeAgent = undefined;
      sessionEntry.opencodeResponsePrefix = undefined;
      sessionEntry.claudeCodeMode = false;
      sessionEntry.claudeCodeProjectDir = undefined;
      sessionEntry.claudeCodeAgent = undefined;
      sessionEntry.claudeCodeResponsePrefix = undefined;
      sessionEntry.codexMode = false;
      sessionEntry.codexProjectDir = undefined;
      sessionEntry.codexAgent = undefined;
      sessionEntry.codexResponsePrefix = undefined;

      if (isOpencode) {
        sessionEntry.opencodeMode = true;
        sessionEntry.opencodeProjectDir = effectiveProjectDir;
        sessionEntry.opencodeAgent = sessionEntry.opencodeAgent || "build";
        sessionEntry.opencodeResponsePrefix = `[opencode:${projectName}|${sessionEntry.opencodeAgent}]`;
        // Clear other modes
        sessionEntry.claudeCodeMode = false;
        sessionEntry.codexMode = false;
      } else if (isClaudeCode) {
        sessionEntry.claudeCodeMode = true;
        sessionEntry.claudeCodeProjectDir = effectiveProjectDir;
        sessionEntry.claudeCodeAgent = sessionEntry.claudeCodeAgent || "build";
        sessionEntry.claudeCodeResponsePrefix = `[claude:${projectName}|${sessionEntry.claudeCodeAgent}]`;
        // Clear other modes
        sessionEntry.opencodeMode = false;
        sessionEntry.codexMode = false;
      } else if (isCodex) {
        sessionEntry.codexMode = true;
        sessionEntry.codexProjectDir = effectiveProjectDir;
        sessionEntry.codexAgent = sessionEntry.codexAgent || "build";
        sessionEntry.codexResponsePrefix = `[codex:${projectName}|${sessionEntry.codexAgent}]`;
        // Clear other modes
        sessionEntry.opencodeMode = false;
        sessionEntry.claudeCodeMode = false;
      }

      if (sessionKey && sessionStore && storePath) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }

      const modeLabel = isOpencode ? "opencode" : isClaudeCode ? "Claude Code" : "Codex";
      return {
        text: `🔓 Entered ${modeLabel} mode!\n\nProject: ${projectDir}\n\nAll messages will now be forwarded to ${modeLabel} CLI.${migrationMessage}`,
      };
    }
  }

  // Check for !code command prefix (direct detection, before normal agent processing)
  // This works for all channels including Slack
  const trimmedBody = triggerBodyNormalized?.trim() ?? "";
  const isOpencodeCommand = /^!code(\s|$)/i.test(trimmedBody) ||
    /^!plan\s/i.test(trimmedBody) ||
    /^!build\s/i.test(trimmedBody);

  if (isOpencodeCommand) {
    typing.cleanup();
    const { handleOpencodeCommandDirect } = await import("./commands-opencode.js");
    const result = await handleOpencodeCommandDirect({
      commandBody: triggerBodyNormalized ?? "",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      channelLabel: channelLabel ?? undefined,
    });
    if (result) {
      return result;
    }
  }

  // Check for !rate command - show autonomous level based on user feedback
  const isRateCommand = /^!rate\s/i.test(trimmedBody);
  if (isRateCommand) {
    typing.cleanup();
    const { calculateAutoLevel } = await import("./commands-opencode.js");

    let projectDir = "";
    let mode = "";

    if (sessionEntry?.opencodeMode && sessionEntry?.opencodeProjectDir) {
      projectDir = sessionEntry.opencodeProjectDir;
      mode = "opencode";
    } else if (sessionEntry?.claudeCodeMode && sessionEntry?.claudeCodeProjectDir) {
      projectDir = sessionEntry.claudeCodeProjectDir;
      mode = "claude";
    } else if (sessionEntry?.codexMode && sessionEntry?.codexProjectDir) {
      projectDir = sessionEntry.codexProjectDir;
      mode = "codex";
    }

    if (projectDir && mode) {
      const result = calculateAutoLevel({ projectDir, mode });
      const responseText = `📊 Code Acceptance Rate: ${result.percentage}% (${result.totalAccepted}/${result.totalRequests} requests accepted)
🚀 Autonomous Level: ${result.level}`;

      if (
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack"
      ) {
        const target = finalized.GroupChannel ?? finalized.GroupSubject ?? sessionEntry?.origin?.label ?? "channel";
        await sendMessageSlack(target, responseText);
        return { text: "" };
      } else {
        return { text: responseText };
      }
    } else {
      const responseText = "⚠️ Not in a coding CLI channel. Use this command in #opencode-, #claude-, or #codex- channels.";
      if (
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack"
      ) {
        const target = finalized.GroupChannel ?? finalized.GroupSubject ?? sessionEntry?.origin?.label ?? "channel";
        await sendMessageSlack(target, responseText);
        return { text: "" };
      } else {
        return { text: responseText };
      }
    }
  }

  // Check for status command (either direct pattern or the marker from prepare.ts)
  const isStatusCommand =
    /<@[^>]+>\s*status/i.test(trimmedBody) ||
    /^@OpenClaw\s+status/i.test(trimmedBody) ||
    trimmedBody === "[STATUS_COMMAND]";

  if (
    isStatusCommand &&
    (finalized.OriginatingChannel === "slack" || finalized.Surface === "slack")
  ) {
    typing.cleanup();
    const { buildActivitySummaryPrompt } = await import("./commands-activity.js");
    const summaryPrompt = await buildActivitySummaryPrompt({
      cfg,
      storePath,
    });
    console.log("[DEBUG] ===== STATUS COMMAND - PROMPT SENT TO LLM =====");
    console.log("[DEBUG]", summaryPrompt);
    console.log("[DEBUG] ===== END OF PROMPT =====");
    // Modify sessionCtx directly - this is what getReplyRun reads from
    sessionCtx.BodyStripped = summaryPrompt;
    sessionCtx.Body = summaryPrompt;
    sessionCtx.BodyForAgent = summaryPrompt;
    sessionCtx.BodyForCommands = summaryPrompt;
    sessionCtx.CommandBody = summaryPrompt;
    // Also update local variables
    triggerBodyNormalized = summaryPrompt;
    bodyStripped = summaryPrompt;
  }

  if (sessionEntry?.opencodeMode && sessionEntry?.opencodeProjectDir && triggerBodyNormalized) {
    const isCommand = triggerBodyNormalized.startsWith("/");
    if (!isCommand) {
      await recordUserInstruction({
        projectDir: sessionEntry.opencodeProjectDir,
        mode: "opencode",
        instruction: triggerBodyNormalized,
      });
      typing.cleanup();
      const responsePrefix = sessionEntry.opencodeResponsePrefix;

      const isSlack =
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack";

      if (isSlack) {
        // Try multiple sources for channel ID
        let channelId: string | null = null;

        // 1. Try from sessionEntry.origin.from (most reliable)
        if (sessionEntry.origin?.from) {
          const match = sessionEntry.origin.from.match(/slack:channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        // 2. Try from sessionEntry.origin.to
        if (!channelId && sessionEntry.origin?.to) {
          const match = sessionEntry.origin.to.match(/channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        // 3. Fallback to sessionKey parsing
        if (!channelId) {
          const channelMatch = sessionKey?.match(/slack:channel:([^:]+)/i);
          if (channelMatch) {
            channelId = channelMatch[1].toUpperCase();
          }
        }

        // Extract thread ID from sessionKey
        const threadMatch = sessionKey?.match(/slack:channel:[^:]+:thread:([^:]+)/);
        const threadId = threadMatch ? threadMatch[1] : null;

        if (!channelId) {
          const result = await runOpencodeCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.opencodeProjectDir,
            agent: sessionEntry.opencodeAgent || "plan/build",
            model: sessionEntry.opencodeModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let fullOutput = "";
        const target = `channel:${channelId}`;
        const threadOpts = threadId ? { threadTs: threadId } : {};

        const thinkingMsg = await sendMessageSlack(
          target,
          `${responsePrefix} 🤔 Thinking...`,
          threadOpts,
        );
        if (!thinkingMsg.messageId) {
          const result = await runOpencodeCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.opencodeProjectDir,
            agent: sessionEntry.opencodeAgent || "plan/build",
            model: sessionEntry.opencodeModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let lastUpdate = Date.now();

        await runOpencodeCommandStreaming({
          message: triggerBodyNormalized,
          projectDir: sessionEntry.opencodeProjectDir,
          agent: sessionEntry.opencodeAgent || "plan/build",
          model: sessionEntry.opencodeModel,
          onChunk: async (chunk) => {
            fullOutput += chunk;
            const now = Date.now();
            if (now - lastUpdate >= 1000 || chunk.includes("❌") || chunk.includes("⚠️")) {
              lastUpdate = now;
              const displayText = fullOutput.slice(-3000);
              await editSlackMessage(
                channelId,
                thinkingMsg.messageId,
                `${responsePrefix}\n${displayText}`,
              );
            }
          },
        });

        const finalText = fullOutput.slice(-3000);
        await editSlackMessage(channelId, thinkingMsg.messageId, `${responsePrefix}\n${finalText}`);

        return { text: "", channelData: { responsePrefix } };
      }

      const result = await runOpencodeCommand({
        message: triggerBodyNormalized,
        projectDir: sessionEntry.opencodeProjectDir,
        agent: sessionEntry.opencodeAgent || "plan/build",
        model: sessionEntry.opencodeModel,
      });
      if (result.error) {
        return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
      }
      return { text: result.text, channelData: { responsePrefix } };
    }
  }

  // Claude Code mode handling
  if (sessionEntry?.claudeCodeMode && sessionEntry?.claudeCodeProjectDir && triggerBodyNormalized) {
    const isCommand = triggerBodyNormalized.startsWith("/");
    if (!isCommand) {
      await recordUserInstruction({
        projectDir: sessionEntry.claudeCodeProjectDir,
        mode: "claude",
        instruction: triggerBodyNormalized,
      });
      typing.cleanup();
      const responsePrefix = sessionEntry.claudeCodeResponsePrefix;

      const isSlack =
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack";

      const { runClaudeCodeCommand, runClaudeCodeCommandStreaming } = await import("./commands-opencode.js");

      if (isSlack) {
        let channelId: string | null = null;

        if (sessionEntry.origin?.from) {
          const match = sessionEntry.origin.from.match(/slack:channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        if (!channelId && sessionEntry.origin?.to) {
          const match = sessionEntry.origin.to.match(/channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        if (!channelId) {
          const channelMatch = sessionKey?.match(/slack:channel:([^:]+)/i);
          if (channelMatch) {
            channelId = channelMatch[1].toUpperCase();
          }
        }

        const threadMatch = sessionKey?.match(/slack:channel:[^:]+:thread:([^:]+)/);
        const threadId = threadMatch ? threadMatch[1] : null;

        if (!channelId) {
          const result = await runClaudeCodeCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.claudeCodeProjectDir,
            agent: sessionEntry.claudeCodeAgent,
            model: sessionEntry.claudeCodeModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let fullOutput = "";
        const target = `channel:${channelId}`;
        const threadOpts = threadId ? { threadTs: threadId } : {};

        const thinkingMsg = await sendMessageSlack(
          target,
          `${responsePrefix} 🤔 Thinking...`,
          threadOpts,
        );
        if (!thinkingMsg.messageId) {
          const result = await runClaudeCodeCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.claudeCodeProjectDir,
            agent: sessionEntry.claudeCodeAgent,
            model: sessionEntry.claudeCodeModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let lastUpdate = Date.now();

        await runClaudeCodeCommandStreaming({
          message: triggerBodyNormalized,
          projectDir: sessionEntry.claudeCodeProjectDir,
          agent: sessionEntry.claudeCodeAgent,
          model: sessionEntry.claudeCodeModel,
          onChunk: async (chunk) => {
            fullOutput += chunk;
            const now = Date.now();
            if (now - lastUpdate >= 1000 || chunk.includes("❌") || chunk.includes("⚠️")) {
              lastUpdate = now;
              const displayText = fullOutput.slice(-3000);
              await editSlackMessage(
                channelId,
                thinkingMsg.messageId,
                `${responsePrefix}\n${displayText}`,
              );
            }
          },
        });

        const finalText = fullOutput.slice(-3000);
        await editSlackMessage(channelId, thinkingMsg.messageId, `${responsePrefix}\n${finalText}`);

        return { text: "", channelData: { responsePrefix } };
      }

const result = await runClaudeCodeCommand({
        message: triggerBodyNormalized,
        projectDir: sessionEntry.claudeCodeProjectDir,
        agent: sessionEntry.claudeCodeAgent,
        model: sessionEntry.claudeCodeModel,
      });
      if (result.error) {
        return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
      }
      return { text: result.text, channelData: { responsePrefix } };
    }
  }

  // Codex mode handling
  if (sessionEntry?.codexMode && sessionEntry?.codexProjectDir && triggerBodyNormalized) {
    const isCommand = triggerBodyNormalized.startsWith("/");
    if (!isCommand) {
      await recordUserInstruction({
        projectDir: sessionEntry.codexProjectDir,
        mode: "codex",
        instruction: triggerBodyNormalized,
      });
      typing.cleanup();
      const responsePrefix = sessionEntry.codexResponsePrefix;

      const isSlack =
        finalized.Provider === "slack" ||
        finalized.Surface === "slack" ||
        finalized.OriginatingChannel === "slack";

      const { runCodexCommand, runCodexCommandStreaming } = await import("./commands-opencode.js");

      if (isSlack) {
        let channelId: string | null = null;

        if (sessionEntry.origin?.from) {
          const match = sessionEntry.origin.from.match(/slack:channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        if (!channelId && sessionEntry.origin?.to) {
          const match = sessionEntry.origin.to.match(/channel:([^:]+)/i);
          if (match) {
            channelId = match[1].toUpperCase();
          }
        }

        if (!channelId) {
          const channelMatch = sessionKey?.match(/slack:channel:([^:]+)/i);
          if (channelMatch) {
            channelId = channelMatch[1].toUpperCase();
          }
        }

        const threadMatch = sessionKey?.match(/slack:channel:[^:]+:thread:([^:]+)/);
        const threadId = threadMatch ? threadMatch[1] : null;

        if (!channelId) {
          const result = await runCodexCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.codexProjectDir,
            agent: sessionEntry.codexAgent,
            model: sessionEntry.codexModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let fullOutput = "";
        const target = `channel:${channelId}`;
        const threadOpts = threadId ? { threadTs: threadId } : {};

        const thinkingMsg = await sendMessageSlack(
          target,
          `${responsePrefix} 🤔 Thinking...`,
          threadOpts,
        );
        if (!thinkingMsg.messageId) {
          const result = await runCodexCommand({
            message: triggerBodyNormalized,
            projectDir: sessionEntry.codexProjectDir,
            agent: sessionEntry.codexAgent,
            model: sessionEntry.codexModel,
          });
          if (result.error) {
            return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
          }
          return { text: result.text, channelData: { responsePrefix } };
        }

        let lastUpdate = Date.now();

        await runCodexCommandStreaming({
          message: triggerBodyNormalized,
          projectDir: sessionEntry.codexProjectDir,
          agent: sessionEntry.codexAgent,
          model: sessionEntry.codexModel,
          onChunk: async (chunk) => {
            fullOutput += chunk;
            const now = Date.now();
            if (now - lastUpdate >= 1000 || chunk.includes("❌") || chunk.includes("⚠️")) {
              lastUpdate = now;
              const displayText = fullOutput.slice(-3000);
              await editSlackMessage(
                channelId,
                thinkingMsg.messageId,
                `${responsePrefix}\n${displayText}`,
              );
            }
          },
        });

        const finalText = fullOutput.slice(-3000);
        await editSlackMessage(channelId, thinkingMsg.messageId, `${responsePrefix}\n${finalText}`);

        return { text: "", channelData: { responsePrefix } };
      }

      const result = await runCodexCommand({
        message: triggerBodyNormalized,
        projectDir: sessionEntry.codexProjectDir,
        agent: sessionEntry.codexAgent,
        model: sessionEntry.codexModel,
      });
      if (result.error) {
        return { text: result.text + "\n" + result.error, channelData: { responsePrefix } };
      }
      return { text: result.text, channelData: { responsePrefix } };
    }
  }

  await applyResetModelOverride({
    cfg,
    resetTriggered,
    bodyStripped,
    sessionCtx,
    ctx: finalized,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultProvider,
    defaultModel,
    aliasIndex,
  });

  const channelModelOverride = resolveChannelModelOverride({
    cfg,
    channel:
      groupResolution?.channel ??
      sessionEntry.channel ??
      sessionEntry.origin?.provider ??
      (typeof finalized.OriginatingChannel === "string"
        ? finalized.OriginatingChannel
        : undefined) ??
      finalized.Provider,
    groupId: groupResolution?.id ?? sessionEntry.groupId,
    groupChannel: sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
    groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
    parentSessionKey: sessionCtx.ParentSessionKey,
  });
  const hasSessionModelOverride = Boolean(
    sessionEntry.modelOverride?.trim() || sessionEntry.providerOverride?.trim(),
  );
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    return inlineActionResult.reply;
  }
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  await stageSandboxMedia({
    ctx,
    sessionCtx,
    cfg,
    sessionKey,
    workspaceDir,
  });

  return runPreparedReply({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts: resolvedOpts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    abortedLastRun,
  });
}
