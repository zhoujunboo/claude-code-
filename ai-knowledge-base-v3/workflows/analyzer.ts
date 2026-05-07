/**
 * workflows/analyzer.ts — LLM 分析节点
 *
 * 对每条采集数据调用 LLM 生成中文摘要、评分和标签。
 *
 * @test
 *   npx tsx workflows/analyzer.ts
 *
 * @usage
 *   import { analyzeNode } from "./workflows/analyzer.js";
 */

import {
  chatWithRetry,
  createProvider,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../pipeline/model_client.js";
import type { KBState, SourceItem, AnalysisItem, CostTracker } from "./state.js";

// ============================================================================
// 类型别名 & 常量
// ============================================================================

type Usage = LLMUsage;

const ANALYZE_PROMPT = `你是一个知识库分析助手。分析以下项目信息，返回 JSON（不要加 markdown）：

{
  "summary": "中文摘要(20-80字，突出技术价值)",
  "score": <1-10 整数>,
  "tags": ["标签1", "标签2"]
}`;

// ============================================================================
// LLM 调用封装
// ============================================================================

async function chat(
  prompt: string,
  system?: string,
  opts?: ChatOptions,
): Promise<{ content: string; usage: Usage }> {
  const provider = createProvider();
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  return chatWithRetry(provider, messages, opts);
}

async function chatJSON(
  prompt: string,
  system?: string,
  opts?: ChatOptions,
): Promise<{ json: Record<string, unknown>; usage: Usage }> {
  const { content, usage } = await chat(prompt, system, opts);
  const cleaned = content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return { json: JSON.parse(cleaned), usage };
}

function accumulateUsage(tracker: CostTracker, usage: Usage): void {
  tracker.totalTokens = (tracker.totalTokens ?? 0) + usage.totalTokens;
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

// ============================================================================
// analyzeNode
// ============================================================================

export async function analyzeNode(state: KBState): Promise<Partial<KBState>> {
  const { sources, cost_tracker } = state;
  console.log(`[analyzeNode] 分析 ${sources.length} 条数据...`);

  const analyses: AnalysisItem[] = [];
  const tracker: CostTracker = { ...cost_tracker };

  for (let i = 0; i < sources.length; i++) {
    const item = sources[i];
    const prompt = `${ANALYZE_PROMPT}\n名称: ${item.title}\n描述: ${item.summary}\n语言: ${item.language ?? "未知"}\n星标: ${item.stars ?? 0}`;

    try {
      const { json, usage } = await chatJSON(prompt);
      accumulateUsage(tracker, usage);

      analyses.push({
        summary: String(json.summary ?? item.summary).slice(0, 200),
        score: Math.max(1, Math.min(10, Math.round(Number(json.score)) || 5)),
        tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
      });

      log(`[${i + 1}/${sources.length}] ${item.title} → 评分 ${analyses[i].score}/10`);
    } catch {
      log(`[${i + 1}/${sources.length}] ${item.title} → 分析失败，使用兜底值`);
      analyses.push({ summary: item.summary, score: 5, tags: [] });
    }
  }

  log(`分析完成: ${analyses.length} 条`);
  return { analyses, cost_tracker: tracker };
}

// ============================================================================
// CLI 入口
// ============================================================================

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockSources: SourceItem[] = [
    {
      title: "langchain-ai/langchain",
      url: "https://github.com/langchain-ai/langchain",
      summary: "Building applications with LLMs through composability",
      source: "github",
      collectedAt: new Date().toISOString(),
      stars: 95000,
      language: "Python",
      topics: ["llm", "ai", "agent"],
    },
    {
      title: "microsoft/generative-ai-for-beginners",
      url: "https://github.com/microsoft/generative-ai-for-beginners",
      summary: "18 Lessons, Get Started Building with Generative AI",
      source: "github",
      collectedAt: new Date().toISOString(),
      stars: 68000,
      language: "Jupyter Notebook",
      topics: ["ai", "tutorial", "education"],
    },
  ];

  const state: KBState = {
    sources: mockSources,
    analyses: [],
    articles: [],
    review_feedback: "",
    review_passed: false,
    iteration: 0,
    cost_tracker: {},
  };

  console.log("=== Analyzer 独立测试 ===\n");
  analyzeNode(state)
    .then((result) => {
      console.log(`\n=== 完成: ${result.analyses?.length ?? 0} 条分析 ===`);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
