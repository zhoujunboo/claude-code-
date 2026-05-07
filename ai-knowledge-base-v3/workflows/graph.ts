/**
 * workflows/graph.ts — 组装 LangGraph 知识库工作流
 *
 * @flow
 *   START → planner → collect → analyze → review
 *     ├─ passed → organize → END
 *     ├─ !passed + iter<3 → revise → review (循环修正)
 *     └─ !passed + iter≥3 → human_flag → END
 *
 * @usage
 *   npx tsx workflows/graph.ts                  # 流式运行工作流
 *   npx tsx workflows/graph.ts --invoke         # 同步调用模式
 * 
 * 
 * 
 * ① Planner	workflows/planner.py	动态规划策略
 * ② Collector	workflows/collector.py	数据采集
 * ③ Analyzer	workflows/analyzer.py	LLM 单条分析
 * ④ Reviewer	workflows/reviewer.py	5 维加权审核
 * ⑤ Reviser	workflows/reviser.py	读反馈定向修改
 * ⑥ Organizer	workflows/organizer.py	整理入库（正常终点）
 * ⑦ HumanFlag	workflows/human_flag.py	人工介入（异常终点）
 */

import { fileURLToPath } from "node:url";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { collectNode } from "./collector.js";
import { analyzeNode } from "./analyzer.js";
import { reviewNode } from "./reviewer.js";
import { reviseNode } from "./reviser.js";
import { humanFlagNode } from "./human_flag.js";
import { plannerNode } from "./planner.js";
import { organizeNode } from "./organizer.js";
import type { KBState, SourceItem, AnalysisItem, ArticleItem, CostTracker, Plan } from "./state.js";

// ============================================================================
// State 定义
// ============================================================================

const KBStateAnnotation = Annotation.Root({
  plan: Annotation<Plan>({
    default: () => ({
      tier: "standard",
      perSourceLimit: 10,
      relevanceThreshold: 0.5,
      maxIterations: 3,
      rationale: "",
    }),
    reducer: (_prev, next) => next,
  }),
  sources: Annotation<SourceItem[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  analyses: Annotation<AnalysisItem[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  articles: Annotation<ArticleItem[]>({
    default: () => [],
    reducer: (_prev, next) => next,
  }),
  review_feedback: Annotation<string>({
    default: () => "",
    reducer: (_prev, next) => next,
  }),
  review_passed: Annotation<boolean>({
    default: () => false,
    reducer: (_prev, next) => next,
  }),
  iteration: Annotation<number>({
    default: () => 0,
    reducer: (_prev, next) => next,
  }),
  cost_tracker: Annotation<CostTracker>({
    default: () => ({}),
    reducer: (_prev, next) => next,
  }),
});

// ============================================================================
// 构建图
// ============================================================================

function routeAfterReview(state: KBState): string {
  const maxIter = state.plan?.maxIterations ?? 3;
  const iter = state.iteration ?? 0;
  if (state.review_passed) return "organize";
  if (iter < maxIter) return "revise";
  return "human_flag";
}

function buildGraph() {
  return new StateGraph(KBStateAnnotation)
    .addNode("planner", plannerNode)
    .addNode("collect", collectNode)
    .addNode("analyze", analyzeNode)
    .addNode("review", reviewNode)
    .addNode("revise", reviseNode)
    .addNode("human_flag", humanFlagNode)
    .addNode("organize", organizeNode)

    .addEdge(START, "planner")
    .addEdge("planner", "collect")
    .addEdge("collect", "analyze")
    .addEdge("analyze", "review")

    .addConditionalEdges("review", routeAfterReview)

    .addEdge("revise", "review")
    .addEdge("human_flag", END)
    .addEdge("organize", END)
    .compile();
}

// ============================================================================
// 导出
// ============================================================================

export { buildGraph, KBStateAnnotation };
export type { KBState };
// ============================================================================
// CLI 入口
// ============================================================================

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const useInvoke = process.argv.includes("--invoke");
  const app = buildGraph();

  const initialState: KBState = {
    plan: {
      tier: "standard",
      perSourceLimit: 10,
      relevanceThreshold: 0.5,
      maxIterations: 3,
      rationale: "",
    },
    sources: [],
    analyses: [],
    articles: [],
    review_feedback: "",
    review_passed: false,
    iteration: 0,
    cost_tracker: {},
  };

  const title = "LangGraph 工作流";

  if (useInvoke) {
    console.log(`=== ${title} (invoke) ===\n`);
    app.invoke(initialState).then((finalState) => {
      console.log("\n=== 完成 ===");
      console.log(`articles: ${finalState.articles.length} | passed: ${finalState.review_passed} | iteration: ${finalState.iteration}`);
    }).catch((err: Error) => { console.error(err.message); process.exit(1); });
  } else {
    console.log(`=== ${title} (stream) ===\n`);

    (async () => {
      const steps: string[] = [];
      for await (const chunk of await app.stream(initialState)) {
        const [nodeName] = Object.keys(chunk);
        const data = chunk[nodeName];
        if (!data) continue;

        if (nodeName === "planner") steps.push(`planner(${data.plan?.tier ?? "?"})`);
        if (data.sources?.length) steps.push(`collect(${data.sources.length})`);
        if (nodeName === "analyze" && data.analyses?.length) steps.push(`analyze(${data.analyses.length})`);
        if (nodeName === "revise" && data.analyses?.length) steps.push(`revise(${data.analyses.length})`);
        if (nodeName === "review" || data.review_passed !== undefined) {
          const icon = data.review_passed ? "v" : "x";
          steps.push(`review${icon}(${data.iteration})`);
        }
        if (nodeName === "organize" && data.articles?.length) steps.push(`organize(${data.articles.length})`);
        if (nodeName === "human_flag") steps.push("human_flag");
      }

      console.log(`路径: ${steps.join(" → ")}`);
      console.log("\n=== 完成 ===");
    })().catch((err: Error) => { console.error(err.message); process.exit(1); });
  }
}

