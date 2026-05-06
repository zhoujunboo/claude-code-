import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

function loadEnvFile(): void {
  const envPath = new URL("../.env", import.meta.url);
  const filePath = fileURLToPath(envPath);
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const sep = trimmed.indexOf("=");
    if (sep === -1) continue;
    const key = trimmed.slice(0, sep).trim();
    const val = trimmed.slice(sep + 1).trim();
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}
loadEnvFile();

/**
 * pipeline/model_client.ts — 统一的 LLM 调用客户端
 *
 * 支持 DeepSeek / Qwen / OpenAI 三种模型提供商。
 * 使用 Node.js 原生 fetch 调用 OpenAI 兼容 API（无需专用 SDK）。
 */

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** Token 用量统计 */
export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** LLM 调用返回值：包含回复内容和用量统计 */
export interface LLMResponse {
  content: string;
  usage: LLMUsage;
}

/** 调用时可选的参数：模型、温度、最大 Token 数 */
export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

/** 聊天消息结构，符合 OpenAI API 格式 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── Provider 抽象接口 ────────────────────────────────────────────────────────

/** 所有 LLM 提供商必须实现的标准方法 */
export interface LLMProvider {
  /** 提供商名称：deepseek / qwen / openai */
  readonly providerName: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
  estimateCost(usage: LLMUsage): number;
}

// ── 价格表（每 1K tokens，美元） ─────────────────────────────────────────────

interface PriceEntry {
  inputPer1K: number;   // 输入 Token 单价
  outputPer1K: number;  // 输出 Token 单价
}

/** 常用模型价格表，数据来源于各厂商官网公开定价 */
const PRICE_TABLE: Record<string, PriceEntry> = {
  "deepseek-chat":  { inputPer1K: 0.0005, outputPer1K: 0.002 },
  "qwen-turbo":     { inputPer1K: 0.0003, outputPer1K: 0.0006 },
  "qwen-plus":      { inputPer1K: 0.0008, outputPer1K: 0.002 },
  "gpt-3.5-turbo":  { inputPer1K: 0.0015, outputPer1K: 0.002 },
  "gpt-4o-mini":    { inputPer1K: 0.00015, outputPer1K: 0.0006 },
  "gpt-4o":         { inputPer1K: 0.0025, outputPer1K: 0.01 },
  "gpt-4":          { inputPer1K: 0.03, outputPer1K: 0.06 },
};

// ── 国产模型价格表（元 / 百万 tokens）─────────────────────────────────────────

/** 单价结构：输入 + 输出，单位 元/百万tokens */
interface CnPriceEntry {
  input: number;
  output: number;
}

/** 国产模型 RMB 价格表 */
const CN_PRICE_TABLE: Record<string, CnPriceEntry> = {
  deepseek: { input: 1, output: 2 },
  qwen: { input: 4, output: 12 },
  openai: { input: 150, output: 600 },
};

// ── CostTracker ───────────────────────────────────────────────────────────────

/** 单次 API 调用的成本记录 */
interface CostRecord {
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costYuan: number;
}

/**
 * LLM 调用成本追踪器
 *
 * 记录每次 API 调用的 token 消耗，按国产模型价格（元/百万 tokens）计算成本，
 * 支持按提供商查询估算成本和输出汇总报告。
 */
export class CostTracker {
  /** 所有调用记录 */
  private records: CostRecord[] = [];

  /**
   * 记录一次 API 调用
   *
   * @param usage - token 用量统计（promptTokens / completionTokens）
   * @param provider - 提供商名称：deepseek / qwen / openai
   */
  record(usage: LLMUsage, provider: string): void {
    const price = CN_PRICE_TABLE[provider];
    if (!price) return;

    const promptCost = (usage.promptTokens / 1_000_000) * price.input;
    const completionCost = (usage.completionTokens / 1_000_000) * price.output;
    const costYuan = parseFloat((promptCost + completionCost).toFixed(6));

