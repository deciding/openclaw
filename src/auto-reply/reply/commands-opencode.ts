import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandler } from "./commands-types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_OPENCODE_AGENT = "build";
const OPENCODE_TIMEOUT_MS = 300_000;

export type AutoLevel = "l0" | "l1" | "l2" | "l3" | "l4";

export interface AutoLevelResult {
  level: AutoLevel;
  ratio: number;
  percentage: number;
  totalRequests: number;
  totalAccepted: number;
}

export function calculateAutoLevel(params: {
  projectDir: string;
  mode: string;
}): AutoLevelResult {
  const { projectDir, mode } = params;

  const handclawDir = path.join(projectDir, ".handclaw");
  const fileName = `USER_FEEDBACK_${mode.toUpperCase()}.md`;
  const filePath = path.join(handclawDir, fileName);

  let totalRequests = 1;
  let totalAccepted = 0;

  if (existsSync(filePath)) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const codingMatch = content.match(/coding_requests:\s*(\d+)/i);
      const acceptedMatch = content.match(/codes_accepted:\s*(\d+)/i);
      totalRequests = codingMatch ? parseInt(codingMatch[1], 10) : 1;
      totalAccepted = acceptedMatch ? parseInt(acceptedMatch[1], 10) : 0;
    } catch {
      // Use defaults
    }
  } else {
    try {
      mkdir(handclawDir, { recursive: true });
      const initContent = `# Code Feedback - ${mode}

coding_requests: ${totalRequests}
codes_accepted: ${totalAccepted}
last_updated: ${new Date().toISOString()}
`;
      writeFile(filePath, initContent);
    } catch {
      // Use defaults
    }
  }

  const ratio = totalRequests > 0 ? totalAccepted / totalRequests : 0;
  const percentage = Math.round(ratio * 100);

  let ratioLevel: AutoLevel;
  if (ratio <= 0.1) {
    ratioLevel = "l0";
  } else if (ratio <= 0.2) {
    ratioLevel = "l1";
  } else if (ratio <= 0.4) {
    ratioLevel = "l2";
  } else if (ratio <= 0.8) {
    ratioLevel = "l3";
  } else {
    ratioLevel = "l4";
  }

  let requestCap: AutoLevel;
  if (totalRequests < 20) {
    requestCap = "l0";
  } else if (totalRequests < 50) {
    requestCap = "l1";
  } else if (totalRequests < 100) {
    requestCap = "l2";
  } else {
    requestCap = "l4";
  }

  const levelOrder: AutoLevel[] = ["l0", "l1", "l2", "l3", "l4"];
  const ratioIndex = levelOrder.indexOf(ratioLevel);
  const capIndex = levelOrder.indexOf(requestCap);
  const finalLevel = levelOrder[Math.min(ratioIndex, capIndex)];

  return {
    level: finalLevel,
    ratio,
    percentage,
    totalRequests,
    totalAccepted,
  };
}

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
  action: "enter" | "switch" | "model" | "exit" | "plan" | "build" | null;
  value: string;
} {
  const normalized = body.trim();
  const commandPrefix = "!code";

  if (normalized === commandPrefix) {
    return { action: null, value: "" };
  }

  if (!normalized.toLowerCase().startsWith(commandPrefix)) {
    if (normalized.toLowerCase().startsWith("!plan ")) {
      return { action: "plan", value: normalized.slice("!plan".length).trim() };
    }
    if (normalized.toLowerCase().startsWith("!build ")) {
      return { action: "build", value: normalized.slice("!build".length).trim() };
    }
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
  if (!trimmedCommand.toLowerCase().startsWith("!code")) {
    return null;
  }

  if (!params.command.isAuthorizedSender) {
    logVerbose(`Ignoring !code from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
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
      sessionEntry.claudeCodeMode = false;
      sessionEntry.claudeCodeProjectDir = undefined;
      sessionEntry.claudeCodeAgent = undefined;
      sessionEntry.claudeCodeModel = undefined;
      sessionEntry.claudeCodeResponsePrefix = undefined;
      sessionEntry.codexMode = false;
      sessionEntry.codexProjectDir = undefined;
      sessionEntry.codexAgent = undefined;
      sessionEntry.codexModel = undefined;
      sessionEntry.codexResponsePrefix = undefined;
      await persistSessionEntry(params);
    }

    return {
      shouldContinue: false,
      reply: {
        text: "🚪 Exited coding mode. Messages will now go to the normal OpenClaw agent.",
      },
    };
  }

  if (parsed.action === "switch") {
    const currentMode = sessionEntry?.opencodeMode ? "opencode" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.codexMode ? "codex" : null;
    if (!currentMode || !sessionEntry) {
      return {
        shouldContinue: false,
        reply: {
          text: "❌ Not in coding mode. Use `!code [project_dir]` to enter coding mode first.",
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
    const currentMode = sessionEntry?.opencodeMode ? "opencode" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.codexMode ? "codex" : null;
    if (!currentMode || !sessionEntry) {
      return {
        shouldContinue: false,
        reply: { text: "❌ Not in coding mode. Use `!code [project_dir]` to enter coding mode first." },
      };
    }
    if (!parsed.value) {
      sessionEntry.opencodeModel = undefined;
      await persistSessionEntry(params);
      return {
        shouldContinue: false,
        reply: { text: "🧹 Model cleared (will use default)." },
      };
    }

    sessionEntry.opencodeModel = parsed.value;
    await persistSessionEntry(params);

    return {
      shouldContinue: false,
      reply: { text: `📦 Model set to: ${sessionEntry.opencodeModel}` },
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
          "All messages will now be forwarded to opencode CLI. Use !code exit to leave.",
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
        `• !code [proj_dir] - Enter opencode mode\n` +
        `• !code switch [agent] - Change agent (default: plan/build)\n` +
        `• !code model [model] - Set model\n` +
        `• !code exit - Exit opencode mode\n\n` +
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
  channelLabel?: string;
}): Promise<ReplyPayload | null> {
  const { commandBody, sessionEntry, sessionStore, sessionKey, storePath, channelLabel } = params;

  const parsed = parseOpencodeCommand(commandBody);

  if (!parsed.action) {
    const currentMode = sessionEntry?.opencodeMode ? "opencode" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.codexMode ? "codex" : null;
    const currentProject = sessionEntry?.opencodeProjectDir || sessionEntry?.claudeCodeProjectDir || sessionEntry?.codexProjectDir || "none";
    const currentAgent = sessionEntry?.opencodeAgent || sessionEntry?.claudeCodeAgent || sessionEntry?.codexAgent || "plan/build";
    const currentModel = sessionEntry?.opencodeModel || sessionEntry?.claudeCodeModel || sessionEntry?.codexModel || "default";

    return {
      text:
        "Coding Mode\n\n" +
        "Usage:\n" +
        `• !code [proj_dir] - Enter coding mode\n` +
        `• !code switch [agent] - Change agent (default: plan/build)\n` +
        `• !code model [model] - Set model\n` +
        `• !code exit - Exit coding mode\n` +
        `• !plan <msg> - Run with plan agent\n` +
        `• !build <msg> - Run with build agent\n\n` +
        `Current:\n` +
        `• Mode: ${currentMode || "none"}\n` +
        `• Project: ${currentProject}\n` +
        `• Agent: ${currentAgent}\n` +
        `• Model: ${currentModel}`,
    };
  }

  if (parsed.action === "exit") {
    if (sessionEntry) {
      sessionEntry.opencodeMode = false;
      sessionEntry.opencodeProjectDir = undefined;
      sessionEntry.opencodeAgent = undefined;
      sessionEntry.opencodeModel = undefined;
      sessionEntry.opencodeResponsePrefix = undefined;
      sessionEntry.claudeCodeMode = false;
      sessionEntry.claudeCodeProjectDir = undefined;
      sessionEntry.claudeCodeAgent = undefined;
      sessionEntry.claudeCodeModel = undefined;
      sessionEntry.claudeCodeResponsePrefix = undefined;
      sessionEntry.codexMode = false;
      sessionEntry.codexProjectDir = undefined;
      sessionEntry.codexAgent = undefined;
      sessionEntry.codexModel = undefined;
      sessionEntry.codexResponsePrefix = undefined;
      if (sessionKey && sessionStore && storePath) {
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
    return { text: "🚪 Exited coding mode. Messages will now go to the normal OpenClaw agent." };
  }

  if (parsed.action === "switch") {
    const currentMode = sessionEntry?.opencodeMode ? "opencode" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.codexMode ? "codex" : null;
    if (!currentMode || !sessionEntry) {
      return {
        text: "❌ Not in coding mode. Use `!code [project_dir]` to enter coding mode first.",
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
    return { text: `🤖 Agent set to: ${sessionEntry.opencodeAgent}` };
  }

  if (parsed.action === "model") {
    const currentMode = sessionEntry?.opencodeMode ? "opencode" : sessionEntry?.claudeCodeMode ? "claude" : sessionEntry?.codexMode ? "codex" : null;
    if (!currentMode || !sessionEntry) {
      return {
        text: "❌ Not in opencode mode. Use `!code [project_dir]` to enter opencode mode first.",
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
        "All messages will now be forwarded to opencode CLI. Use !code exit to leave.",
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
