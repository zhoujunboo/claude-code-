/**
 * workflows/nodes.ts — LangGraph 工作流 5 个节点函数
 *
 * @usage
 *   import { collectNode, analyzeNode, organizeNode, reviewNode, saveNode } from "./workflows/nodes.js";
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chatWithRetry,
  createProvider,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../pipeline/model_client.js";
import type {
  KBState,
  SourceItem,
  AnalysisItem,
  ArticleItem,
  CostTracker,
} from "./state.js";

// ============================================================================
// 类型别名 & 常量
// ============================================================================

type Usage = LLMUsage;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLES_DIR = path.resolve(__dirname, "../knowledge/articles");
const INDEX_FILE = path.join(ARTICLES_DIR, "index.json");
const GITHUB_SEARCH = "https://api.github.com/search/repositories";

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

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function today(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

// ============================================================================
// 1. collectNode — 采集
// ============================================================================

export async function collectNode(state: KBState): Promise<Partial<KBState>> {
  console.log("[collectNode] 从 GitHub 采集 AI 相关仓库...");

  const params = new URLSearchParams({
    q: "ai agent",
    sort: "stars",
    order: "desc",
    per_page: "10",
  });
  const url = `${GITHUB_SEARCH}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "workflow-nodes",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log(`GitHub API ${res.status}: ${body.slice(0, 200)}`);
      return { sources: [] };
    }

    const data = (await res.json()) as {
      items?: {
        full_name: string;
        html_url: string;
        description: string | null;
        stargazers_count: number;
        language: string | null;
        topics: string[];
      }[];
    };

    const now = new Date().toISOString();
    const items: SourceItem[] = (data.items ?? []).map((r) => ({
      title: r.full_name,
      url: r.html_url,
      summary: (r.description ?? "").slice(0, 300),
      source: "github",
      collectedAt: now,
      stars: r.stargazers_count,
      language: r.language,
      topics: r.topics ?? [],
    }));

    log(`采集到 ${items.length} 条`);
    return { sources: items };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`采集失败: ${msg}`);
    return { sources: [] };
  }
}

// ============================================================================
// 2. analyzeNode — LLM 分析
// ============================================================================

const ANALYZE_PROMPT = `你是一个知识库分析助手。分析以下项目信息，返回 JSON（不要加 markdown）：

{
  "summary": "中文摘要(20-80字，突出技术价值)",
  "score": <1-10 整数>,
  "tags": ["标签1", "标签2"]
}`;

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
// 3. organizeNode — 过滤 + 去重 + LLM 修正
// ============================================================================

const FIXUP_PROMPT = `你是一个知识库编辑。以下条目的摘要或标签存在问题。请根据反馈意见改进该条目的 summary 和 tags，返回 JSON：

{
  "summary": "改进后的中文摘要(20-80字)",
  "tags": ["改进后的标签"]
}

反馈意见：`;

export async function organizeNode(state: KBState): Promise<Partial<KBState>> {
  const { sources, analyses, review_feedback, iteration, cost_tracker } = state;
  console.log(`[organizeNode] 整理: ${analyses.length} 条分析 → 过滤 + 去重`);

  const tracker: CostTracker = { ...cost_tracker };
  const filtered = sources
    .map((src, i) => ({ src, analysis: analyses[i] }))
    .filter(({ analysis }) => analysis && analysis.score >= 6);

  log(`评分过滤: ${sources.length} → ${filtered.length} (阈值 ≥ 6/10)`);

  const seen = new Set<string>();
  const articles: ArticleItem[] = [];
  let seq = 0;

  for (const { src, analysis } of filtered) {
    const key = src.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    seq++;
    const id = `${today()}-${src.source}-${slugify(src.title)}`;
    articles.push({
      id,
      title: src.title,
      sourceUrl: src.url,
      summary: analysis.summary,
      tags: analysis.tags,
      status: "draft",
    });
  }

  log(`去重: ${filtered.length} → ${articles.length}`);

  // 有反馈时，用 LLM 定向修正
  const hasFeedback = (iteration ?? 0) > 0 && (review_feedback ?? "").length > 0;

  if (hasFeedback) {
    console.log(`[organizeNode] 检测到审核反馈，使用 LLM 定向修正...`);

    for (let i = 0; i < articles.length; i++) {
      const art = articles[i];
      const userPrompt = `条目：\n标题: ${art.title}\n当前摘要: ${art.summary}\n当前标签: ${art.tags.join(", ")}\n\n${FIXUP_PROMPT}\n${review_feedback}`;

      try {
        const { json, usage } = await chatJSON(userPrompt);
        accumulateUsage(tracker, usage);

        if (typeof json.summary === "string") art.summary = json.summary.slice(0, 200);
        if (Array.isArray(json.tags)) art.tags = json.tags.map(String);

        log(`  修正 [${i + 1}/${articles.length}] ${art.title}`);
      } catch {
        log(`  修正失败 [${i + 1}/${articles.length}] ${art.title}，保持原样`);
      }
    }
  }

  const finalCount = articles.length;
  log(`整理完成: ${finalCount} 条${hasFeedback ? " (已根据反馈修正)" : ""}`);
  return { articles, cost_tracker: tracker };
}

// ============================================================================
// 4. reviewNode — 审核
// ============================================================================

const REVIEW_PROMPT = `你是一个知识库质量审核员。审查以下知识条目列表，从四个维度评分(1-10)，输出 JSON（不要加 markdown）：

{
  "scores": {
    "summary_quality": <摘要质量: 是否简洁准确、突出技术价值>,
    "tag_accuracy": <标签准确: 标签是否匹配内容、是否有遗漏>,
    "category_reasonability": <分类合理: 标签组合是否合理、无冲突>,
    "consistency": <一致性: 各条目间格式和风格是否统一>
  },
  "overall_score": <综合分 = 四维度平均，取整>,
  "passed": true或false,
  "feedback": "改进建议(中文,2-4句话)"
}

规则：overall_score >= 7 → passed: true`;

export async function reviewNode(state: KBState): Promise<Partial<KBState>> {
  const { articles, iteration } = state;
  const currentIteration = iteration ?? 0;
  const round = currentIteration + 1;
  console.log(`[reviewNode] 审核 ${articles.length} 条知识条目 (第 ${round} 轮)`);

  // 已经审核过 2 次仍未通过 → 强制通过
  if (currentIteration >= 2) {
    console.log(`[reviewNode] 已达 ${currentIteration} 轮审核，强制通过`);
    return {
      review_passed: true,
      review_feedback: "",
      iteration: currentIteration,
    };
  }

  const list = articles
    .map((a, i) => `${i + 1}. [${a.id}] ${a.title}\n   标签: ${a.tags.join(", ")}\n   摘要: ${a.summary}`)
    .join("\n\n");

  try {
    const { json } = await chatJSON(`${REVIEW_PROMPT}\n\n知识条目:\n${list}`);
    const passed = json.passed === true || json.passed === "true";
    const overallScore = Math.round(Number(json.overall_score)) || 5;
    const feedback = String(json.feedback ?? "");
    const scores = json.scores as Record<string, number> | undefined;

    if (scores) {
      log(`四维评分: 摘要${scores.summary_quality ?? "?"}/标签${scores.tag_accuracy ?? "?"}/分类${scores.category_reasonability ?? "?"}/一致${scores.consistency ?? "?"}`);
    }
    log(`综合 ${overallScore}/10 → ${passed ? "✅ 通过" : "❌ 不通过"}`);
    if (feedback) log(`反馈: ${feedback}`);

    return {
      review_passed: passed,
      review_feedback: passed ? "" : feedback,
      iteration: currentIteration + 1,
    };
  } catch {
    log("审核调用失败，默认通过");
    return {
      review_passed: true,
      review_feedback: "",
      iteration: currentIteration + 1,
    };
  }
}

// ============================================================================
// 5. saveNode — 保存
// ============================================================================

export async function saveNode(state: KBState): Promise<Partial<KBState>> {
  const { articles } = state;
  console.log(`[saveNode] 保存 ${articles.length} 条知识条目...`);

  try {
    if (!existsSync(ARTICLES_DIR)) {
      await mkdir(ARTICLES_DIR, { recursive: true });
    }

    let totalSize = 0;

    for (const art of articles) {
      const file = path.join(ARTICLES_DIR, `${art.id}.json`);
      const json = JSON.stringify(art, null, 2);
      await writeFile(file, json, "utf-8");
      totalSize += json.length;
      log(`  → ${art.id}`);
    }

    // 更新 index.json
    const indexData = articles.map((a) => ({
      id: a.id,
      title: a.title,
      sourceUrl: a.sourceUrl,
      tags: a.tags,
      status: a.status,
    }));
    await writeFile(INDEX_FILE, JSON.stringify(indexData, null, 2), "utf-8");
    log(`  → index.json (${articles.length} 条)`);

    log(`保存完成: ${(totalSize / 1024).toFixed(1)} KB → ${ARTICLES_DIR}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`保存失败: ${msg}`);
  }

  return {};
}