    this.records.push({
      provider,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costYuan,
    });
  }

  /**
   * 返回指定提供商的累计估算成本（元）
   *
   * @param provider - 提供商名称，不传则返回全部提供商的总和
   */
  estimatedCost(provider?: string): number {
    const filtered = provider
      ? this.records.filter((r) => r.provider === provider)
      : this.records;
    return parseFloat(
      filtered.reduce((sum, r) => sum + r.costYuan, 0).toFixed(6),
    );
  }

  /**
   * 打印成本报告
   *
   * @param provider - 可选，指定则仅输出该提供商的报告
   */
  report(provider?: string): void {
    const filtered = provider
      ? this.records.filter((r) => r.provider === provider)
      : this.records;

    if (filtered.length === 0) {
      console.log(`[CostTracker] 无 ${provider ?? "任何"} 调用记录`);
      return;
    }

    const border = "═".repeat(56);
    console.log(`\n${border}`);
    console.log("  CostTracker 成本报告");
    console.log(border);

    // 按提供商分组统计
    const groups = new Map<string, CostRecord[]>();
    for (const r of filtered) {
      const list = groups.get(r.provider) ?? [];
      list.push(r);
      groups.set(r.provider, list);
    }

    let grandTotal = 0;
    let grandPrompt = 0;
    let grandCompletion = 0;

    for (const [name, recs] of groups) {
      const calls = recs.length;
      const promptSum = recs.reduce((s, r) => s + r.promptTokens, 0);
      const completionSum = recs.reduce((s, r) => s + r.completionTokens, 0);
      const cost = recs.reduce((s, r) => s + r.costYuan, 0);

      console.log(`  ${name.padEnd(12)} ${calls.toString().padStart(3)} 次调用`);
      console.log(`    Token:  输入 ${promptSum.toLocaleString()} | 输出 ${completionSum.toLocaleString()} | 合计 ${(promptSum + completionSum).toLocaleString()}`);
      console.log(`    费用:   ¥ ${cost.toFixed(4)}`);

      grandTotal += cost;
      grandPrompt += promptSum;
      grandCompletion += completionSum;
    }

    if (groups.size > 1) {
      console.log(`  ${"─".repeat(54)}`);
      console.log(`  合计:  ${groups.size} 个提供商, ¥ ${grandTotal.toFixed(4)}`);
      console.log(`  Token: 输入 ${grandPrompt.toLocaleString()} | 输出 ${grandCompletion.toLocaleString()}`);
    }

    console.log(`${border}\n`);
  }
}

/** 全局单例 tracker，供 chatWithRetry 和 pipeline 使用 */
export const globalTracker = new CostTracker();

// ── 提供商映射 ───────────────────────────────────────────────────────────────

interface ProviderEndpoint {
  baseURL: string;
  model: string;  // 该提供商的默认模型
}

/** 提供商名称 → 接入点 + 默认模型 */
const PROVIDER_MAP: Record<string, ProviderEndpoint> = {
  deepseek: {
    baseURL: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  qwen: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
  },
};

/** 提供商名称 → 环境变量名 */
const API_KEY_MAP: Record<string, string> = {
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "QWEN_API_KEY",
  openai: "OPENAI_API_KEY",
};

// ── OpenAICompatibleProvider ─────────────────────────────────────────────────

