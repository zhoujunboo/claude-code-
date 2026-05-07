/**
 * workflows/reviewer.ts — 审核节点（独立于 graph.ts，审核 state.analyses）
 *
 * 5 维度加权评分，代码重算总分，不信任模型算术。
 * 仅审核前 5 条 analyses（控 token 消耗）。
 *
 * @test
 *   npx tsx workflows/reviewer.ts
 *
 * @usage
 *   import { reviewNode } from "./workflows/reviewer.js";
 */

import {
  chatWithRetry,
  createProvider,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../pipeline/model_client.js";
import type { KBState, AnalysisItem, CostTracker, Plan } from "./state.js";

// ============================================================================
// 类型别名 & 常量
// ============================================================================

type Usage = LLMUsage;

const DIMENSION_WEIGHTS: Record<string, number> = {
  summary_quality: 0.25,
  technical_depth: 0.25,
  relevance: 0.20,
  originality: 0.15,
  formatting: 0.15,
};

const MAX_REVIEW_COUNT = 5;

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
// Review Prompt
// ============================================================================

const REVIEW_PROMPT = `你是一个严格的知识库审核员。审查以下分析条目列表，从五个维度严格评分(1-10)，输出 JSON（不要加 markdown）：

{
  "scores": {
    "summary_quality": <摘要质量: 是否简洁准确、突出技术价值>,
    "technical_depth": <技术深度: 是否体现技术洞察和深层理解>,
    "relevance": <相关性: 与AI/LLM/Agent领域的关联程度>,
    "originality": <原创性: 内容是否有独特视角或创新点>,
    "formatting": <格式规范: 摘要长度(20-80字)、标签是否规范>
  },
  "feedback": "改进建议(中文,2-4句话)"
}`;

// ============================================================================
// reviewNode
// ============================================================================

export async function reviewNode(state: KBState): Promise<Partial<KBState>> {
  const { analyses, iteration, cost_tracker } = state;
  const plan: Plan = state.plan ?? {
    tier: "standard",
    perSourceLimit: 10,
    relevanceThreshold: 0.5,
    maxIterations: 3,
    rationale: "",
  };
  const maxIter = plan.maxIterations ?? 3;
  const currentIteration = iteration ?? 0;
  const round = currentIteration + 1;
  const reviewCount = Math.min(analyses.length, MAX_REVIEW_COUNT);

  console.log(`[reviewNode] 审核 ${reviewCount}/${analyses.length} 条分析 (第 ${round} 轮)`);

  const tracker: CostTracker = { ...cost_tracker };

  // 无数据 → 直接通过
  if (reviewCount === 0) {
    log("无分析数据，直接通过");
    return { review_passed: true, review_feedback: "", iteration: currentIteration + 1, cost_tracker: tracker };
  }

  // 超过 plan.maxIterations → 强制通过（内部兜底）
  if (currentIteration >= maxIter) {
    log(`已达 ${currentIteration} 轮审核 (maxIter=${maxIter})，强制通过`);
    return { review_passed: true, review_feedback: "", iteration: currentIteration + 1, cost_tracker: tracker };
  }

  // 构建待审核列表
  const list = analyses
    .slice(0, MAX_REVIEW_COUNT)
    .map(
      (a, i) =>
        `${i + 1}. 摘要: ${a.summary}\n   tags: ${(a.tags ?? []).join(", ")}\n   score: ${a.score}`,
    )
    .join("\n\n");

  let parsed: Record<string, unknown>;

  try {
    const { json, usage } = await chatJSON(
      `${REVIEW_PROMPT}\n\n分析条目:\n${list}`,
      "你是严格但公正的知识库质量审核员。给出具体、可操作的反馈。",
      { temperature: 0.1 },
    );
    accumulateUsage(tracker, usage);
    parsed = json;
  } catch {
    log("审核调用失败，默认通过");
    return { review_passed: true, review_feedback: "", iteration: currentIteration + 1, cost_tracker: tracker };
  }

  // 代码重算加权总分（不信任模型算术）
  const scores = parsed.scores as Record<string, number> | undefined;
  if (!scores || typeof scores !== "object") {
    log("模型未返回有效 scores，默认通过");
    return { review_passed: true, review_feedback: "", iteration: currentIteration + 1, cost_tracker: tracker };
  }

  let weightedTotal = 0;
  let dimensionCount = 0;

  for (const [dim, weight] of Object.entries(DIMENSION_WEIGHTS)) {
    const raw = scores[dim];
    const score = typeof raw === "number" ? Math.max(1, Math.min(10, raw)) : 5;
    weightedTotal += score * weight;
    dimensionCount++;
    log(`${dim}: ${score}/10 (权重 ${(weight * 100).toFixed(0)}%)`);
  }

  const finalScore = dimensionCount > 0 ? weightedTotal : 0;
  const passed = finalScore >= 7.0;
  const feedback = passed ? "" : String(parsed.feedback ?? "");

  log(`加权总分 ${finalScore.toFixed(2)}/10 → ${passed ? "✅ 通过" : "❌ 不通过"}`);
  if (feedback) log(`反馈: ${feedback}`);

  return {
    review_passed: passed,
    review_feedback: feedback,
    iteration: currentIteration + 1,
    cost_tracker: tracker,
  };
}

// ============================================================================
// CLI 入口
// ============================================================================

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockAnalyses: AnalysisItem[] = [
    {
      summary: "基于LangChain的AI Agent框架，支持多工具调用和记忆管理",
      score: 8,
      tags: ["AI Agent", "LangChain", "RAG"],
    },
    {
      summary: "开源大语言模型推理引擎，支持多种量化方案",
      score: 9,
      tags: ["LLM", "推理", "量化"],
    },
    {
      summary: "前端UI组件库，提供丰富的React组件",
      score: 6,
      tags: ["React", "UI", "组件"],
    },
    {
      summary: "基于深度学习的图像生成扩散模型",
      score: 7,
      tags: ["diffusion", "图像生成", "deep-learning"],
    },
    {
      summary: "云原生监控平台，支持多集群可观测性",
      score: 5,
      tags: ["云原生", "监控", "observability"],
    },
  ];

  const state: KBState = {
    sources: [],
    analyses: mockAnalyses,
    articles: [],
    review_feedback: "",
    review_passed: false,
    iteration: 0,
    cost_tracker: {},
  };

  console.log("=== Reviewer 独立测试 ===\n");
  reviewNode(state)
    .then((result) => {
      console.log("\n=== 结果 ===");
      console.log(`passed: ${result.review_passed}`);
      console.log(`feedback: ${result.review_feedback || "(无)"}`);
      console.log(`iteration: ${result.iteration}`);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
