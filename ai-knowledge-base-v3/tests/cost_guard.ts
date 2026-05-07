/**
 * tests/cost_guard.ts — 多 Agent 预算守卫
 *
 * 三重保护机制：
 *   1. 记录每次 LLM 调用的 token 用量和费用
 *   2. 接近预算时发出预警（warning）
 *   3. 超出预算时抛出 BudgetExceededError 阻断
 *
 * @test
 *   npx tsx tests/cost_guard.ts
 *
 * @usage
 *   import { CostGuard, BudgetExceededError } from "./tests/cost_guard.js";
 */

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// CostRecord — 单次 LLM 调用记录
// ============================================================================

export interface CostRecord {
  timestamp: string;
  nodeName: string;
  promptTokens: number;
  completionTokens: number;
  costYuan: number;
  model: string;
}

// ============================================================================
// BudgetExceededError — 自定义异常
// ============================================================================

export class BudgetExceededError extends Error {
  readonly totalCost: number;
  readonly budget: number;

  constructor(totalCost: number, budget: number) {
    const diff = (totalCost - budget).toFixed(4);
    super(`预算超限！累计费用 ¥${totalCost.toFixed(4)} 已超出预算 ¥${budget} (超出 ¥${diff})`);
    this.name = "BudgetExceededError";
    this.totalCost = totalCost;
    this.budget = budget;
  }
}

// ============================================================================
// CostGuard — 预算守卫
// ============================================================================

export class CostGuard {
  private records: CostRecord[] = [];
  private budgetYuan: number;
  private alertThreshold: number;
  private inputPricePerMillion: number;
  private outputPricePerMillion: number;

  /**
   * @param budgetYuan 预算上限（元），默认 1.0
   * @param alertThreshold 预警阈值比例，默认 0.8（即 80% 触发 warning）
   * @param inputPricePerMillion 输入 Token 单价（元/百万），默认 1.0
   * @param outputPricePerMillion 输出 Token 单价（元/百万），默认 2.0
   */
  constructor(
    budgetYuan = 1.0,
    alertThreshold = 0.8,
    inputPricePerMillion = 1.0,
    outputPricePerMillion = 2.0,
  ) {
    this.budgetYuan = budgetYuan;
    this.alertThreshold = alertThreshold;
    this.inputPricePerMillion = inputPricePerMillion;
    this.outputPricePerMillion = outputPricePerMillion;
  }

  // ── 价格计算 ──────────────────────────────────────────────────────────────

  private calcCost(promptTokens: number, completionTokens: number): number {
    const inputCost = (promptTokens / 1_000_000) * this.inputPricePerMillion;
    const outputCost = (completionTokens / 1_000_000) * this.outputPricePerMillion;
    return parseFloat((inputCost + outputCost).toFixed(6));
  }

  // ── record ────────────────────────────────────────────────────────────────

  /**
   * 记录一次 LLM 调用的 token 用量
   *
   * @param nodeName 调用来源节点名称（如 "analyzer", "reviewer"）
   * @param usage Token 用量 { promptTokens, completionTokens }
   * @param model 模型名称，可选
   */
  record(
    nodeName: string,
    usage: { promptTokens: number; completionTokens: number },
    model = "",
  ): void {
    const costYuan = this.calcCost(usage.promptTokens, usage.completionTokens);

    this.records.push({
      timestamp: new Date().toISOString(),
      nodeName,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costYuan,
      model: model || "unknown",
    });
  }

  // ── check ─────────────────────────────────────────────────────────────────

  /**
   * 检查预算状态，三重保护：
   *   - totalCost >= budget → 抛出 BudgetExceededError
   *   - totalCost >= budget * alertThreshold → 返回 status: "warning"
   *   - 其余 → 返回 status: "ok"
   *
   * @returns 预算状态报告，exceeded 时抛异常不返回
   */
  check(): {
    status: "ok" | "warning";
    totalCost: number;
    budget: number;
    usageRatio: number;
    message: string;
  } {
    const totalCost = this.getTotalCost();
    const usageRatio = parseFloat((totalCost / this.budgetYuan).toFixed(4));

    if (totalCost >= this.budgetYuan) {
      throw new BudgetExceededError(totalCost, this.budgetYuan);
    }

    if (usageRatio >= this.alertThreshold) {
      const remaining = this.budgetYuan - totalCost;
      return {
        status: "warning",
        totalCost,
        budget: this.budgetYuan,
        usageRatio,
        message: `预警：已使用 ¥${totalCost.toFixed(4)}，占比 ${(usageRatio * 100).toFixed(1)}%，剩余 ¥${remaining.toFixed(4)}`,
      };
    }

    return {
      status: "ok",
      totalCost,
      budget: this.budgetYuan,
      usageRatio,
      message: `正常：已使用 ¥${totalCost.toFixed(4)}，占比 ${(usageRatio * 100).toFixed(1)}%`,
    };
  }

  // ── getTotalCost ──────────────────────────────────────────────────────────

  getTotalCost(): number {
    return parseFloat(
      this.records.reduce((sum, r) => sum + r.costYuan, 0).toFixed(6),
    );
  }

  // ── getReport ─────────────────────────────────────────────────────────────

  /** 按节点分组统计的成本报告 */
  getReport(): object {
    const nodeGroups = new Map<string, CostRecord[]>();
    for (const r of this.records) {
      const list = nodeGroups.get(r.nodeName) ?? [];
      list.push(r);
      nodeGroups.set(r.nodeName, list);
    }

    const nodes = Array.from(nodeGroups.entries()).map(([name, recs]) => {
      const calls = recs.length;
      const promptTokens = recs.reduce((s, r) => s + r.promptTokens, 0);
      const completionTokens = recs.reduce((s, r) => s + r.completionTokens, 0);
      const costYuan = parseFloat(recs.reduce((s, r) => s + r.costYuan, 0).toFixed(6));
      return { nodeName: name, calls, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, costYuan };
    });

    const byNode = Object.fromEntries(nodes.map((n) => [n.nodeName, n]));

    return {
      summary: {
        totalCalls: this.records.length,
        totalCostYuan: this.getTotalCost(),
        budgetYuan: this.budgetYuan,
      },
      byNode,
      records: this.records,
    };
  }

