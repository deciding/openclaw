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
import { applyLinkUnderstanding } from "../../link-understanding/apply.js";
import { applyMediaUnderstanding } from "../../media-understanding/apply.js";
import { defaultRuntime } from "../../runtime.js";
import { editSlackMessage } from "../../slack/actions.js";
import { sendMessageSlack } from "../../slack/send.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runOpencodeCommand, runOpencodeCommandStreaming, validateProjectDir } from "./commands-opencode.js";
import { resolveDefaultModel } from "./directive-handling.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { initSessionState } from "./session.js";
import { stageSandboxMedia } from "./stage-sandbox-media.js";
import { createTypingController } from "./typing.js";

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
  const channelLabel = sessionEntry?.origin?.label ?? finalized.GroupChannel ?? finalized.GroupSubject;
  const channelNameMatch = channelLabel?.match(/^(opencode|claude|codex)[-:](.+)$/i);

  if (channelNameMatch) {
    const [, mode, projectName] = channelNameMatch;
    const modeLower = mode.toLowerCase();
    const isOpencode = modeLower === "opencode";
    const isClaudeCode = modeLower === "claude";
    const isCodex = modeLower === "codex";

    // Check if we need to enter or switch mode
    const currentMode =
      sessionEntry?.opencodeMode ||
      (sessionEntry?.claudeCodeMode && "claude") ||
      (sessionEntry?.codexMode && "codex");

    const needsSwitch =
      (isOpencode && !sessionEntry?.opencodeMode) ||
      (isClaudeCode && !sessionEntry?.claudeCodeMode) ||
      (isCodex && !sessionEntry?.codexMode);

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
      const { validateProjectDir } = await import("./commands-opencode.js");
      projectDir = validateProjectDir(projectName) ?? "";
    }

    // Enter/switch mode if needed
    if (projectDir && (needsSwitch || !currentMode)) {
      typing.cleanup();

      if (isOpencode) {
        sessionEntry.opencodeMode = true;
        sessionEntry.opencodeProjectDir = projectDir;
        sessionEntry.opencodeAgent = sessionEntry.opencodeAgent || "build";
        sessionEntry.opencodeResponsePrefix = `[opencode:${projectName}|${sessionEntry.opencodeAgent}]`;
        // Clear other modes
        sessionEntry.claudeCodeMode = false;
        sessionEntry.codexMode = false;
      } else if (isClaudeCode) {
        sessionEntry.claudeCodeMode = true;
        sessionEntry.claudeCodeProjectDir = projectDir;
        sessionEntry.claudeCodeResponsePrefix = `[claude:${projectName}|agent]`;
        // Clear other modes
        sessionEntry.opencodeMode = false;
        sessionEntry.codexMode = false;
      } else if (isCodex) {
        sessionEntry.codexMode = true;
        sessionEntry.codexProjectDir = projectDir;
        sessionEntry.codexResponsePrefix = `[codex:${projectName}|agent]`;
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
        text: `🔓 Entered ${modeLabel} mode!\n\nProject: ${projectDir}\n\nAll messages will now be forwarded to ${modeLabel} CLI.`,
      };
    }
  }

  // Check for !oc command prefix (direct detection, before normal agent processing)
  // This works for all channels including Slack
  const trimmedBody = triggerBodyNormalized?.trim() ?? "";
  const isOpencodeCommand = /^!oc(\s|$)/i.test(trimmedBody);

  if (isOpencodeCommand) {
    typing.cleanup();
    const { handleOpencodeCommandDirect } = await import("./commands-opencode.js");
    const result = await handleOpencodeCommandDirect({
      commandBody: triggerBodyNormalized ?? "",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
    });
    if (result) {
      return result;
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
