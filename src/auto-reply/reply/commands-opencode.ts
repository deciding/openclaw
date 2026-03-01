import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OPENCODE_AGENT = "build";
const OPENCODE_TIMEOUT_MS = 300_000;

async function findOpencodeBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["opencode"]);
    const binaryPath = stdout.trim();
    if (binaryPath) {
      return binaryPath;
    }
  } catch {
    // which failed, continue to fallback
  }

  const commonPaths = [
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    path.join(os.homedir(), ".local/bin/opencode"),
    path.join(os.homedir(), "Library/pnpm/opencode"),
  ];

  for (const p of commonPaths) {
    try {
      const { access } = await import("node:fs/promises");
      await access(p);
      return p;
    } catch {
      continue;
    }
  }

  return "opencode";
}

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
  const normalized = body.trim();
  const commandPrefix = "!oc";

  if (normalized === commandPrefix) {
    return { action: null, value: "" };
  }

  if (!normalized.toLowerCase().startsWith(commandPrefix)) {
    return { action: null, value: "" };
  }

  const parts = normalized.slice(commandPrefix.length).trim().split(/\s+/);
  const firstPart = (parts[0] || "").toLowerCase();

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

  if (parts[0]) {
    const value = parts.join(" ").trim();
    return { action: "enter", value };
  }

  return { action: null, value: "" };
}

export function validateProjectDir(projectDir: string): string | null {
  if (!projectDir || projectDir.trim() === "") {
    return null;
  }

  let expanded = projectDir.trim();

  if (expanded.startsWith("~")) {
    const home = os.homedir();
    if (expanded === "~") {
      expanded = home;
    } else if (expanded.startsWith("~/")) {
      expanded = path.join(home, expanded.slice(2));
    } else {
      expanded = path.join(home, expanded.slice(1));
    }
  }

  const normalized = path.normalize(expanded);

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
  const trimmedCommand = commandBodyNormalized.trim();
  if (!trimmedCommand.toLowerCase().startsWith("!oc")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring !oc from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
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
      sessionEntry.opencodeResponsePrefix = undefined;
      await persistSessionEntry(params);
    }

    return {
      shouldContinue: false,
      reply: {
        text: "🚪 Exited opencode mode. Messages will now go to the normal OpenClaw agent.",
      },
    };
  }

  if (parsed.action === "switch") {
    if (!sessionEntry?.opencodeMode) {
      return {
        shouldContinue: false,
        reply: {
          text: "❌ Not in opencode mode. Use `!oc [project_dir]` to enter opencode mode first.",
        },
      };
    }

    sessionEntry.opencodeAgent = parsed.value || DEFAULT_OPENCODE_AGENT;
    const repoName = sessionEntry.opencodeProjectDir
      ? getRepoName(sessionEntry.opencodeProjectDir)
      : "unknown";
    sessionEntry.opencodeResponsePrefix = `[opencode:${repoName}|${sessionEntry.opencodeAgent}]`;
    await persistSessionEntry(params);

    return {
      shouldContinue: false,
      reply: { text: `🤖 Opencode agent set to: ${sessionEntry.opencodeAgent}` },
    };
  }

  if (parsed.action === "model") {
    if (!sessionEntry?.opencodeMode) {
      return {
        shouldContinue: false,
        reply: {
          text: "❌ Not in opencode mode. Use `!oc [project_dir]` to enter opencode mode first.",
        },
      };
    }

    if (!parsed.value) {
      sessionEntry.opencodeModel = undefined;
      await persistSessionEntry(params);
      return {
        shouldContinue: false,
        reply: { text: "🧹 Opencode model cleared (will use opencode's default)." },
      };
    }

    sessionEntry.opencodeModel = parsed.value;
    await persistSessionEntry(params);

    return {
      shouldContinue: false,
      reply: { text: `📦 Opencode model set to: ${sessionEntry.opencodeModel}` },
    };
  }

  if (parsed.action === "enter") {
    const projectDir = validateProjectDir(parsed.value);
    if (!projectDir) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Invalid project directory." },
      };
    }

    const repoName = getRepoName(projectDir);
    const agent = sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT;
    const responsePrefix = `[opencode:${repoName}|${agent}]`;

    if (sessionEntry) {
      sessionEntry.opencodeMode = true;
      sessionEntry.opencodeProjectDir = projectDir;
      sessionEntry.opencodeAgent = sessionEntry.opencodeAgent || DEFAULT_OPENCODE_AGENT;
      sessionEntry.opencodeResponsePrefix = responsePrefix;
      await persistSessionEntry(params);
    }

    return {
      shouldContinue: false,
      reply: {
        text:
          "🔓 Entered opencode mode!\n\n" +
          `Project: ${projectDir}\n` +
          `Agent: ${sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT}\n` +
          `Model: ${sessionEntry?.opencodeModel || "default"}\n\n` +
          "All messages will now be forwarded to opencode CLI. Use !oc exit to leave.",
      },
    };
  }

  const isActive = sessionEntry?.opencodeMode;
  const currentProject = sessionEntry?.opencodeProjectDir || "none";
  const currentAgent = sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT;
  const currentModel = sessionEntry?.opencodeModel || "default";

  return {
    shouldContinue: false,
    reply: {
      text:
        `OpenCode Mode${isActive ? " (active)" : ""}\n\n` +
        `Usage:\n` +
        `• !oc [proj_dir] - Enter opencode mode\n` +
        `• !oc switch [agent] - Change agent (default: plan/build)\n` +
        `• !oc model [model] - Set model\n` +
        `• !oc exit - Exit opencode mode\n\n` +
        `Current:\n` +
        `• Project: ${currentProject}\n` +
        `• Agent: ${currentAgent}\n` +
        `• Model: ${currentModel}`,
    },
  };
};

