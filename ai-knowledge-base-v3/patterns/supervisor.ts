/**
 * patterns/supervisor.ts — 监督模式：Worker 生成 + Supervisor 审核循环
 *
 * @usage
 *   npx tsx patterns/supervisor.ts "分析 TypeScript 在企业项目中的优势"
 *   npx tsx patterns/supervisor.ts --max-retries 5 "你的任务"
 *   npx tsx patterns/supervisor.ts                        # 无参数自测
 *
 * @flow
 *   任务 → Worker(生成报告) → Supervisor(评分)
 *     ├─ score ≥ 7 → ✅ 通过，返回结果
 *     └─ score < 7 → ❌ 不通过，带反馈重做 (最多 3 轮)
 *         └─ 超过上限 → ⚠ 强制返回 + 警告
 */

import { fileURLToPath } from "node:url";
import {
  chatWithRetry,
  createProvider,
  globalTracker,
  type ChatMessage,
  type ChatOptions,
  type LLMUsage,
} from "../pipeline/model_client.js";

// ============================================================================
// 类型
// ============================================================================

/** 最终返回给调用方的结果 */
export interface SupervisorResult {
  output: string;
  attempts: number;
  finalScore: number;
  warning?: string;
}

/** Supervisor 打完分之后的审核结论 */
interface ReviewVerdict {
  passed: boolean;
  score: number;
  feedback: string;
}

// ============================================================================
// 日志工具
// ============================================================================

function log(msg: string): void {
  const stamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log(`[${stamp}] ${msg}`);
}

function sep(): void {
  console.log("─".repeat(50));
}

// ============================================================================
// LLM 调用封装
// ============================================================================

async function callLLM(
  userPrompt: string,
  systemPrompt: string,
  options?: ChatOptions,
): Promise<{ content: string; usage: LLMUsage }> {
  const provider = createProvider();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  return chatWithRetry(provider, messages, options);
}

// ============================================================================
// Prompt 模板
// ============================================================================

/** Worker（写手）的角色设定 */
const WORKER_ROLE = `你是一个专业的技术分析专家。请根据用户任务，输出一份 JSON 格式的分析报告。

要求：
1. 内容要求准确、有深度、格式规范
2. 报告结构：
   { "title": "标题", "summary": "摘要(50-100字)", "analysis": ["要点1", "要点2", "要点3"], "conclusion": "总结(2-3句)" }
3. 只输出纯 JSON，不要加 markdown 代码块
4. 使用中文`;

/** Supervisor（审稿人）的角色设定 */
const SUPERVISOR_ROLE = `你是一个严格的质量审核专家。审查以下报告的 JSON，从三个维度内部评分（每个 1-10），输出审核结论。

向内评分维度（不在输出中体现）：
- 准确性: 信息是否准确、逻辑是否严谨
- 深度: 分析是否深入、是否有独特见解
- 格式: 结构是否清晰、JSON 是否规范

输出 JSON 格式（严格遵守）：
{ "passed": true或false, "score": <1-10 整数>, "feedback": "改进建议(2-4句话，中文)" }

规则：
- 综合分 = (准确性 + 深度 + 格式) / 3，取整
- score >= 7 → passed: true
- score < 7 → passed: false，feedback 必须具体指出问题
- 只输出 JSON，不要加 markdown 代码块`;

// ============================================================================
// Worker Agent — 干活的人
// ============================================================================

async function workerWrite(task: string, lastFeedback?: string): Promise<string> {
  let prompt = `任务: ${task}`;
  if (lastFeedback) {
    prompt += `\n\n【上一轮审核反馈】${lastFeedback}\n\n请根据反馈中指出的问题，针对性改进后重新输出报告。`;
  }
  const resp = await callLLM(prompt, WORKER_ROLE, { temperature: 0.5, maxTokens: 2048 });
  return resp.content;
}

// ============================================================================
// Supervisor Agent — 审稿打分的老师傅
// ============================================================================

async function supervisorReview(report: string): Promise<ReviewVerdict> {
  const resp = await callLLM(report, SUPERVISOR_ROLE, { temperature: 0.1, maxTokens: 512 });
  const raw = resp.content.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  const json = JSON.parse(raw) as { passed?: boolean; score?: number; feedback?: string };

  const score = typeof json.score === "number" ? Math.max(1, Math.min(10, Math.round(json.score))) : 5;
  const passed = score >= 7;

  return {
    passed,
    score,
    feedback: String(json.feedback ?? "无反馈"),
  };
}

// ============================================================================
// 审核循环 — 核心流程
// ============================================================================

