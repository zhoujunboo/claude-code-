/**
 * patterns/router.ts — 路由模式：两层意图分类 + 三路分发
 *
 * @usage
 *   npx tsx patterns/router.ts "搜索AI Agent 开源项目"      # 查询结果
 *   npx tsx patterns/router.ts --verbose "知识库里有什么"    # 带诊断日志
 *   npx tsx patterns/router.ts                               # 无参数自测
 *
 * @intent
 *   第一层: 关键词快速匹配 (零 LLM 成本)
 *   第二层: LLM 分类兜底 (处理模糊意图)
 *
 *   → github_search   → GitHub Search API
 *   → knowledge_query → knowledge/articles/ 本地检索
 *   → general_chat    → LLM 直接回答
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chatWithRetry,
  createProvider,
  type ChatMessage,
  type ChatOptions,
} from "../pipeline/model_client.js";

// ── 常量 ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTICLES_DIR = path.resolve(__dirname, "../knowledge/articles");
const ARTICLES_INDEX = path.join(ARTICLES_DIR, "index.json");

const GITHUB_API = "https://api.github.com/search/repositories";

const CATEGORY_PROMPT = `你是一个意图分类助手。请分析用户输入，判断属于以下哪种意图：

1. github_search — 用户想搜索 GitHub 上的开源项目、仓库
2. knowledge_query — 用户想查询本地知识库中的文章、摘要、AI 资讯
3. general_chat — 其他通用对话

请只返回意图标识符（github_search / knowledge_query / general_chat），不要加其他内容。`;

const KEYWORD_EXTRACT_PROMPT = `你是一个 GitHub 搜索关键词提取助手。用户输入可能是自然语言，请从中提取 1-5 个最适合在 GitHub 上搜索的英文关键词，用空格分隔。

规则：
- 优先提取技术名词、框架名、工具名（如 AI Agent、RAG、LangChain）
- 中文功能描述翻译为英文技术关键词
- 忽略"搜索""找""有什么"等无意义噪声词
- 只返回关键词，不要加其他内容

用户输入：`;

// ── 类型 ─────────────────────────────────────────────────────────────────────

type Intent = "github_search" | "knowledge_query" | "general_chat";

interface Article {
  id: string;
  title: string;
  sourceUrl: string;
  summary: string;
  tags: string[];
  status: string;
}

// ── 通用 chat / chatJSON ─────────────────────────────────────────────────────

async function chat(
  prompt: string,
  systemPrompt?: string,
  options?: ChatOptions,
): Promise<string> {
  const provider = createProvider();
  const messages: ChatMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  messages.push({ role: "user", content: prompt });
  const response = await chatWithRetry(provider, messages, options);
  return response.content;
}

async function chatJSON<T>(
  prompt: string,
  systemPrompt?: string,
  options?: ChatOptions,
): Promise<T> {
  const text = await chat(prompt, systemPrompt, options);
  const cleaned = text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return JSON.parse(cleaned) as T;
}

// ── 第一层：关键词快速匹配 ────────────────────────────────────────────────────

const KEYWORD_MAP: [Intent, RegExp[]][] = [
  [
    "github_search",
    [
      /github/i,
      /\b(repo|repository)\b/i,
      /(开源项目|源代码|源码)/,
      /^(搜(?:索|一下)?\s*|找\s*)?.{0,6}(项目|仓库|开源|框架|工具库|\bproject\b)/,
      /有什么.{0,6}(开源|好用).{0,6}(项目|库|工具|框架)/,
      /推荐.{0,6}(开源|github).{0,6}(项目|库|框架)/,
      /\b(star|fork|issue|pull\s*request)\b/i,
      /(搜索|找|推荐)\s*.{0,8}(技术|框架|工具|项目)/,
      /最新.{0,8}(技术|框架|趋势|项目)/,
    ],
  ],
  [
    "knowledge_query",
    [
      /(知识库|知识条目)/,
      /(文章|article)/i,
      /(摘要|总结|归档|archive)/i,
      /(最近|最新).{0,6}(资讯|动态|更新|文章|内容)/,
      /库里?.{0,4}(有|什么|存|搜)/,
      /本地.{0,4}(搜索|查询|检索|找)/,
      /(有什么|查看).{0,4}(新闻|新.{0,2}(项目|文章|动态|内容))/,
      /\btags?\b|标签/,
    ],
  ],
  [
    "general_chat",
    [
      /帮忙|能不能|可以吗|怎么样|为什么|如何\b/,
      /(分析|评价|评估|review|讲解一下|解释|说明|点评|聊聊|你觉得|你认为)/i,
      /写(一段|个)|帮我写|生成|翻译|改写|润色/,
      /你好|你是谁|介绍(一下)?自己/,
    ],
  ],
];

function classifyByKeyword(query: string): Intent | null {
  for (const [intent, patterns] of KEYWORD_MAP) {
    for (const pattern of patterns) {
      if (pattern.test(query)) {
        return intent;
      }
    }
  }
  return null;
}

// ── 第二层：LLM 分类兜底 ──────────────────────────────────────────────────────

async function classifyByLLM(query: string): Promise<Intent> {
  try {
    const result = await chat(query, CATEGORY_PROMPT, { temperature: 0, maxTokens: 32 });
    const trimmed = result.trim().toLowerCase();
    if (trimmed.includes("github_search")) return "github_search";
    if (trimmed.includes("knowledge_query")) return "knowledge_query";
    return "general_chat";
  } catch {
    return "general_chat";
  }
}

// ── 意图分类（两层策略） ──────────────────────────────────────────────────────

async function classifyIntent(query: string): Promise<Intent> {
  const keywordResult = classifyByKeyword(query);
  if (keywordResult) return keywordResult;
  return classifyByLLM(query);
}

// ── 处理器: github_search ────────────────────────────────────────────────────

async function extractSearchKeywords(rawQuery: string): Promise<string> {
  // 如果主要包含英文/数字且长度合适，直接使用
  if (/^[\w\s.\-+#]{2,40}$/.test(rawQuery.trim())) {
    return rawQuery.trim();
  }
  try {
    const keywords = await chat(rawQuery, KEYWORD_EXTRACT_PROMPT, { temperature: 0, maxTokens: 60 });
    const trimmed = keywords.trim();
    return trimmed.length > 0 ? trimmed : rawQuery.trim();
  } catch {
    return rawQuery.trim();
  }
}

async function handleGitHubSearch(query: string): Promise<string> {
  const keywords = await extractSearchKeywords(query);
  const params = new URLSearchParams({
    q: keywords,
    sort: "stars",
    order: "desc",
    per_page: "5",
  });
  const url = `${GITHUB_API}?${params.toString()}`;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "knowledge-router",
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const data = await res.json() as {
      items?: { full_name: string; html_url: string; description: string | null; stargazers_count: number; language: string | null }[];
    };
    const items = data.items ?? [];

    if (items.length === 0) {
      return `未找到与 "${keywords}" 相关的 GitHub 项目。`;
    }

    const lines = items.map((item, i) => {
      const desc = (item.description ?? "").slice(0, 120);
      const lang = item.language ?? "未知";
      return `${i + 1}. **${item.full_name}** ⭐${item.stargazers_count} (${lang})\n   ${desc}\n   ${item.html_url}`;
    });

    const note = keywords !== query ? `（原查询: "${query}" → 搜索关键词: "${keywords}"）\n\n` : "";
    return `GitHub 搜索 ${note}结果 (Top ${items.length}):\n\n${lines.join("\n\n")}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `GitHub 搜索失败: ${msg}`;
  }
}

// ── 处理器: knowledge_query ──────────────────────────────────────────────────

async function loadArticles(): Promise<Article[]> {
  try {
    const raw = await readFile(ARTICLES_INDEX, "utf-8");
    return JSON.parse(raw) as Article[];
  } catch {
    const files = await readdir(ARTICLES_DIR);
    const jsonFiles = files.filter((f) => f.endsWith(".json") && f !== "index.json");
    const articles: Article[] = [];
    for (const file of jsonFiles) {
      try {
        const raw = await readFile(path.join(ARTICLES_DIR, file), "utf-8");
        const article = JSON.parse(raw) as Article;
        if (article.id && article.title) {
          articles.push(article);
        }
      } catch {
        // 跳过无效文件
      }
    }
    return articles;
  }
}

const CN_NOISE_WORDS = [
  "搜索", "一下", "搜一下", "查一下", "找一下", "搜", "下",
  "帮我", "请", "有什么", "最新", "最近", "的", "吗", "相关",
  "？", "!", "。", "，", "！", "查看", "查找", "有没有",
  "什么", "哪些", "如何", "怎么", "介绍", "我想", "给我",
  "一个", "一些", "这个", "那个", "关于", "现在",
];

function tokenizeQuery(query: string): string[] {
  let cleaned = query;
  for (const w of CN_NOISE_WORDS) {
    cleaned = cleaned.replace(new RegExp(w, "g"), " ");
  }
  return cleaned
    .split(/[\s,，.。!！?？:：;；、·-]+/)
    .filter((t) => t.length >= 2);
}

function scoreArticle(article: Article, query: string): number {
  let score = 0;
  const fields = [article.title, article.summary, ...article.tags];

  // 1. 精确匹配
  const qLower = query.toLowerCase();
  for (const field of fields) {
    const lower = field.toLowerCase();
    if (lower === qLower) score += 10;
    if (lower.includes(qLower)) score += 5;
  }

  // 2. 英文空格分词
  const enWords = query.split(/\s+/).filter((w) => w.length >= 2);
  for (const w of enWords) {
    const wlower = w.toLowerCase();
    for (const field of fields) {
      if (field.toLowerCase().includes(wlower)) score += 2;
    }
  }

  // 3. 中文分词（剔除噪声词后）
  const cnTokens = tokenizeQuery(query);
  for (const token of cnTokens) {
    for (const field of fields) {
      if (field.includes(token)) score += 2;
    }
  }

  return score;
}

async function handleKnowledgeQuery(query: string): Promise<string> {
  try {
    const articles = await loadArticles();

    if (articles.length === 0) {
      return "本地知识库中暂无文章。";
    }

    const tokens = tokenizeQuery(query);
    const scored = articles
      .map((a) => ({ article: a, score: scoreArticle(a, query) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    if (scored.length === 0) {
      return `知识库中共有 ${articles.length} 篇文章，但未找到与 "${query}" 匹配的内容。\n\n建议尝试其他关键词，或查看最新文章。`;
    }

    const lines = scored.map((s, i) => {
      const a = s.article;
      return `${i + 1}. **${a.title}**\n   标签: ${a.tags.join(", ")}\n   摘要: ${a.summary.slice(0, 100)}`;
    });

    const tokenHint = tokens.length > 0 ? ` (检索词: ${tokens.join(", ")})` : "";
    return `知识库查询 "${query}"${tokenHint} 结果 (共 ${articles.length} 篇文章，匹配 ${scored.length} 条):\n\n${lines.join("\n\n")}`;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `知识库查询失败: ${msg}`;
  }
}

// ── 处理器: general_chat ─────────────────────────────────────────────────────

async function handleGeneralChat(query: string): Promise<string> {
  try {
    const reply = await chat(query, undefined, { temperature: 0.7, maxTokens: 1024 });
    return reply;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `聊天调用失败: ${msg}`;
  }
}

// ── 统一入口 ──────────────────────────────────────────────────────────────────

export async function route(query: string): Promise<string> {
  const intent = await classifyIntent(query);
  switch (intent) {
    case "github_search":
      return handleGitHubSearch(query);
    case "knowledge_query":
      return handleKnowledgeQuery(query);
    default:
      return handleGeneralChat(query);
  }
}

export type { Intent, Article };

// ── 自测 / CLI 入口 ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rawArgs = process.argv.slice(2);
  const verboseArgIndex = rawArgs.findIndex((a) => a === "--verbose" || a === "-v");
  const verbose = verboseArgIndex !== -1;
  if (verbose) rawArgs.splice(verboseArgIndex, 1);
  const cliQuery = rawArgs.join(" ").trim();

  if (cliQuery) {
    async function run(): Promise<void> {
      const keyword = classifyByKeyword(cliQuery);
      let intent: Intent;

      if (keyword) {
        if (verbose) console.log(`[查询] ${cliQuery}\n  [第一层] 关键词匹配 → ${keyword}`);
        intent = keyword;
      } else {
        if (verbose) console.log(`[查询] ${cliQuery}\n  [第一层] 未匹配，进入第二层 LLM 分类...`);
        intent = await classifyByLLM(cliQuery).catch(() => "general_chat" as Intent);
        if (verbose) console.log(`  [第二层] LLM 分类结果 → ${intent}`);
      }

      const dispatch: Record<Intent, (q: string) => Promise<string>> = {
        github_search: handleGitHubSearch,
        knowledge_query: handleKnowledgeQuery,
        general_chat: handleGeneralChat,
      };
      const result = await dispatch[intent](cliQuery);

      if (verbose) {
        console.log(`  [结果]\n${result}`);
      } else {
        process.stdout.write(result);
        if (!result.endsWith("\n")) process.stdout.write("\n");
      }
    }

    run().catch((err: Error) => {
      console.error(`路由异常: ${err.message}`);
      process.exit(1);
    });
  } else {
    const testQueries = [
      "有什么好用的 AI Agent 开源项目？",
      "知识库里最近有什么内容？",
      "你好，介绍一下你自己",
    ];

    async function main(): Promise<void> {
      console.log("=== Router 路由模式 自测 ===\n");
      console.log("用法: npx tsx patterns/router.ts \"你的查询\"\n");

      for (const query of testQueries) {
        console.log(`[查询] ${query}`);

        const keyword = classifyByKeyword(query);
        if (keyword) {
          console.log(`  [第一层] 关键词匹配 → ${keyword}`);
        } else {
          console.log(`  [第一层] 未匹配 → [第二层] LLM 分类中...`);
        }
        const intent = keyword ?? await classifyByLLM(query).catch(() => "general_chat" as Intent);
        if (!keyword) console.log(`  [第二层] LLM 分类结果 → ${intent}`);

        const dispatch: Record<Intent, (q: string) => Promise<string>> = {
          github_search: handleGitHubSearch,
          knowledge_query: handleKnowledgeQuery,
          general_chat: handleGeneralChat,
        };

        try {
          const result = await dispatch[intent](query);
          console.log(`  [结果]\n${result}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  [错误] ${msg}`);
        }

        console.log("");
      }

      console.log("=== 自测完成 ===");
    }

    main().catch((err: Error) => {
      console.error(`自测异常: ${err.message}`);
      process.exit(1);
    });
  }
}