function getRepoName(projectDir: string): string {
  if (!projectDir) {
    return "unknown";
  }
  const basename = path.basename(projectDir.replace(/\/+$/, ""));
  return basename || "unknown";
}

export async function runOpencodeCommand(params: {
  message: string;
  projectDir: string;
  agent: string;
  model?: string;
}): Promise<{ text: string; error?: string; responsePrefix?: string }> {
  const opencodePath = await findOpencodeBinary();
  const repoName = getRepoName(params.projectDir);
  const responsePrefix = `[opencode:${repoName}|${params.agent}]`;

  const args = ["run", params.message, "-c", "--agent", params.agent, "--thinking"];

  if (params.model) {
    args.push("--model", params.model);
  }

  try {
    const result = await runCommandWithTimeout([opencodePath, ...args], {
      timeoutMs: OPENCODE_TIMEOUT_MS,
      cwd: params.projectDir,
    });

    if (result.termination === "timeout") {
      return { text: "", error: "⏱️ Command timed out.", responsePrefix };
    }

    if (result.code !== 0 && result.stderr) {
      return { text: result.stdout, error: `⚠️ ${result.stderr}`, responsePrefix };
    }

    return { text: result.stdout, responsePrefix };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { text: "", error: `❌ Error: ${errorMessage}`, responsePrefix };
  }
}

export async function runOpencodeCommandStreaming(params: {
  message: string;
  projectDir: string;
  agent: string;
  model?: string;
  onChunk: (chunk: string) => void;
}): Promise<{ error?: string }> {
  const opencodePath = await findOpencodeBinary();

  const args = ["run", params.message, "-c", "--agent", params.agent, "--thinking"];

  if (params.model) {
    args.push("--model", params.model);
  }

  return new Promise((resolve) => {
    const child = spawn(opencodePath, args, {
      cwd: params.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ error: "⏱️ Command timed out." });
    }, OPENCODE_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      params.onChunk(chunk);
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      params.onChunk(`\n❌ Error: ${err.message}`);
      resolve({ error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && stderr) {
        params.onChunk(`\n⚠️ ${stderr}`);
        resolve({ error: stderr });
      } else {
        resolve({ error: undefined });
      }
    });
  });
}

