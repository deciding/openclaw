import { getOGBroker } from "./0g-broker.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: unknown[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

function makeId(): string {
  return `chatcmpl-${Math.random().toString(36).substring(2, 15)}`;
}

function ts(): number {
  return Math.floor(Date.now() / 1000);
}

export async function chatCompletion(
  request: ChatCompletionRequest,
): Promise<ChatCompletionResponse> {
  const broker = await getOGBroker();

  const modelInfo = broker.resolve(request.model);
  if (!modelInfo) {
    throw new Error(`Unknown model: ${request.model}. Available models: ${broker.getModelCount()}`);
  }

  const contentForAuth = JSON.stringify(request.messages);
  const { headers, endpoint } = await broker.getAuth(modelInfo.provider, contentForAuth);

  const ogBody: Record<string, unknown> = {
    model: modelInfo.ogModel,
    messages: request.messages,
    max_tokens: request.max_tokens ?? 60000,
  };

  if (request.temperature !== undefined) {
    ogBody.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    ogBody.top_p = request.top_p;
  }
  if (request.stop !== undefined) {
    ogBody.stop = request.stop;
  }

  const fetchHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const upstream = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: fetchHeaders,
    body: JSON.stringify(ogBody),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    throw new Error(`0G API error: ${upstream.status} - ${errText}`);
  }

  const og = await upstream.json();
  const ogMsg = og.choices?.[0]?.message ?? {};
  const content = ogMsg.content ?? "";
  const usage = og.usage ?? {};

  const id = makeId();

  await broker.settleResponse(modelInfo.provider, null, usage);

  return {
    id,
    object: "chat.completion",
    created: ts(),
    model: request.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    },
  };
}

export async function chatCompletionStream(
  request: ChatCompletionRequest,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const broker = await getOGBroker();

  const modelInfo = broker.resolve(request.model);
  if (!modelInfo) {
    throw new Error(`Unknown model: ${request.model}`);
  }

  const contentForAuth = JSON.stringify(request.messages);
  const { headers, endpoint } = await broker.getAuth(modelInfo.provider, contentForAuth);

  const ogBody: Record<string, unknown> = {
    model: modelInfo.ogModel,
    messages: request.messages,
    stream: true,
    max_tokens: request.max_tokens ?? 60000,
  };

  if (request.temperature !== undefined) {
    ogBody.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    ogBody.top_p = request.top_p;
  }

  const fetchHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...headers,
  };

  const upstream = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: fetchHeaders,
    body: JSON.stringify(ogBody),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    throw new Error(`0G API error: ${upstream.status} - ${errText}`);
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n")) {
      const idx = buffer.indexOf("\n");
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);

      if (!line) {
        continue;
      }
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          onChunk("data: [DONE]\n\n");
          return;
        }

        try {
          const parsed = JSON.parse(data);
          parsed.model = request.model;
          onChunk(`data: ${JSON.stringify(parsed)}\n\n`);
        } catch {
          onChunk(`${line}\n\n`);
        }
      }
    }
  }

  if (buffer.trim()) {
    onChunk(`${buffer.trim()}\n\n`);
  }

  onChunk("data: [DONE]\n\n");
}
