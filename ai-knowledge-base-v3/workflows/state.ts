/**
 * workflows/state.ts — LangGraph 工作流共享状态定义
 *
 * 遵循"报告式通信"原则：每个字段是上游产出的结构化摘要，而非原始中间数据。
 * 下游节点只读抽象结果，不依赖上游的内部实现细节。
 *
 * @usage
 *   import { KBState, SourceItem, AnalysisItem, ArticleItem, CostTracker } from "./workflows/state.js";
 *
 *   const state: KBState = {
 *     sources: [...], analyses: [...], articles: [...],
 *     review_feedback: "", review_passed: true,
 *     iteration: 1, cost_tracker: { totalTokens: 0, cost: 0 },
 *   };
 *
 * @verify
 *   npx tsx -e "
 *   import { KBState } from './workflows/state.js';
 *   const s: KBState = { sources:[], analyses:[], articles:[], review_feedback:'', review_passed:false, iteration:0, cost_tracker:{} };
 *   console.log('KBState 字段:');
 *   ['sources','analyses','articles','review_feedback','review_passed','iteration','cost_tracker']
 *     .forEach(f => console.log('  ' + f + ': ' + typeof (s as any)[f]));
 *   console.log('\n共 ' + Object.keys(s).length + ' 个字段');
 *   console.log('实例创建成功，iteration = ' + s.iteration);
 *   "
 */

/** 采集到的一条原始数据记录 */
export interface SourceItem {
  /** 标题，如 repo 全名或文章标题 */
  title: string;
  /** 来源 URL */
  url: string;
  /** 简要描述，从原始描述中截取的前 300 字符 */
  summary: string;
  /** 来源标识：github / rss / blog */
  source: string;
  /** 采集时间，ISO 8601 格式 */
  collectedAt: string;
  /** 星标数，仅 GitHub 来源有值 */
  stars?: number;
  /** 编程语言，仅 GitHub 来源有值 */
  language?: string | null;
  /** 主题标签列表，仅 GitHub 来源有值 */
  topics?: string[];
}

/** LLM 分析后的一条结构化结果 */
export interface AnalysisItem {
  /** 经过 LLM 提炼的中文摘要（20-80 字） */
  summary: string;
  /** 综合价值评分，1-10 整数，10 为最高 */
  score: number;
  /** LLM 识别的技术标签，如 ["AI Agent", "RAG", "开源"] */
  tags: string[];
}

/** 格式化、去重后的知识条目 */
export interface ArticleItem {
  /** 唯一标识，格式：日期-来源-slug，如 "20260430-github-langgenius-dify" */
  id: string;
  /** 展示用标题 */
  title: string;
  /** 项目原始链接 */
  sourceUrl: string;
  /** 经 LLM 提炼的摘要 */
  summary: string;
  /** 分类标签 */
  tags: string[];
  /** 发布状态：pending / analyzed / published / archived */
  status: string;
}

/** Token 用量追踪 */
export interface CostTracker {
  /** 累计 Token 消耗（输入+输出） */
  totalTokens?: number;
  /** 累计费用估算（元），保留 4 位小数 */
  cost?: number;
}

/**
 * 工作流共享状态 — 各节点的输入输出契约
 *
 * 每个字段是上一节点的"结构化摘要"，不携带原始响应体或临时中间变量。
 * 下游按照字段的类型约定消费，无需知晓上游的内部处理细节。
 */
export interface KBState {
  /**
   * 步骤 0 · 采集 — 原始数据列表
   * 格式：SourceItem[]，由 GitHub/RSS 采集节点填充
   * 下游（分析节点）按 title/url/summary 做分析，不直接读取原始 API 响应
   */
  sources: SourceItem[];

  /**
   * 步骤 1 · 分析 — LLM 结构化结果列表
   * 格式：AnalysisItem[]，与 sources 按索引一一对应
   * 每个元素是 LLM 对原始数据的提炼摘要+评分+标签，不是 LLM 原始返回报文
   */
  analyses: AnalysisItem[];

  /**
   * 步骤 2 · 整理 — 去重 + 格式化后的知识条目
   * 格式：ArticleItem[]，已按 URL 去重，id 为唯一索引
   * 包含 camelCase 字段，可在其他模块直接使用
   */
  articles: ArticleItem[];

  /**
   * 步骤 3 · 审核 — 反馈意见
   * 格式：纯文本字符串，由 Supervisor 对 articles 的质量评估生成
   * 通过时可为空字符串，不通过时包含具体问题及改进建议
   */
  review_feedback: string;

  /**
   * 步骤 3 · 审核 — 是否通过
   * Supervisor 综合评分 >= 阈值时为 true，否则为 false
   * 控制审核循环是否需要重做
   */
  review_passed: boolean;

  /**
   * 审核循环 — 当前轮次
   * 从 1 开始计数，每次审核不通过后 +1，上限 3
   * 用于防止无限重做，达到上限后强制结束并记录警告
   */
  iteration: number;

  /**
   * 全局 — Token 用量追踪
   * 累计所有 LLM 调用的 Token 消耗及费用估算
   * 由各节点在调用 LLM 后更新，对外输出汇总报告
   */
  cost_tracker: CostTracker;
}
