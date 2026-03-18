# Plan: Add 0G Provider (Option B - Direct Integration)

## Overview

Integrate 0G directly into OpenClaw without requiring a separate proxy service. The integration uses the `@0glabs/0g-serving-broker` SDK to connect directly to the 0G Compute Network.

## Dependencies

Add to `package.json`:

```json
{
  "@0glabs/0g-serving-broker": "^0.7.2"
}
```

(Note: `ethers` is already a dependency in OpenClaw)

## Architecture

```
OpenClaw → 0G Provider → 0G Network → Models
```

## 0G Provider Details

| Detail       | Value                                         |
| ------------ | --------------------------------------------- |
| **API Type** | OpenAI-compatible (`openai-completions`)      |
| **RPC URL**  | `https://evmrpc.0g.ai` (default)              |
| **Auth**     | Wallet private key (blockchain-based)         |
| **Models**   | Auto-discovered from network + static catalog |

### Available Models

| Model        | ID                               | Type          | Capabilities                       |
| ------------ | -------------------------------- | ------------- | ---------------------------------- |
| GLM-5        | `zai-org/GLM-5-FP8`              | Chat          | Tool calling, reasoning, streaming |
| DeepSeek V3  | `deepseek/deepseek-chat-v3-0324` | Chat          | Tool calling, streaming            |
| GPT-OSS 120B | `openai/gpt-oss-120b`            | Chat          | General purpose, streaming         |
| Qwen3 VL 30B | `qwen/qwen3-vl-30b-a3b-instruct` | Chat + Vision | Image understanding, tool calling  |

### Pricing (in 0G tokens)

| Model        | Input (per 1M tokens) | Output (per 1M tokens) |
| ------------ | --------------------- | ---------------------- |
| GLM-5        | 1.0 0G                | 3.2 0G                 |
| DeepSeek V3  | 0.5 0G                | 1.5 0G                 |
| GPT-OSS 120B | 0.8 0G                | 2.4 0G                 |
| Qwen3 VL     | 0.5 0G                | 1.5 0G                 |

## Implementation Steps

### Step 1: Create 0G Model Catalog

**File**: `src/agents/0g-models.ts` (NEW)

```typescript
import type { ModelDefinitionConfig } from "../config/types.js";

export const OG_BASE_URL = "https://api.0g.ai/v1";
export const OG_DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export const OG_MODEL_CATALOG = [
  {
    id: "zai-org/GLM-5-FP8",
    name: "GLM-5",
    reasoning: true,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  {
    id: "deepseek/deepseek-chat-v3-0324",
    name: "DeepSeek V3",
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
  },
  // ... more models
];

export function buildOgModelDefinition(
  entry: (typeof OG_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    id: entry.id,
    name: entry.name,
    reasoning: entry.reasoning,
    input: [...entry.input],
    cost: OG_DEFAULT_COST,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}
```

### Step 2: Create 0G Broker Integration

**File**: `src/agents/0g-broker.ts` (NEW)

Core class that wraps `@0glabs/0g-serving-broker`:

```typescript
import { ethers } from "ethers";
import { createZGComputeNetworkBroker } from "@0glabs/0g-serving-broker";

interface ModelInfo {
  provider: string;
  endpoint: string;
  ogModel: string;
  type: string;
}

export class OGBroker {
  private broker: any = null;
  private models = new Map<string, ModelInfo>();
  private acknowledged = new Set<string>();
  private rpcUrl: string;
  private privateKey: string;

  constructor(rpcUrl: string, privateKey: string) {
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
  }

  async initialize(): Promise<void> {
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const wallet = new ethers.Wallet(this.privateKey, provider);
    this.broker = await createZGComputeNetworkBroker(wallet);
  }

  async discoverModels(): Promise<void> {
    const services = await this.broker.inference.listService();
    // Parse and store model info
  }

  async getAuth(providerAddr: string, content: string): Promise<AuthInfo> {
    // Get headers and endpoint from 0G
  }

  async settleResponse(providerAddr: string, chatId: string, usage: Usage): Promise<void> {
    // Settlement after response
  }

  resolve(modelName: string): ModelInfo | undefined {
    return this.models.get(modelName);
  }
}
```

**Key methods**:

- `initialize()` - Initialize broker with wallet
- `discoverModels()` - Fetch available models from 0G network
- `getAuth()` - Get auth headers and endpoint for a provider
- `settleResponse()` - Process payment after request
- `resolve()` - Look up model by name

### Step 3: Register Provider in models-config.providers.ts

**File**: `src/agents/models-config.providers.ts`

Add:

1. Import 0G catalog
2. Add `build0GProvider()` function
3. Register in provider builders

```typescript
import { OG_BASE_URL, OG_MODEL_CATALOG, buildOgModelDefinition } from "./0g-models.js";

function build0GProvider(): ProviderConfig {
  return {
    baseUrl: OG_BASE_URL,
    api: "openai-completions",
    models: OG_MODEL_CATALOG.map(buildOgModelDefinition),
  };
}
```

### Step 4: Configure Auth

**Environment variables**:

- `OG_PRIVATE_KEY` - Wallet private key for 0G network
- `OG_RPC_URL` - RPC endpoint (default: `https://evmrpc.0g.ai`)

**Auth integration**:

- Use existing auth profile mechanism
- Or add special handling in `resolveApiKey()` for `0g` provider

### Step 5: Implement Chat Completions

**File**: `src/agents/0g-chat.ts` (NEW)

Handle chat completions with:

- Tool calling support
- Streaming support
- Response parsing for different model formats

Key logic from server.js to port:

- `buildToolPrompt()` - Build tool prompts for different models
- `parseToolCalls()` - Parse tool calls from various formats
- Streaming/non-streaming handlers

### Step 6: Add Provider to Model Selection

Ensure 0G appears in:

- `openclaw models` command
- Onboarding model picker
- Config file generation

## Files to Create

| File                      | Purpose          |
| ------------------------- | ---------------- |
| `src/agents/0g-models.ts` | Model catalog    |
| `src/agents/0g-broker.ts` | SDK wrapper      |
| `src/agents/0g-chat.ts`   | Chat completions |

## Files to Modify

| File                                    | Change                          |
| --------------------------------------- | ------------------------------- |
| `package.json`                          | Add `@0glabs/0g-serving-broker` |
| `src/agents/models-config.providers.ts` | Add provider builder            |
| `src/agents/models-config.ts`           | Register provider               |
| `AGENTS.md`                             | Document new provider           |

## Complexity Assessment

| Component        | LOC (approx) | Difficulty  |
| ---------------- | ------------ | ----------- |
| Model catalog    | 50           | Easy        |
| Broker wrapper   | 150          | Medium      |
| Chat completions | 300          | Medium-Hard |
| Auth integration | 50           | Easy        |
| **Total**        | ~550         | Medium-Hard |

## Testing

1. Unit tests for model catalog
2. Mock broker for chat completions
3. Integration test with real 0G (requires private key and funds)

## Open Questions

1. Should we cache model discovery or refresh on each request?
2. How to handle rate limiting?
3. Should we implement admin APIs (wallet balance, etc.)?
4. How to handle image generation and transcription?
