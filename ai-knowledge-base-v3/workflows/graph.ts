/**
 * workflows/graph.ts — 组装 LangGraph 知识库工作流
 *
 * @flow
 *   START → collect → analyze → organize → review
 *     ├─ passed → save → END
 *     └─ !passed → organize (循环修正)
 *
 * @usage
 *   npx tsx workflows/graph.ts                  # 流式运行工作流
 *   npx tsx workflows/graph.ts --invoke         # 同步调用模式
 */

import { fileURLToPath } from "node:url";
import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import {
  collectNode,
  analyzeNode,
  organizeNode,
  saveNode,
} from "./nodes.js";
import { reviewNode } from './reviewer.ts'
import type { KBState, SourceItem, AnalysisItem, ArticleItem, CostTracker } from "./state.js";

// ============================================================================
// State 定义
// ============================================================================

const KBStateAnnotation = Annotation.Root({
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

function buildGraph() {
  return new StateGraph(KBStateAnnotation)
    .addNode("collect", collectNode)
    .addNode("analyze", analyzeNode)
    .addNode("organize", organizeNode)
    .addNode("review", reviewNode)
    .addNode("save", saveNode)

    .addEdge(START, "collect")
    .addEdge("collect", "analyze")
    .addEdge("analyze", "organize")
    .addEdge("organize", "review")

    .addConditionalEdges("review", (state) =>
      state.review_passed ? "save" : "organize",
    )

    .addEdge("save", END)
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

        if (data.sources?.length) steps.push(`collect(${data.sources.length})`);
        if (data.analyses?.length) steps.push(`analyze(${data.analyses.length})`);
        if (data.articles?.length) {
          const tag = (data.review_feedback as string)?.length > 0 ? "fixup" : "organize";
          steps.push(`${tag}(${data.articles.length})`);
        }
        if (data.review_passed !== undefined) {
          const icon = data.review_passed ? "v" : "x";
          steps.push(`review${icon}(${data.iteration})`);
        }
        if (nodeName === "save") steps.push("save");
      }

      console.log(`路径: ${steps.join(" → ")}`);
      console.log("\n=== 完成 ===");
    })().catch((err: Error) => { console.error(err.message); process.exit(1); });
  }
}