/**
 * OpenAI 兼容 API 的统一实现
 * 适用于 DeepSeek / Qwen / OpenAI 等所有兼容 OpenAI 格式的提供商
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private baseURL: string;
  private apiKey: string;
  private model: string;

  /** 提供商名称：deepseek / qwen / openai */
  readonly providerName: string;

  constructor(config: { baseURL: string; apiKey: string; model: string; providerName: string }) {
    // 去掉末尾斜杠，避免拼接 URL 时重复
    this.baseURL = config.baseURL.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.providerName = config.providerName;
  }

  /** 返回当前默认模型名称 */
  getModel(): string {
    return this.model;
  }

  /**
   * 发送聊天请求
   * 使用 AbortController 实现 60 秒超时
   */
  async chat(
    messages: ChatMessage[],
    options?: ChatOptions,
  ): Promise<LLMResponse> {
    const model = options?.model ?? this.model;
    const temperature = options?.temperature ?? 0.7;
    const maxTokens = options?.maxTokens ?? 2048;

    // 60 秒超时控制
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    try {
      const res = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
        signal: controller.signal,
      });

      // 非 2xx 响应统一抛出，由重试机制决定是否重试
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`API ${res.status}: ${body}`);
      }

      const json: any = await res.json();

      // 从 OpenAI 兼容响应中提取内容和用量
      const content: string = json.choices?.[0]?.message?.content ?? "";
      const usage: LLMUsage = {
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        totalTokens: json.usage?.total_tokens ?? 0,
      };

      // 成功后记录 token 消耗
      if (usage) {
        globalTracker.record(usage, this.providerName);
      }

      return { content, usage };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * 估算本次调用的费用（美元）
   * 基于预设的价格表和实际 Token 消耗计算
   */
  estimateCost(usage: LLMUsage): number {
    const price = PRICE_TABLE[this.model] ?? { inputPer1K: 0, outputPer1K: 0 };
    const inputCost = (usage.promptTokens / 1000) * price.inputPer1K;
    const outputCost = (usage.completionTokens / 1000) * price.outputPer1K;
    return parseFloat((inputCost + outputCost).toFixed(6));
  }
}

// ── 重试判断 ─────────────────────────────────────────────────────────────────

/** 判断错误是否可重试：网络错误、超时、5xx、429 限流 */
function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    // fetch 的网络错误（TypeError）或 AbortController 超时
    if (err.name === "TypeError" || err.name === "AbortError") return true;
    // 服务端错误（5xx）和限流（429）
    if (/^API (5\d{2}|429)/.test(err.message)) return true;
  }
  return false;
}

// ── 带重试的聊天函数 ─────────────────────────────────────────────────────────

/**
 * 带指数退避重试的聊天调用
 * 最多重试 3 次，退避间隔依次为 1s / 2s / 4s
 * 仅对可重试错误（网络错误 / 5xx / 429）进行重试
 */
