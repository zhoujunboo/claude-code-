/**
 * workflows/human_flag.ts — 人工介入节点（审核循环超过上限时的兜底）
 *
 * 超过 max_iterations 仍未通过 → 写入 knowledge/pending_review/ 独立目录，
 * 不污染主知识库，等待人工判断。
 *
 * @test
 *   npx tsx workflows/human_flag.ts
 *
 * @usage
 *   import { humanFlagNode } from "./workflows/human_flag.js";
 */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KBState } from "./state.js";

// ============================================================================
// 常量
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(__dirname);
const PENDING_DIR = path.join(PROJECT_ROOT, "knowledge", "pending_review");

// ============================================================================
// humanFlagNode
// ============================================================================

export async function humanFlagNode(
  state: KBState,
): Promise<Partial<KBState>> {
  const analyses = state.analyses ?? [];
  const iteration = state.iteration ?? 0;
  const feedback = state.review_feedback ?? "";

  console.log(`[HumanFlag] 达到 ${iteration} 次审核仍未通过`);
  console.log(`[HumanFlag] 最后反馈: ${feedback.slice(0, 200)}`);

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15);

  try {
    if (!existsSync(PENDING_DIR)) {
      await mkdir(PENDING_DIR, { recursive: true });
    }

    const filepath = path.join(PENDING_DIR, `pending-${timestamp}.json`);
    const payload = {
      timestamp: now.toISOString(),
      iterations_used: iteration,
      last_feedback: feedback,
      analyses,
    };

    await writeFile(filepath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`[HumanFlag] 已保存到 ${filepath}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[HumanFlag] 写入失败: ${msg}`);
  }

  return {};
}

// ============================================================================
// CLI 入口
// ============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mockState: KBState = {
    sources: [],
    analyses: [
      {
        summary: "一个基于Transformer的文本生成模型",
        score: 5,
        tags: ["NLP", "Transformer"],
      },
      {
        summary: "前端路由库",
        score: 3,
        tags: ["前端", "路由"],
      },
    ],
    articles: [],
    review_feedback:
      "摘要缺乏技术深度，标签不够精准，评分偏高与实际价值不匹配，建议重新评估各条目。",
    review_passed: false,
    iteration: 3,
    cost_tracker: {},
  };

  console.log("=== HumanFlag 独立测试 ===\n");
  humanFlagNode(mockState)
    .then(() => console.log("\n=== 完成 ==="))
    .catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
}
