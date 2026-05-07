/**
 * tests/eval_test.ts — AI 知识库评估测试
 *
 *   本地验证（不消耗 token）：npm test
 *   完整 Eval（消耗 token）：  npm run test:slow
 *
 * @dependency
 *   ../pipeline/model_client.js
 * 
 * npm test              # 本地验证（不消耗 token）11 passed, 2 skipped
 * npm run test:slow     # 完整 Eval（消耗 token）  13 passed
 * 
 */

import dotenv from "dotenv";
import { describe, test, expect } from "vitest";
import { createProvider, chatWithRetry } from "../pipeline/model_client.js";
import type { ChatMessage, LLMResponse } from "../pipeline/model_client.js";

dotenv.config();

// ============================================================================
// AnalysisResult — 分析输出结构
// ============================================================================

interface AnalysisResult {
  summary: string;
  keywords: string[];
  relevance: number; // 0-1
  filtered: boolean;
}

// ============================================================================
// analyze — 本地分析函数（不调用 LLM，纯启发式）
// ============================================================================

function analyze(input: string): AnalysisResult {
  const trimmed = input.trim();

  if (trimmed.length < 3) {
    return {
      summary: "",
      keywords: [],
      relevance: 0,
      filtered: true,
    };
  }

  const lower = trimmed.toLowerCase();
  const aiKeywords = ["ai", "llm", "agent", "prompt", "rag", "fine-tuning", "model", "gpu", "token", "embedding"];
  const matchedKeywords = aiKeywords.filter((kw) => lower.includes(kw));

  const irrelevantTerms = ["recipe", "weather", "sports", "celebrity", "gossip", "fashion"];
  const hasIrrelevant = irrelevantTerms.some((t) => lower.includes(t));

  const wordCount = trimmed.split(/\s+/).length;
  const charCount = trimmed.length;

  let relevance: number;
  if (hasIrrelevant) {
    relevance = Math.min(matchedKeywords.length * 0.1, 0.3);
  } else if (matchedKeywords.length === 0) {
    relevance = Math.min(charCount / 500, 0.4);
  } else {
    relevance = Math.min(0.4 + matchedKeywords.length * 0.15 + wordCount * 0.005, 1);
  }

  return {
    summary: trimmed.length > 200 ? trimmed.slice(0, 200) + "..." : trimmed,
    keywords: matchedKeywords.slice(0, 5),
    relevance: Math.round(relevance * 100) / 100,
    filtered: relevance < 0.3,
  };
}

// ============================================================================
// EVAL_CASES — 评估用例集
// ============================================================================

interface EvalCase {
  name: string;
  input: string;
  expected: {
    hasSummary?: (result: AnalysisResult) => boolean;
    hasKeywords?: (result: AnalysisResult) => boolean;
    minRelevance?: number;
    maxRelevance?: number;
    shouldNotCrash?: boolean;
    isFiltered?: boolean;
  };
}

