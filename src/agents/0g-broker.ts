import {
  createZGComputeNetworkBroker,
  type ZGComputeNetworkBroker,
} from "@0glabs/0g-serving-broker";
import { ethers } from "ethers";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";

export interface OgModelInfo {
  provider: string;
  endpoint: string;
  ogModel: string;
  type: string;
}

export interface OgAuthInfo {
  headers: Record<string, string>;
  endpoint: string;
  model: string;
}

export class OGBroker {
  private broker: ZGComputeNetworkBroker | null = null;
  private models = new Map<string, OgModelInfo>();
  private acknowledged = new Set<string>();
  private rpcUrl: string;
  private privateKey: string;
  private initialized = false;

  constructor(rpcUrl: string, privateKey: string) {
    this.rpcUrl = rpcUrl;
    this.privateKey = privateKey;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wallet = new ethers.Wallet(this.privateKey, provider) as any;
    this.broker = await createZGComputeNetworkBroker(wallet);
    this.initialized = true;
  }

  async discoverModels(): Promise<void> {
    if (!this.broker) {
      throw new Error("Broker not initialized. Call initialize() first.");
    }

    const services = await this.broker.inference.listService();
    this.models.clear();

    for (const svc of services) {
      const [providerAddr, serviceType, endpoint, , , , modelName] = svc as unknown as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];

      const shortName = modelName.split("/").pop()?.toLowerCase() ?? "";
      if (!this.models.has(shortName)) {
        this.models.set(shortName, {
          provider: providerAddr,
          endpoint,
          ogModel: modelName,
          type: serviceType,
        });
      }

      if (!this.models.has(modelName)) {
        this.models.set(modelName, {
          provider: providerAddr,
          endpoint,
          ogModel: modelName,
          type: serviceType,
        });
      }
    }
  }

  async acknowledge(providerAddr: string): Promise<void> {
    if (!this.broker) {
      throw new Error("Broker not initialized. Call initialize() first.");
    }

    if (this.acknowledged.has(providerAddr)) {
      return;
    }

    try {
      await this.broker.inference.acknowledgeProviderSigner(providerAddr);
      this.acknowledged.add(providerAddr);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (errorMessage.includes("already") || errorMessage.includes("Acknowledged")) {
        this.acknowledged.add(providerAddr);
      } else {
        throw err;
      }
    }
  }

  async getAuth(providerAddr: string, content: string): Promise<OgAuthInfo> {
    if (!this.broker) {
      throw new Error("Broker not initialized. Call initialize() first.");
    }

    await this.acknowledge(providerAddr);
    const { endpoint, model } = await this.broker.inference.getServiceMetadata(providerAddr);
    const rawHeaders = await this.broker.inference.getRequestHeaders(providerAddr, content);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key] = String(value);
    }
    return { headers, endpoint, model };
  }

  async settleResponse(
    providerAddr: string,
    chatId: string | null,
    usage?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.broker) {
      throw new Error("Broker not initialized. Call initialize() first.");
    }

    try {
      const usageStr = usage ? JSON.stringify(usage) : undefined;
      await this.broker.inference.processResponse(providerAddr, chatId ?? undefined, usageStr);
    } catch (err) {
      console.warn("[0G] settleResponse failed:", err);
    }
  }

  resolve(modelName: string): OgModelInfo | undefined {
    return this.models.get(modelName) ?? this.models.get(modelName.toLowerCase());
  }

  getModelCount(): number {
    return this.models.size;
  }

  getModels(): Map<string, OgModelInfo> {
    return this.models;
  }
}

let globalBroker: OGBroker | null = null;

export async function getOGBroker(
  privateKey?: string,
  rpcUrl?: string,
  config?: OpenClawConfig,
): Promise<OGBroker> {
  const cfg = config ?? loadConfig();
  const ogConfig = cfg.models?.providers?.["0g"] as { privateKey?: string } | undefined;
  const pk = privateKey ?? process.env.OG_PRIVATE_KEY ?? ogConfig?.privateKey;
  const rpc = rpcUrl ?? process.env.OG_RPC_URL ?? "https://evmrpc.0g.ai";

  if (!pk) {
    throw new Error(
      "OG_PRIVATE_KEY not set. Configure via environment variable, config, or parameter.",
    );
  }

  if (!globalBroker) {
    globalBroker = new OGBroker(rpc, pk);
    await globalBroker.initialize();
    await globalBroker.discoverModels();
  }

  return globalBroker;
}

export function resetOGBroker(): void {
  globalBroker = null;
}
