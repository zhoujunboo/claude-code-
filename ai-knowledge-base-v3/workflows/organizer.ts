/**
 * workflows/organizer.ts — 整理入库节点
 *
 * 职责：将通过审核的 analyses 整理成标准知识条目并持久化到磁盘。
 *
 * 核心原则：只整理不审核（Organize, don't review）。
 * 它不评价质量，只负责格式转换和写盘。
 *
 * 步骤:
 *   1. 按 plan.relevanceThreshold 过滤低质条目
 *   2. URL 去重
 *   3. 格式化为标准 article 结构
 *   4. 写入 knowledge/articles/*.json
 *   5. 更新索引 index.json
 *
 * @test
 *   npx tsx workflows/organizer.ts
 *
 * @usage
 *   import { organizeNode } from "./workflows/organizer.js";
 */


/**
 * 为什么 sanitize 在入口 / filter 在出口
 * 入口（collect）做 sanitize。是因为 源头脏数据 进 LLM 才会污染所有下游。越早洗越省 token。
 * 出口（organize）做 filter，是因为 LLM 输出 永远不可信，即使 prompt 干净，模型也可能联想出真实邮箱（训练数据里见过），必须在 最后一道写盘前拦一次。
 * 
 */

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KBState, AnalysisItem, ArticleItem, CostTracker, Plan } from "./state.js";
import { filterOutput } from "../tests/security.js";

// ============================================================================
// 常量
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname);
const ARTICLES_DIR = path.join(PROJECT_ROOT, "knowledge", "articles");
const INDEX_FILE = path.join(ARTICLES_DIR, "index.json");

// ============================================================================
// organizeNode
// ============================================================================

export async function organizeNode(state: KBState): Promise<Partial<KBState>> {
  const analyses = state.analyses ?? [];
  const plan: Plan = state.plan ?? {
    tier: "standard",
    perSourceLimit: 10,
    relevanceThreshold: 0.5,
    maxIterations: 3,
    rationale: "",
  };
  const tracker: CostTracker = { ...state.cost_tracker };

  const threshold = plan.relevanceThreshold ?? 0.5;

  console.log(`[Organizer] 整理 ${analyses.length} 条 analyses (阈值 ≥ ${threshold})`);

  // Step 1: 相关性过滤（score 转 0-1 后比较）
  const qualified: AnalysisItem[] = [];
  for (const a of analyses) {
    const normalized = (a.score ?? 0) / 10;
    if (normalized >= threshold) {
      qualified.push(a);
    }
  }

  log(`  相关性过滤: ${analyses.length} → ${qualified.length}`);

  // Step 2: URL 去重
  const seen = new Set<string>();
  const unique: AnalysisItem[] = [];
  for (const item of qualified) {
    const url = (item as Record<string, unknown>).url as string | undefined;
    const key = url ?? item.summary;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  log(`  去重: ${qualified.length} → ${unique.length}`);

  // Step 3: 格式化为标准 article
  const today = new Date().toISOString().slice(0, 10);
  const articles: ArticleItem[] = unique.map((item, i) => {
    const raw = item as Record<string, unknown>;
    const { filtered: title, detections: tDet } = filterOutput((raw.title as string) ?? raw.summary ?? "");
    const { filtered: summary, detections: sDet } = filterOutput(item.summary);
    const { filtered: sourceUrl, detections: uDet } = filterOutput((raw.url as string) ?? "");
    if (tDet.length) log(`  [安全] title PII: ${tDet.join(", ")}`);
    if (sDet.length) log(`  [安全] summary PII: ${sDet.join(", ")}`);
    if (uDet.length) log(`  [安全] url PII: ${uDet.join(", ")}`);
    return {
      id: `${today}-${String(i + 1).padStart(3, "0")}`,
      title,
      sourceUrl,
      summary,
      tags: item.tags ?? [],
      status: "published" as const,
    };
  });

  console.log(`[Organizer] 整理出 ${articles.length} 条知识条目（准备入库）`);

  // Step 4 & 5: 写盘 + 更新索引
  await saveArticles(articles);

  return { articles, cost_tracker: tracker };
}

// ============================================================================
// 文件写入
// ============================================================================

async function saveArticles(articles: ArticleItem[]): Promise<void> {
  if (articles.length === 0) return;

  try {
    if (!existsSync(ARTICLES_DIR)) {
      await mkdir(ARTICLES_DIR, { recursive: true });
    }

    // Step 4: 逐条写入
    for (const article of articles) {
      const filepath = path.join(ARTICLES_DIR, `${article.id}.json`);
      await writeFile(filepath, JSON.stringify(article, null, 2), "utf-8");
    }

    // Step 5: 更新索引（追加新条目，不重复）
    let index: { id: string; title: string; tags: string[]; status: string }[] = [];
    if (existsSync(INDEX_FILE)) {
      const raw = await readFile(INDEX_FILE, "utf-8");
      index = JSON.parse(raw);
    }

    const existingIds = new Set(index.map((e) => e.id));
    for (const article of articles) {
      if (!existingIds.has(article.id)) {
        index.push({
          id: article.id,
          title: article.title,
          tags: article.tags,
          status: article.status,
        });
      }
    }

    await writeFile(INDEX_FILE, JSON.stringify(index, null, 2), "utf-8");

    log(`[Organizer] 已写入 ${articles.length} 篇到磁盘`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[Organizer] 写入失败: ${msg}`);
  }
}

// ============================================================================
// 工具函数
// ============================================================================

function log(msg: string): void {
  console.log(`  ${msg}`);
}

// ============================================================================
// CLI 入口
// ============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockState: KBState = {
    plan: {
      tier: "standard",
      perSourceLimit: 10,
      relevanceThreshold: 0.5,
      maxIterations: 2,
      rationale: "测试用",
    },
    sources: [],
    analyses: [
      {
        summary: "基于LangChain的AI Agent框架，支持多工具协作",
        score: 8,
        tags: ["AI Agent", "LangChain"],
      },
      {
        summary: "前端UI组件库（与AI无关）",
        score: 3,
        tags: ["React", "UI"],
      },
      {
        summary: "RAG检索增强生成的开源实现",
        score: 7,
        tags: ["RAG", "LLM"],
      },
    ],
    articles: [],
    review_feedback: "",
    review_passed: true,
    iteration: 1,
    cost_tracker: {},
  };

  console.log("=== Organizer 独立测试 ===\n");
  organizeNode(mockState)
    .then((result) => {
      console.log(`\n=== 完成: ${result.articles?.length ?? 0} 条入库 ===`);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