export async function handleOpencodeCommandDirect(params: {
  commandBody: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}): Promise<ReplyPayload | null> {
  const { commandBody, sessionEntry, sessionStore, sessionKey, storePath } = params;

  const parsed = parseOpencodeCommand(commandBody);

  if (!parsed.action) {
    return {
      text:
        "OpenCode Mode\n\n" +
        "Usage:\n" +
        `• !oc [proj_dir] - Enter opencode mode\n` +
        `• !oc switch [agent] - Change agent (default: plan/build)\n` +
        `• !oc model [model] - Set model\n` +
        `• !oc exit - Exit opencode mode\n\n` +
        `Current:\n` +
        `• Project: ${sessionEntry?.opencodeProjectDir || "none"}\n` +
        `• Agent: ${sessionEntry?.opencodeAgent || "plan/build"}\n` +
        `• Model: ${sessionEntry?.opencodeModel || "default"}`,
    };
  }

  if (parsed.action === "exit") {
    if (sessionEntry) {
      sessionEntry.opencodeMode = false;
      sessionEntry.opencodeProjectDir = undefined;
      sessionEntry.opencodeAgent = undefined;
      sessionEntry.opencodeModel = undefined;
      sessionEntry.opencodeResponsePrefix = undefined;
      if (sessionKey && sessionStore && storePath) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
    return { text: "🚪 Exited opencode mode. Messages will now go to the normal OpenClaw agent." };
  }

  if (parsed.action === "switch") {
    if (!sessionEntry?.opencodeMode) {
      return {
        text: "❌ Not in opencode mode. Use `!oc [project_dir]` to enter opencode mode first.",
      };
    }
    sessionEntry.opencodeAgent = parsed.value || DEFAULT_OPENCODE_AGENT;
    if (sessionKey && sessionStore && storePath) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
    return { text: `🤖 Opencode agent set to: ${sessionEntry.opencodeAgent}` };
  }

  if (parsed.action === "model") {
    if (!sessionEntry?.opencodeMode) {
      return {
        text: "❌ Not in opencode mode. Use `!oc [project_dir]` to enter opencode mode first.",
      };
    }
    if (!parsed.value) {
      sessionEntry.opencodeModel = undefined;
      if (sessionKey && sessionStore && storePath) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
      return { text: "🧹 Opencode model cleared (will use opencode's default)." };
    }
    sessionEntry.opencodeModel = parsed.value;
    if (sessionKey && sessionStore && storePath) {
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
    return { text: `📦 Opencode model set to: ${sessionEntry.opencodeModel}` };
  }

  if (parsed.action === "enter") {
    const projectDir = validateProjectDir(parsed.value);
    if (!projectDir) {
      return { text: "❌ Invalid project directory." };
    }
    const repoName = getRepoName(projectDir);
    const agent = sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT;
    const responsePrefix = `[opencode:${repoName}|${agent}]`;
    if (sessionEntry) {
      sessionEntry.opencodeMode = true;
      sessionEntry.opencodeProjectDir = projectDir;
      sessionEntry.opencodeAgent = sessionEntry.opencodeAgent || DEFAULT_OPENCODE_AGENT;
      sessionEntry.opencodeResponsePrefix = responsePrefix;
      if (sessionKey && sessionStore && storePath) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
    return {
      text:
        "🔓 Entered opencode mode!\n\n" +
        `Project: ${projectDir}\n` +
        `Agent: ${sessionEntry?.opencodeAgent || DEFAULT_OPENCODE_AGENT}\n` +
        `Model: ${sessionEntry?.opencodeModel || "default"}\n\n` +
        "All messages will now be forwarded to opencode CLI. Use !oc exit to leave.",
    };
  }

  return null;
}

const CLAUDE_CODE_TIMEOUT_MS = 300_000;
const CODEX_TIMEOUT_MS = 300_000;

async function findClaudeCodeBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["claude"]);
    const binaryPath = stdout.trim();
    if (binaryPath) {
      return binaryPath;
    }
  } catch {
    // which failed, continue to fallback
  }

  const commonPaths = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(os.homedir(), ".local/bin/claude"),
    path.join(os.homedir(), "Library/pnpm/claude"),
  ];

  for (const p of commonPaths) {
    try {
      const { access } = await import("node:fs/promises");
      await access(p);
      return p;
    } catch {
      continue;
    }
  }

  return "claude";
}

async function findCodexBinary(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("which", ["codex"]);
    const binaryPath = stdout.trim();
    if (binaryPath) {
      return binaryPath;
    }
  } catch {
    // which failed, continue to fallback
  }

  const commonPaths = [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    path.join(os.homedir(), ".local/bin/codex"),
    path.join(os.homedir(), "Library/pnpm/codex"),
  ];

  for (const p of commonPaths) {
    try {
      const { access } = await import("node:fs/promises");
      await access(p);
      return p;
    } catch {
      continue;
    }
  }

  return "codex";
}

