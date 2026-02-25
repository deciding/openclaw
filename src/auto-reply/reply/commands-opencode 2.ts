import path from "node:path";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { CommandHandler } from "./commands-types.js";

const DEFAULT_OPENCODE_AGENT = "plan/build";
const OPENCODE_TIMEOUT_MS = 300_000;

async function persistSessionEntry(params: Parameters<CommandHandler>[0]): Promise<boolean> {
  if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) {
    return false;
  }
  params.sessionEntry.updatedAt = Date.now();
  params.sessionStore[params.sessionKey] = params.sessionEntry;
  if (params.storePath) {
    await updateSessionStore(params.storePath, (store) => {
      store[params.sessionKey] = params.sessionEntry as SessionEntry;
    });
  }
  return true;
}

function parseOpencodeCommand(body: string): {
  action: "enter" | "switch" | "model" | "exit" | null;
  value: string;
} {
  const normalized = body.trim().toLowerCase();

  if (normalized === "/opencode") {
    return { action: null, value: "" };
  }

  if (!normalized.startsWith("/opencode")) {
    return { action: null, value: "" };
  }

  const parts = normalized.slice(9).trim().split(/\s+/);
  const firstPart = parts[0] || "";

  if (firstPart === "exit") {
    return { action: "exit", value: "" };
  }

  if (firstPart === "switch") {
    const value = parts.slice(1).join(" ").trim() || DEFAULT_OPENCODE_AGENT;
    return { action: "switch", value };
  }

  if (firstPart === "model") {
    const value = parts.slice(1).join(" ").trim();
    return { action: "model", value };
  }

  if (firstPart) {
    const value = parts.join(" ").trim();
    return { action: "enter", value };
  }

  return { action: null, value: "" };
}

function validateProjectDir(projectDir: string): string | null {
  const normalized = path.normalize(projectDir);

  if (path.isAbsolute(normalized)) {
    return normalized;
  }

  return path.resolve(process.cwd(), normalized);
}

export const handleOpencodeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const { commandBodyNormalized } = params.command;
  if (!commandBodyNormalized.startsWith("/opencode")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /opencode from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const parsed = parseOpencodeCommand(commandBodyNormalized);
  const sessionEntry = params.sessionEntry;

  if (parsed.action === "exit") {
    if (sessionEntry) {
      sessionEntry.opencodeMode = false;
      sessionEntry.opencodeProjectDir = undefined;
      sessionEntry.opencodeAgent = undefined;
      sessionEntry.opencodeModel = undefined;
      await persistSessionEntry(params);
    }

    return {
      shouldContinue: true,
      reply: {
        text: "🚪 Exited opencode mode. Messages will now go to the normal OpenClaw agent.",
      },
    };
  }

  if (parsed.action === "switch") {
    if (!sessionEntry?.opencodeMode) {
      return {
        shouldContinue: true,
        reply: {
          text: "❌ Not in opencode mode. Use `/opencode [project_dir]` to enter opencode mode first.",
        },
      };
    }

    sessionEntry.opencodeAgent = parsed.value || DEFAULT_OPENCODE_AGENT;
    await persistSessionEntry(params);

    return {
      shouldContinue: true,
      reply: { text: `🤖 Opencode agent set to: ${sessionEntry.opencodeAgent}` },
    };
  }

  if (parsed.action === "model") {
    if (!sessionEntry?.opencodeMode) {
      return {
        shouldContinue: true,
        reply: {
          text: "❌ Not in opencode mode. Use `/opencode [project_dir]` to enter opencode mode first.",
        },
      };
    }

    if (!parsed.value) {
      sessionEntry.opencodeModel = undefined;
      await persistSessionEntry(params);
      return {
        shouldContinue: true,
        reply: { text: "🧹 Opencode model cleared (will use opencode's default)." },
      };
    }

    sessionEntry.opencodeModel = parsed.value;
    await persistSessionEntry(params);

    return {
      shouldContinue: true,
      reply: { text: `📦 Opencode model set to: ${sessionEntry.opencodeModel}` },
    };
  }

  if (parsed.action === "enter") {
    const projectDir = validateProjectDir(parsed.value);
    if (!projectDir) {
      return {
        shouldContinue: true,
        reply: { text: "❌ Invalid project directory." },
      };
    }

    if (sessionEntry) {
      sessionEntry.opencodeMode = true;
      sessionEntry.opencodeProjectDir = projectDir;
      sessionEntry.opencodeAgent = sessionEntry.opencodeAgent || DEFAULT_OPENCODE_AGENT;
      await persistSessionEntry(params);
    }

    return {
      shouldContinue: true,
      reply: {
        text:
          "🔓 Entered opencode mode!\n\n" +
          `Project: ${projectDir}\n` +
          `Agent: ${sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT}\n` +
          `Model: ${sessionEntry?.opencodeModel || "default"}\n\n` +
          "All messages will now be forwarded to opencode CLI. Use /opencode exit to leave.",
      },
    };
  }

  const isActive = sessionEntry?.opencodeMode;
  const currentProject = sessionEntry?.opencodeProjectDir || "none";
  const currentAgent = sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT;
  const currentModel = sessionEntry?.opencodeModel || "default";

  return {
    shouldContinue: true,
    reply: {
      text:
        `OpenCode Mode${isActive ? " (active)" : ""}\n\n` +
        `Usage:\n` +
        `• /opencode [proj_dir] - Enter opencode mode\n` +
        `• /opencode switch [agent] - Change agent (default: plan/build)\n` +
        `• /opencode model [model] - Set model\n` +
        `• /opencode exit - Exit opencode mode\n\n` +
        `Current:\n` +
        `• Project: ${currentProject}\n` +
        `• Agent: ${currentAgent}\n` +
        `• Model: ${currentModel}`,
    },
  };
};

export async function runOpencodeCommand(params: {
  message: string;
  projectDir: string;
  agent: string;
  model?: string;
}): Promise<{ text: string; error?: string }> {
  const args = ["run", params.message, "-c", "--agent", params.agent];

  if (params.model) {
    args.push("--model", params.model);
  }

  try {
    const result = await runCommandWithTimeout(args, {
      timeoutMs: OPENCODE_TIMEOUT_MS,
      cwd: params.projectDir,
    });

    if (result.termination === "timeout") {
      return { text: "", error: "⏱️ Command timed out." };
    }

    if (result.code !== 0 && result.stderr) {
      return { text: result.stdout, error: `⚠️ ${result.stderr}` };
    }

    return { text: result.stdout };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { text: "", error: `❌ Error: ${errorMessage}` };
  }
}
