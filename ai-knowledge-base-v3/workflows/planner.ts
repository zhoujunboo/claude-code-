/**
 * workflows/planner.ts — 策略规划节点
 *
 * 根据目标采集量返回三档策略（lite / standard / full），
 * 控制每轮采集条数、相关性阈值和最大迭代次数。
 *
 * @test
 *   npx tsx workflows/planner.ts
 *
 * @usage
 *   import { plannerNode, planStrategy } from "./workflows/planner.js";
 */

import type { KBState, Plan } from "./state.js";

// ============================================================================
// 策略表
// ============================================================================

const STRATEGIES = {
  lite: {
    perSourceLimit: 5,
    relevanceThreshold: 0.7,
    maxIterations: 1,
    rationale: "采集量小：严格过滤、快速出库，1 轮审核即可",
  },
  standard: {
    perSourceLimit: 10,
    relevanceThreshold: 0.5,
    maxIterations: 2,
    rationale: "中等采集量：平衡过滤与覆盖率，2 轮审核保质量",
  },
  full: {
    perSourceLimit: 20,
    relevanceThreshold: 0.4,
    maxIterations: 3,
    rationale: "大批量采集：宽松过滤、多轮修正兜底，3 轮审核保底",
  },
} as const satisfies Record<string, Plan>;

// ============================================================================
// planStrategy
// ============================================================================

export function planStrategy(targetCount?: number): Plan {
  const resolved =
    targetCount ??
    parseInt(process.env.PLANNER_TARGET_COUNT ?? "0", 10) ||
    10;

  let plan: Plan;

  if (resolved < 10) {
    plan = { ...STRATEGIES.lite, tier: "lite" };
  } else if (resolved < 20) {
    plan = { ...STRATEGIES.standard, tier: "standard" };
  } else {
    plan = { ...STRATEGIES.full, tier: "full" };
  }

  console.log(
    `[Planner] targetCount=${resolved} → tier=${plan.tier} ` +
      `(perSource=${plan.perSourceLimit}, threshold=${plan.relevanceThreshold}, maxIter=${plan.maxIterations})`,
  );
  console.log(`[Planner] 理由: ${plan.rationale}`);

  return plan;
}

// ============================================================================
// plannerNode
// ============================================================================

export async function plannerNode(
  state: KBState,
): Promise<Partial<KBState>> {
  const plan = planStrategy();
  return { plan } as Partial<KBState>;
}

// ============================================================================
// CLI 入口
// ============================================================================

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const testCases = [undefined, 5, 12, 25];

  console.log("=== Planner 独立测试 ===\n");

  for (const tc of testCases) {
    const label = tc === undefined ? "默认(env)" : `targetCount=${tc}`;
    console.log(`--- ${label} ---`);
    const plan = planStrategy(tc);
    console.log(`  tier: ${plan.tier}`);
    console.log(`  perSourceLimit: ${plan.perSourceLimit}`);
    console.log(`  relevanceThreshold: ${plan.relevanceThreshold}`);
    console.log(`  maxIterations: ${plan.maxIterations}`);
    console.log(`  rationale: ${plan.rationale}`);
    console.log();
  }
}
