import type { ModelDefinitionConfig } from "../config/types.js";

export const OG_BASE_URL = "https://api.0g.ai/v1";
export const OG_RPC_URL = process.env.OG_RPC_URL || "https://evmrpc.0g.ai";

export const OG_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const OG_MODEL_CATALOG = [
  {
    id: "zai-org/GLM-5-FP8",
    name: "GLM-5",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "openai/gpt-oss-120b",
    name: "GPT-OSS 120B",
    reasoning: false,
    input: ["text"] as const,
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "qwen/qwen3-vl-30b-a3b-instruct",
    name: "Qwen3 VL 30B",
    reasoning: false,
    input: ["text", "image"] as const,
    contextWindow: 32000,
    maxTokens: 8192,
  },
];

export type OgCatalogEntry = (typeof OG_MODEL_CATALOG)[number];

export function buildOgModelDefinition(entry: OgCatalogEntry): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: OG_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