async function runReviewLoop(
  task: string,
  maxRounds: number,
): Promise<{ output: string; attempts: number; finalScore: number; warning?: string }> {
  let lastReport = "";
  let lastVerdict: ReviewVerdict | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    log(`第 ${round}/${maxRounds} 轮 · Worker 正在生成报告...`);
    const t0 = Date.now();

    lastReport = await workerWrite(task, lastVerdict?.feedback);
    const workerMs = Date.now() - t0;

    sep();
    log(`Worker 完成 (${(workerMs / 1000).toFixed(1)}s)，交由 Supervisor 审核...`);

    const t1 = Date.now();
    lastVerdict = await supervisorReview(lastReport);
    const reviewMs = Date.now() - t1;

    sep();
    if (lastVerdict.passed) {
      log(
        `第 ${round} 轮 · Supervisor 审核: ✅ 通过 — 评分 ${lastVerdict.score}/10 (${(reviewMs / 1000).toFixed(1)}s)`,
      );
      if (lastVerdict.feedback) log(`  评价: ${lastVerdict.feedback}`);
      return { output: lastReport, attempts: round, finalScore: lastVerdict.score };
    }

    log(
      `第 ${round} 轮 · Supervisor 审核: ❌ 不通过 — 评分 ${lastVerdict.score}/10 (${(reviewMs / 1000).toFixed(1)}s)`,
    );
    log(`  ⛔ 问题: ${lastVerdict.feedback}`);
    log(`  🔁 将携带反馈重做...`);
  }

  // 超出最大轮数
  return {
    output: lastReport,
    attempts: maxRounds,
    finalScore: lastVerdict?.score ?? 5,
    warning: `已达最大重试次数 (${maxRounds})，强制返回。最后评分: ${lastVerdict?.score ?? "?"}/10`,
  };
}

// ============================================================================
// 统一入口
// ============================================================================

/**
 * 监督模式
 *
 * @example
 *   const result = await supervisor("分析微服务的优缺点");
 *   console.log(result.output);     // 最终报告
 *   console.log(result.attempts);   // 花了多少轮
 *   console.log(result.finalScore); // 最终得分
 */
export async function supervisor(
  task: string,
  maxRetries: number = 3,
): Promise<SupervisorResult> {
  const maxRounds = Math.max(1, Math.min(10, maxRetries));
  const result = await runReviewLoop(task, maxRounds);
  return {
    output: result.output,
    attempts: result.attempts,
    finalScore: result.finalScore,
    warning: result.warning,
  };
}

// ============================================================================
// CLI 入口 & 自测
// ============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  let maxRetries = 3;
  const idx = args.findIndex((a) => a === "--max-retries");
  if (idx !== -1 && args[idx + 1]) {
    const val = parseInt(args[idx + 1], 10);
    if (val > 0) maxRetries = val;
    args.splice(idx, 2);
  }

  const task = args.join(" ").trim();

  if (task) {
    sep();
    log(`任务: ${task}`);
    log(`最大重试: ${maxRetries} 轮`);
    sep();

    const start = Date.now();
    supervisor(task, maxRetries)
      .then((r) => {
        const cost = ((Date.now() - start) / 1000).toFixed(1);
        sep();
        log(`🏁 完成 · ${r.attempts} 轮 · 评分 ${r.finalScore}/10 · 耗时 ${cost}s`);
        if (r.warning) log(`⚠ ${r.warning}`);
        console.log(`\n${r.output}`);
        globalTracker.report(process.env.LLM_PROVIDER ?? "deepseek");
      })
      .catch((err: Error) => {
        log(`❌ 错误: ${err.message}`);
        process.exit(1);
      });
  } else {
    log("=== Supervisor 监督模式 - 自测 ===");
    log("用法:");
    log('  npx tsx patterns/supervisor.ts "你的任务"');
    log("  npx tsx patterns/supervisor.ts --max-retries 5 \"你的任务\"");
    sep();

    const testTask = "用三句话介绍什么是 AI Agent";
    log(`自测任务: ${testTask}`);
    sep();

    const start = Date.now();
    supervisor(testTask, 3)
      .then((r) => {
        const cost = ((Date.now() - start) / 1000).toFixed(1);
        sep();
        log(`🏁 完成 · ${r.attempts} 轮 · 评分 ${r.finalScore}/10 · 耗时 ${cost}s`);
        if (r.warning) log(`⚠ ${r.warning}`);
        console.log(`\n${r.output}`);
        globalTracker.report(process.env.LLM_PROVIDER ?? "deepseek");
        log("=== 自测完成 ===");
      })
      .catch((err: Error) => {
        log(`❌ 错误: ${err.message}`);
        process.exit(1);
      });
  }
}