export async function chatWithRetry(
  provider: LLMProvider,
  messages: ChatMessage[],
  options?: ChatOptions & { maxRetries?: number },
): Promise<LLMResponse> {
  const maxRetries = options?.maxRetries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await provider.chat(messages, options);
    } catch (err) {
      lastError = err;
      // 还有重试次数且错误可重试时，等待后继续
      if (attempt < maxRetries && isRetryable(err)) {
        const delay = Math.pow(2, attempt) * 1000; // 指数退避：1, 2, 4 秒
        await new Promise((r) => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

// ── Token 估算和成本计算 ─────────────────────────────────────────────────────

/**
 * 粗略估算文本对应的 Token 数量
 * 中文字符 ≈ 1.5 token，英文/其他字符 ≈ 0.25 token
 * 用于调用前预估费用，非精确值
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      tokens += 1.5;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * 根据模型和 Token 用量计算费用（美元）
 * 使用 PRICE_TABLE 中的定价
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = PRICE_TABLE[model];
  if (!price) return 0;
  const inputCost = (promptTokens / 1000) * price.inputPer1K;
  const outputCost = (completionTokens / 1000) * price.outputPer1K;
  return parseFloat((inputCost + outputCost).toFixed(6));
}

// ── 工厂函数 ─────────────────────────────────────────────────────────────────

/**
 * 根据环境变量或参数创建对应的 Provider 实例
 * 优先使用传入的 providerName，否则读取 LLM_PROVIDER 环境变量，默认 deepseek
 * 读取对应的 API_KEY 环境变量作为鉴权凭证
 */
export function createProvider(providerName?: string): OpenAICompatibleProvider {
  const name = (
    providerName ?? process.env.LLM_PROVIDER ?? "deepseek"
  ).toLowerCase();
  const endpoint = PROVIDER_MAP[name];
  if (!endpoint) {
    throw new Error(
      `未知的 LLM_PROVIDER: "${name}"，可用选项: ${Object.keys(PROVIDER_MAP).join(", ")}`,
    );
  }

  const envKey = API_KEY_MAP[name];
  const apiKey = process.env[envKey];
  if (!apiKey) {
    throw new Error(`缺少环境变量 ${envKey}`);
  }

  return new OpenAICompatibleProvider({
    baseURL: endpoint.baseURL,
    apiKey,
    model: endpoint.model,
    providerName: name,
  });
}

// ── quickChat 便捷函数 ───────────────────────────────────────────────────────

/**
 * 一句话调用 LLM 的便捷函数
 * 自动从环境变量读取配置，支持自定义 systemPrompt 和模型参数
 *
 * @param prompt - 用户输入的提示词
 * @param options - 可选：model / temperature / maxTokens / systemPrompt
 * @returns LLM 的文本回复
 */
export async function quickChat(
  prompt: string,
  options?: ChatOptions & { systemPrompt?: string },
): Promise<string> {
  const provider = createProvider();
  const messages: ChatMessage[] = [];

  if (options?.systemPrompt) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  messages.push({ role: "user", content: prompt });

  const response = await chatWithRetry(provider, messages, options);
  return response.content;
}

export { PRICE_TABLE };
export type { PriceEntry };

// ── 自测代码 ─────────────────────────────────────────────────────────────────

/** 直接运行此文件时执行自测 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const providerName = process.env.LLM_PROVIDER ?? "deepseek";
  const apiKeyEnv = API_KEY_MAP[providerName] ?? "DEEPSEEK_API_KEY";

  console.log("=== LLM 客户端测试 ===");
  console.log(`提供商: ${providerName}`);

  if (!process.env[apiKeyEnv]) {
    // 无 API Key：用模拟数据展示完整流程
    const model = PROVIDER_MAP[providerName]?.model ?? "deepseek-chat";
    const mockUsage: LLMUsage = { promptTokens: 42, completionTokens: 38, totalTokens: 80 };
    const cost = calculateCost(model, mockUsage.promptTokens, mockUsage.completionTokens);
    console.log(`INFO: 创建 LLM 客户端: provider=${providerName}, model=${model}`);
    console.log(`INFO: Token 用量: ${mockUsage.promptTokens} (prompt) + ${mockUsage.completionTokens} (completion) = ${mockUsage.totalTokens}, 估算成本: $${cost}`);

    const mockContent = "AI Agent 是一种能够自主感知环境、做出决策并采取行动的智能系统。"
      + "它通常基于大语言模型构建，通过工具调用与环境交互，"
      + "能够拆解复杂任务并逐步执行。";
    console.log(`\n回复: ${mockContent}`);
    console.log(`\n提示: 设置 ${apiKeyEnv} 环境变量后可发起真实调用。`);
    process.exit(0);
  }

  const provider = createProvider();
  console.log(`INFO: 创建 LLM 客户端: provider=${providerName}, model=${provider.getModel()}`);

  const messages: ChatMessage[] = [
    { role: "user", content: "用一句话解释什么是 AI Agent" },
  ];

  try {
    const response = await chatWithRetry(provider, messages);
    const cost = calculateCost(
      provider.getModel(),
      response.usage.promptTokens,
      response.usage.completionTokens,
    );
    console.log(
      `INFO: Token 用量: ${response.usage.promptTokens} (prompt) + ${response.usage.completionTokens} (completion) = ${response.usage.totalTokens}, 估算成本: $${cost}`,
    );
    console.log(`\n回复: ${response.content}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`ERROR: ${msg}`);
  }
}