const EVAL_CASES: EvalCase[] = [
  // ── 正面案例：技术文章输入 ──────────────────────────────────────────────────
  {
    name: "正面 — RAG 技术文章",
    input:
      "Retrieval-Augmented Generation (RAG) 是一种结合信息检索与大语言模型的技术架构。" +
      "通过将外部知识库嵌入向量化存储，LLM 在生成回答前先检索相关文档片段，" +
      "有效缓解了幻觉问题并提升了事实准确性。常见实现包括 LangChain、LlamaIndex 等框架。" +
      "Fine-tuning 可以作为 RAG 的补充，在特定领域进一步优化模型表现。",
    expected: {
      hasSummary: (r) => r.summary.length > 0,
      hasKeywords: (r) => r.keywords.length >= 2,
      minRelevance: 0.6,
    },
  },
  {
    name: "正面 — AI Agent 架构设计",
    input:
      "现代 AI Agent 系统通常由规划模块、记忆模块和工具调用模块组成。规划模块负责任务分解，" +
      "记忆模块维护短期和长期上下文，工具调用模块通过 Function Calling 与外部 API 交互。" +
      "Multi-Agent 架构允许多个专业 Agent 协作完成复杂任务，每个 Agent 专注于特定领域。" +
      "Token 预算管理是 Agent 系统的关键挑战之一。",
    expected: {
      hasSummary: (r) => r.summary.length > 0,
      hasKeywords: (r) => r.keywords.length >= 3,
      minRelevance: 0.7,
    },
  },
  // ── 负面案例：无关内容输入 ──────────────────────────────────────────────────
  {
    name: "负面 — 食谱内容",
    input:
      "今天分享一道红烧排骨的做法：准备排骨 500g，焯水去血沫。锅中放油，加入冰糖炒至焦糖色，" +
      "放入排骨翻炒上色，加入生抽、老抽、料酒，加水没过排骨，大火烧开后转小火炖 40 分钟。",
    expected: {
      maxRelevance: 0.4,
      isFiltered: true,
    },
  },
  {
    name: "负面 — 体育新闻",
    input:
      "NBA 季后赛最新战报：湖人队在加时赛中以 128:125 险胜勇士队，詹姆斯全场砍下 38 分 10 篮板 8 助攻，" +
      "戴维斯贡献 25 分 15 篮板。勇士方面库里得到 35 分但出现 7 次失误。",
    expected: {
      maxRelevance: 0.3,
      isFiltered: true,
    },
  },
  // ── 边界案例：极短 / 空输入 ────────────────────────────────────────────────
  {
    name: "边界 — 极短输入 'AI'",
    input: "AI",
    expected: {
      shouldNotCrash: true,
    },
  },
  {
    name: "边界 — 空字符串",
    input: "",
    expected: {
      shouldNotCrash: true,
      isFiltered: true,
    },
  },
];

// ============================================================================
// 测试 1：EVAL_CASES 结构本地验证（不调用 LLM）
// ============================================================================

describe("EVAL_CASES 结构验证", () => {
  test("至少包含 3 个用例", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(3);
  });

  test("每个用例包含 name, input, expected 字段", () => {
    for (const c of EVAL_CASES) {
      expect(c).toHaveProperty("name");
      expect(typeof c.name).toBe("string");
      expect(c).toHaveProperty("input");
      expect(typeof c.input).toBe("string");
      expect(c).toHaveProperty("expected");
      expect(typeof c.expected).toBe("object");
    }
  });

  test("正面案例存在", () => {
    const positive = EVAL_CASES.filter((c) => c.name.startsWith("正面"));
    expect(positive.length).toBeGreaterThanOrEqual(1);
  });

  test("负面案例存在", () => {
    const negative = EVAL_CASES.filter((c) => c.name.startsWith("负面"));
    expect(negative.length).toBeGreaterThanOrEqual(1);
  });

  test("边界案例存在", () => {
    const edge = EVAL_CASES.filter((c) => c.name.startsWith("边界"));
    expect(edge.length).toBeGreaterThanOrEqual(1);
  });

  test("analyze 函数可对所有用例运行且不崩溃", () => {
    for (const c of EVAL_CASES) {
      expect(() => analyze(c.input)).not.toThrow();
    }
  });
});

// ============================================================================
// 测试 2：本地分析函数验证
// ============================================================================