  // ── saveReport ────────────────────────────────────────────────────────────

  async saveReport(filePath?: string): Promise<void> {
    const resolvedPath =
      filePath ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "knowledge",
        "reports",
        `cost-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      );

    const dir = path.dirname(resolvedPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const report = this.getReport();
    await writeFile(resolvedPath, JSON.stringify(report, null, 2), "utf-8");
    console.log(`[CostGuard] 报告已保存: ${resolvedPath}`);
  }
}

// ============================================================================
// 测试
// ============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, label: string): void {
      if (condition) {
        passed++;
      } else {
        console.log(`  ✗ ${label}`);
        failed++;
      }
    }

    const formatNodeCosts = (byNode: Record<string, Record<string, unknown>>) =>
      Object.entries(byNode)
        .map(([k, v]) => `'${k}': ${v.costYuan}`)
        .join(", ");

    // ════════════════════════════════════════════════════════════════════════════
    // 测试 1：成本追踪
    // ════════════════════════════════════════════════════════════════════════════

    console.log("=== 测试 1：成本追踪 ===");

    const guard = new CostGuard(0.01, 0.8, 1.0, 2.0);

    guard.record("collect", { promptTokens: 100, completionTokens: 50 }, "deepseek-chat");
    guard.record("analyze", { promptTokens: 2000, completionTokens: 1000 }, "deepseek-chat");
    guard.record("review", { promptTokens: 2000, completionTokens: 1050 }, "deepseek-chat");

    assert(guard.getReport().records.length === 3, "records.length = 3");
    const r1 = guard.getReport() as Record<string, unknown>;
    const costByNode = (r1.byNode as Record<string, Record<string, unknown>>);
    const totalCost1 = (r1.summary as Record<string, unknown>).totalCostYuan as number;
    assert(totalCost1 > 0, "totalCost > 0");

    console.log(`  调用次数: ${(r1.summary as Record<string, unknown>).totalCalls}`);
    console.log(`  总成本: ¥${totalCost1.toFixed(4)}`);
    console.log(`  按节点: {${formatNodeCosts(costByNode)}}`);

    {
      let status: string;
      try {
        status = guard.check().status;
      } catch {
        status = "exceeded";
      }
      console.log(`  预算状态: ${status}`);
    }

    await guard.saveReport();
    console.log();

    // ════════════════════════════════════════════════════════════════════════════
    // 测试 2：预算超限
    // ════════════════════════════════════════════════════════════════════════════

    console.log("=== 测试 2：预算超限 ===");

    const guard2 = new CostGuard(0.3, 0.8, 1.0, 2.0);
    guard2.record("analyzer", { promptTokens: 100000, completionTokens: 100000 }, "deepseek-chat");

    let thrown = false;
    let exceededError: BudgetExceededError | null = null;
    try {
      guard2.check();
    } catch (err) {
      thrown = err instanceof BudgetExceededError;
      if (thrown) exceededError = err as BudgetExceededError;
    }
    assert(thrown, "超出预算应抛出 BudgetExceededError");
    assert(exceededError !== null, "BudgetExceededError 非空");
    assert((exceededError?.totalCost ?? 0) >= 0, "totalCost >= 0");

    if (exceededError) {
      console.log(`  预算超限检测通过: 成本已超出预算！当前: ¥${exceededError.totalCost.toFixed(4)}, 预算: ¥${exceededError.budget.toFixed(2)}`);
    }

    await guard2.saveReport();
    console.log();

    // ════════════════════════════════════════════════════════════════════════════
    // 测试 3：预警阈值
    // ════════════════════════════════════════════════════════════════════════════

    console.log("=== 测试 3：预警阈值 ===");

    const guard3 = new CostGuard(1.0, 0.8, 1.0, 2.0);
    guard3.record("analyzer", { promptTokens: 300000, completionTokens: 100000 }, "deepseek-chat");
    guard3.record("reviewer", { promptTokens: 150000, completionTokens: 100000 }, "deepseek-chat");

    let warningResult: ReturnType<typeof guard3.check> | null = null;
    try {
      warningResult = guard3.check();
    } catch {
      assert(false, "预警不应触发超限异常");
    }
    assert(warningResult?.status === "warning", "status = warning");
    assert((warningResult?.usageRatio ?? 0) >= 0.8, "usageRatio >= 0.8");

    console.log(`  预警状态: ${warningResult?.status} — [预警] 成本已达预算的 ${((warningResult?.usageRatio ?? 0) * 100).toFixed(0)}%！`);

    // 再追加一条触发超限
    guard3.record("reviser", { promptTokens: 100000, completionTokens: 50000 }, "deepseek-chat");
    let exceeded2 = false;
    try {
      guard3.check();
    } catch (err) {
      exceeded2 = err instanceof BudgetExceededError;
    }
    assert(exceeded2, "追加后应抛出 BudgetExceededError");

    await guard3.saveReport();
    console.log();

    // ════════════════════════════════════════════════════════════════════════════
    // 汇总
    // ════════════════════════════════════════════════════════════════════════════

    if (failed === 0) {
      console.log("所有测试通过！");
    } else {
      console.log(`通过: ${passed}  失败: ${failed}`);
      process.exit(1);
    }
  })();
}
