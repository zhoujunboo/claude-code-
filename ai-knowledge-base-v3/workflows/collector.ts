/**
 * workflows/collector.ts — 采集节点
 *
 * 从 GitHub API 采集 AI 相关仓库，采集数量由 plan.perSourceLimit 控制。
 *
 * @test
 *   npx tsx workflows/collector.ts
 *
 * @usage
 *   import { collectNode } from "./workflows/collector.js";
 */

import type { KBState, SourceItem } from "./state.js";

// ============================================================================
// 常量
// ============================================================================

const GITHUB_SEARCH = "https://api.github.com/search/repositories";
const DEFAULT_PER_SOURCE_LIMIT = 10;

// ============================================================================
// collectNode
// ============================================================================

export async function collectNode(state: KBState): Promise<Partial<KBState>> {
  const plan = state.plan ?? {
    tier: "standard",
    perSourceLimit: DEFAULT_PER_SOURCE_LIMIT,
    relevanceThreshold: 0.5,
    maxIterations: 3,
    rationale: "",
  };
  const limit = plan.perSourceLimit ?? DEFAULT_PER_SOURCE_LIMIT;

  console.log(`[collectNode] 从 GitHub 采集 AI 相关仓库 (limit=${limit})...`);

  const params = new URLSearchParams({
    q: "ai agent",
    sort: "stars",
    order: "desc",
    per_page: String(limit),
  });
  const url = `${GITHUB_SEARCH}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "workflow-collector",
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
// 工具函数
// ============================================================================

function log(msg: string): void {
  console.log(`  ${msg}`);
}

// ============================================================================
// CLI 入口
// ============================================================================

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockState: KBState = {
    plan: {
      tier: "lite",
      perSourceLimit: 3,
      relevanceThreshold: 0.7,
      maxIterations: 1,
      rationale: "测试用",
    },
    sources: [],
    analyses: [],
    articles: [],
    review_feedback: "",
    review_passed: false,
    iteration: 0,
    cost_tracker: {},
  };

  console.log("=== Collector 独立测试 ===\n");
  console.log(`plan.perSourceLimit = ${mockState.plan?.perSourceLimit}`);
  collectNode(mockState)
    .then((result) => {
      console.log(`\n=== 完成: ${result.sources?.length ?? 0} 条 ===`);
    })
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
