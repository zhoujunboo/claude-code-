/**
 * workflows/reviser.ts — 修正节点（根据 review_feedback 修正 analyses）
 *
 * 将 Reviewer 的反馈注入 prompt，让 LLM 对每条 analysis 做定向改进。
 * temperature=0.4 允许创造性改写但不过度发散。
 *
 * @test
 *   npx tsx workflows/reviser.ts
 *
 * @usage
 *   import { reviseNode } from "./workflows/reviser.js";
 */

import {
  chatJSON,
  BudgetExceededError,
  type LLMUsage,
} from "../pipeline/model_client.js";
import type { KBState, AnalysisItem, CostTracker } from "./state.js";

// ============================================================================
// 类型别名 & 常量
// ============================================================================

type Usage = LLMUsage;

const REVISE_TEMPERATURE = 0.4;

const REVISE_PROMPT = `你是一个知识库内容编辑。根据审核反馈，逐条改进以下分析条目。
保持条目顺序不变，返回一个 JSON 数组（不要加 markdown）：

[
  {
    "summary": "改进后的中文摘要(20-80字，突出技术价值)",
    "score": <1-10 整数>,
    "tags": ["标签1", "标签2"]
  },
  ...
]

审核反馈：`;

// ============================================================================
// 工具函数
// ============================================================================

function accumulateUsage(tracker: CostTracker, usage: LLMUsage): void {
  tracker.totalTokens = (tracker.totalTokens ?? 0) + usage.totalTokens;
}

function log(msg: string): void {
  console.log(`  ${msg}`);
}

// ============================================================================
// reviseNode
// ============================================================================

export async function reviseNode(state: KBState): Promise<Partial<KBState>> {
  const { analyses, review_feedback, cost_tracker } = state;

  if (!analyses || analyses.length === 0) {
    log("无 analyses，跳过修正");
    return {};
  }

  if (!review_feedback || review_feedback.trim().length === 0) {
    log("无 review_feedback，跳过修正");
    return {};
  }

  const round = state.iteration ?? 0;
  console.log(`[reviseNode] 根据反馈修正 ${analyses.length} 条 analyses (第 ${round} 轮修正)...`);
  log(`反馈: ${review_feedback.slice(0, 100)}${review_feedback.length > 100 ? "..." : ""}`);

  const tracker: CostTracker = { ...cost_tracker };

  // 构建条目列表
  const itemsList = analyses
    .map(
      (a, i) =>
        `${i + 1}. 摘要: ${a.summary}\n   tags: ${(a.tags ?? []).join(", ")}\n   score: ${a.score}`,
    )
    .join("\n\n");

  const prompt = `${REVISE_PROMPT}${review_feedback}\n\n当前条目:\n${itemsList}`;

  try {
    const { json, usage } = await chatJSON<unknown[]>(prompt, undefined, "reviser", {
      temperature: REVISE_TEMPERATURE,
    });
    accumulateUsage(tracker, usage);

    if (!Array.isArray(json)) {
      log("模型未返回数组，保持原 analyses");
      return { cost_tracker: tracker };
    }

    const improved: AnalysisItem[] = json.map((item: unknown, i: number) => {
      const obj = item as Record<string, unknown>;
      const original = analyses[i];
      return {
        summary: typeof obj.summary === "string"
          ? obj.summary.slice(0, 200)
          : (original?.summary ?? ""),
        score: typeof obj.score === "number"
          ? Math.max(1, Math.min(10, Math.round(obj.score)))
          : (original?.score ?? 5),
        tags: Array.isArray(obj.tags)
          ? obj.tags.map(String)
          : (original?.tags ?? []),
      };
    });

    log(`修正完成: ${improved.length} 条`);
    return { analyses: improved, cost_tracker: tracker };
  } catch (err: unknown) {
    if (err instanceof BudgetExceededError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    log(`修正失败: ${msg}，保持原 analyses`);
    return { cost_tracker: tracker };
  }
}

// ============================================================================
// CLI 入口
// ============================================================================

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockAnalyses: AnalysisItem[] = [
    {
      summary: "基于LangChain的AI Agent框架",
      score: 8,
      tags: ["AI Agent", "LangChain"],
    },
    {
      summary: "前端UI组件库",
      score: 5,
      tags: ["React", "UI"],
    },
  ];

  const mockFeedback = "摘要信息量不足，请补充技术细节；评分偏高请重新评估；标签需更精确匹配AI领域。";

  const state: KBState = {
    sources: [],
    analyses: mockAnalyses,
    articles: [],
    review_feedback: mockFeedback,
    review_passed: false,
    iteration: 1,
    cost_tracker: {},
  };

  console.log("=== Reviser 独立测试 ===\n");
  console.log("修正前:");
  mockAnalyses.forEach((a, i) => console.log(`  ${i + 1}. [${a.score}] ${a.summary} | ${a.tags.join(", ")}`));

  reviseNode(state)
    .then((result) => {
      console.log("\n=== 结果 ===");
      if (result.analyses) {
        console.log("修正后:");
        result.analyses.forEach((a, i) =>
          console.log(`  ${i + 1}. [${a.score}] ${a.summary} | ${a.tags.join(", ")}`),
        );
      } else {
        console.log("(无修改)");
      }
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