export async function runClaudeCodeCommand(params: {
  message: string;
  projectDir: string;
  agent?: string;
  model?: string;
}): Promise<{ text: string; error?: string; responsePrefix?: string }> {
  const claudePath = await findClaudeCodeBinary();
  const repoName = getRepoName(params.projectDir);
  const responsePrefix = `[claude:${repoName}|${params.agent || "build"}]`;

  const args = ["-c", "-p"];

  if (params.agent) {
    args.push("--agent", params.agent);
  }

  args.push(params.message);

  if (params.model) {
    args.push("--model", params.model);
  }

  try {
    const result = await runCommandWithTimeout([claudePath, ...args], {
      timeoutMs: CLAUDE_CODE_TIMEOUT_MS,
      cwd: params.projectDir,
    });

    if (result.termination === "timeout") {
      return { text: "", error: "⏱️ Command timed out.", responsePrefix };
    }

    if (result.code !== 0 && result.stderr) {
      return { text: result.stdout, error: `⚠️ ${result.stderr}`, responsePrefix };
    }

    return { text: result.stdout, responsePrefix };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { text: "", error: `❌ Error: ${errorMessage}`, responsePrefix };
  }
}

export async function runClaudeCodeCommandStreaming(params: {
  message: string;
  projectDir: string;
  agent?: string;
  model?: string;
  onChunk: (chunk: string) => void;
}): Promise<{ error?: string }> {
  const claudePath = await findClaudeCodeBinary();

  const args = ["-c", "-p"];

  if (params.agent) {
    args.push("--agent", params.agent);
  }

  args.push(params.message);

  if (params.model) {
    args.push("--model", params.model);
  }

  return new Promise((resolve) => {
    const child = spawn(claudePath, args, {
      cwd: params.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ error: "⏱️ Command timed out." });
    }, CLAUDE_CODE_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      params.onChunk(chunk);
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      params.onChunk(`\n❌ Error: ${err.message}`);
      resolve({ error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && stderr) {
        params.onChunk(`\n⚠️ ${stderr}`);
        resolve({ error: stderr });
      } else {
        resolve({ error: undefined });
      }
    });
  });
}

export async function runCodexCommand(params: {
  message: string;
  projectDir: string;
  agent?: string;
  model?: string;
}): Promise<{ text: string; error?: string; responsePrefix?: string }> {
  const codexPath = await findCodexBinary();
  const repoName = getRepoName(params.projectDir);
  const responsePrefix = `[codex:${repoName}|${params.agent || "build"}]`;

  const args = ["exec"];

  if (params.projectDir) {
    args.push("-C", params.projectDir);
  }

  if (params.agent === "plan") {
    args.push("--sandbox", "read-only");
  }

  // Always continue last session
  args.push("resume", "--last");

  args.push(params.message);

  if (params.model) {
    args.push("--model", params.model);
  }

  try {
    const result = await runCommandWithTimeout([codexPath, ...args], {
      timeoutMs: CODEX_TIMEOUT_MS,
    });

    if (result.termination === "timeout") {
      return { text: "", error: "⏱️ Command timed out.", responsePrefix };
    }

    if (result.code !== 0 && result.stderr) {
      return { text: result.stdout, error: `⚠️ ${result.stderr}`, responsePrefix };
    }

    return { text: result.stdout, responsePrefix };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { text: "", error: `❌ Error: ${errorMessage}`, responsePrefix };
  }
}

export async function runCodexCommandStreaming(params: {
  message: string;
  projectDir: string;
  agent?: string;
  model?: string;
  onChunk: (chunk: string) => void;
}): Promise<{ error?: string }> {
  const codexPath = await findCodexBinary();

  const args = ["exec"];

  if (params.projectDir) {
    args.push("-C", params.projectDir);
  }

  if (params.agent === "plan") {
    args.push("--sandbox", "read-only");
  }

  // Always continue last session
  args.push("resume", "--last");

  args.push(params.message);

  if (params.model) {
    args.push("--model", params.model);
  }

  return new Promise((resolve) => {
    const child = spawn(codexPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ error: "⏱️ Command timed out." });
    }, CODEX_TIMEOUT_MS);

    child.stdout?.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      params.onChunk(chunk);
    });

    child.stderr?.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      params.onChunk(`\n❌ Error: ${err.message}`);
      resolve({ error: err.message });
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 && stderr) {
        params.onChunk(`\n⚠️ ${stderr}`);
        resolve({ error: stderr });
      } else {
        resolve({ error: undefined });
      }
    });
  });
}