describe("analyze 本地分析函数", () => {
  test("正面案例 — 相关性足够高", () => {
    for (const c of EVAL_CASES.filter((x) => x.name.startsWith("正面"))) {
      const r = analyze(c.input);
      if (c.expected.hasSummary) {
        expect(c.expected.hasSummary(r)).toBe(true);
      }
      if (c.expected.hasKeywords) {
        expect(c.expected.hasKeywords(r)).toBe(true);
      }
      if (c.expected.minRelevance !== undefined) {
        expect(r.relevance).toBeGreaterThanOrEqual(c.expected.minRelevance);
      }
    }
  });

  test("负面案例 — 相关性足够低", () => {
    for (const c of EVAL_CASES.filter((x) => x.name.startsWith("负面"))) {
      const r = analyze(c.input);
      if (c.expected.maxRelevance !== undefined) {
        expect(r.relevance).toBeLessThanOrEqual(c.expected.maxRelevance);
      }
      if (c.expected.isFiltered) {
        expect(r.filtered).toBe(true);
      }
    }
  });

  test("边界案例 — 不崩溃", () => {
    for (const c of EVAL_CASES.filter((x) => x.name.startsWith("边界"))) {
      const r = analyze(c.input);
      if (c.expected.shouldNotCrash) {
        expect(r).toBeDefined();
      }
      if (c.expected.isFiltered) {
        expect(r.filtered).toBe(true);
      }
    }
  });

  test("摘要不为空时包含有意义内容", () => {
    const positive = EVAL_CASES.filter((x) => x.name.startsWith("正面"));
    for (const c of positive) {
      const r = analyze(c.input);
      if (r.summary.length > 0) {
        expect(r.summary.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  test("关键词数量合理", () => {
    for (const c of EVAL_CASES) {
      const r = analyze(c.input);
      expect(r.keywords.length).toBeGreaterThanOrEqual(0);
      expect(r.keywords.length).toBeLessThanOrEqual(5);
    }
  });
});

// ============================================================================
// 测试 3：LLM-as-Judge 打分（需 RUN_SLOW=1）
// ============================================================================

const runSlow = process.env.RUN_SLOW === "1";

async function chat(prompt: string, system?: string): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number } }> {
  const provider = createProvider();
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const res: LLMResponse = await chatWithRetry(provider, messages);
  return {
    content: res.content,
    usage: { promptTokens: res.usage.promptTokens, completionTokens: res.usage.completionTokens, totalTokens: res.usage.totalTokens },
  };
}

describe("LLM-as-Judge 评估", () => {
  test.runIf(runSlow)(
    "LLM 对分析结果打分 >= 5",
    async () => {
      const sample = EVAL_CASES.find((x) => x.name.startsWith("正面"))!;
      const result = analyze(sample.input);

      const judgePrompt = `你是一个 AI 知识库质量评审专家。请对以下分析结果按 1-10 打分（1=最差，10=完美），仅返回纯数字分数。

评价标准：
- 摘要是否准确概括原文主题
- 关键词是否与 AI/LLM 领域相关
- 相关性评分是否合理

原文：
${sample.input}

分析结果：
- 摘要: ${result.summary}
- 关键词: ${result.keywords.join(", ") || "(无)"}
- 相关性: ${result.relevance}
- 被过滤: ${result.filtered}

请仅返回数字分数（如 8）：`;

      const response = await chat(judgePrompt, "你是一个严格但公正的评审专家。只输出 1-10 的整数分数，不要解释。");
      const score = parseInt(response.content.trim().replace(/[^0-9]/g, ""), 10);

      console.log(`\n[LLM-as-Judge] 用例: ${sample.name}`);
      console.log(`  相关性: ${result.relevance}, 关键词: [${result.keywords.join(", ")}]`);
      console.log(`  LLM 评审分数: ${score}`);

      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(5);
      expect(score).toBeLessThanOrEqual(10);
    },
    30_000,
  );

  test.runIf(runSlow)(
    "LLM 对负面案例分析结果给出低分",
    async () => {
      const negativeCase = EVAL_CASES.find((x) => x.name.startsWith("负面"))!;
      const result = analyze(negativeCase.input);

      const judgePrompt = `你是一个 AI 知识库质量评审专家。以下是一个被标记为"非 AI 相关"的分析结果，请验证该判定是否正确并打分（1-10，1=判定完全错误，10=判定完全正确），仅返回纯数字分数。

原文：
${negativeCase.input}

分析结果：
- 摘要: ${result.summary}
- 关键词: ${result.keywords.join(", ") || "(无)"}
- 相关性: ${result.relevance}
- 被过滤: ${result.filtered}

请仅返回数字分数：`;

      const response = await chat(judgePrompt, "你是一个公正的评审专家。只输出 1-10 的整数分数，不要解释。");
      const score = parseInt(response.content.trim().replace(/[^0-9]/g, ""), 10);

      console.log(`\n[LLM-as-Judge] 负面用例: ${negativeCase.name}`);
      console.log(`  相关性: ${result.relevance}, 被过滤: ${result.filtered}`);
      console.log(`  LLM 评审分数: ${score}`);

      expect(Number.isFinite(score)).toBe(true);
      expect(score).toBeGreaterThanOrEqual(5);
    },
    30_000,
  );
});
