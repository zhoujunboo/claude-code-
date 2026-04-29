/**
 * mcp_knowledge_server.ts — MCP Server for local knowledge base search
 *
 * 使用 JSON-RPC 2.0 over stdio 协议，供 AI 工具搜索本地知识库。
 * 提供三个工具：search_articles、get_article、knowledge_stats
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** 知识库文章结构，兼容蛇形和驼峰字段名 */
interface Article {
  id: string;
  title: string;
  sourceUrl?: string;
  source_url?: string;
  summary?: string;
  tags?: string[];
  status?: string;
  [key: string]: unknown;
}

/** JSON-RPC 2.0 请求 */
interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 响应 */
interface JsonRpcResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** MCP 工具定义，含参数 schema */
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/** 文章目录（优先从 pipeline/ 同级查找） */
const ARTICLES_DIR = path.resolve(__dirname, "knowledge/articles");
/** MCP 协议版本 */
const PROTOCOL_VERSION = "2025-03-26";

// ── 文章缓存 ─────────────────────────────────────────────────────────────────

let articlesCache: Article[] | null = null;

/** 从磁盘加载所有文章 JSON，启动时缓存 */
async function loadArticles(): Promise<Article[]> {
  if (articlesCache) return articlesCache;

  // 优先 pipeline/knowledge/articles/，回退到上级 knowledge/articles/
  const dir = existsSync(ARTICLES_DIR)
    ? ARTICLES_DIR
    : path.resolve(__dirname, "../knowledge/articles");

  if (!existsSync(dir)) {
    articlesCache = [];
    return articlesCache;
  }

  const files = await readdir(dir);
  const jsonFiles = files.filter(f => f.endsWith(".json")).sort();
  const articles: Article[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(raw) as Article;
      if (parsed.id) articles.push(parsed);
    } catch {
      // 损坏的文件静默跳过
    }
  }

  articlesCache = articles;
  return articles;
}

// ── 工具实现 ─────────────────────────────────────────────────────────────────

/** 按关键词搜索文章标题、摘要和标签，返回匹配结果 */
function searchArticles(articles: Article[], keyword: string, limit: number): Article[] {
  const kw = keyword.toLowerCase();
  const results: Article[] = [];

  for (const art of articles) {
    if (results.length >= limit) break;

    const title = (art.title ?? "").toLowerCase();
    const summary = (art.summary ?? art.source_url ?? "").toLowerCase();
    const tags = (art.tags ?? []).join(" ").toLowerCase();

    if (title.includes(kw) || summary.includes(kw) || tags.includes(kw)) {
      results.push(art);
    }
  }

  return results;
}

/** 按文章 ID 精确查找 */
function getArticleById(articles: Article[], id: string): Article | null {
  return articles.find(a => a.id === id) ?? null;
}

/** 统计知识库：总数、来源分布、热门标签、状态分布 */
function computeStats(articles: Article[]): {
  total: number;
  bySource: Record<string, number>;
  topTags: { tag: string; count: number }[];
  byStatus: Record<string, number>;
} {
  const bySource: Record<string, number> = {};
  const tagCount: Record<string, number> = {};
  const byStatus: Record<string, number> = {};

  for (const art of articles) {
    // 来源：优先取 source 字段，否则从 id 前缀推断
    const src = art.source ?? art.sourceType ?? (art.id ? art.id.split("-")[0] : "unknown");
    bySource[src] = (bySource[src] ?? 0) + 1;

    // 标签计数
    if (Array.isArray(art.tags)) {
      for (const t of art.tags) {
        tagCount[t] = (tagCount[t] ?? 0) + 1;
      }
    }

    // 状态计数
    const st = art.status ?? "unknown";
    byStatus[st] = (byStatus[st] ?? 0) + 1;
  }

  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  return { total: articles.length, bySource, topTags, byStatus };
}

// ── 工具定义 ─────────────────────────────────────────────────────────────────

const TOOLS: ToolDefinition[] = [
  {
    name: "search_articles",
    description: "按关键词搜索知识库文章标题、摘要和标签",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "返回条数上限", default: 5 },
      },
      required: ["keyword"],
    },
  },
  {
    name: "get_article",
    description: "按 ID 获取单篇文章的完整内容",
    inputSchema: {
      type: "object",
      properties: {
        article_id: { type: "string", description: "文章 ID，如 github-20260429-001" },
      },
      required: ["article_id"],
    },
  },
  {
    name: "knowledge_stats",
    description: "返回知识库统计信息：文章总数、来源分布、热门标签、状态分布",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── MCP 协议处理 ──────────────────────────────────────────────────────────────

/** 处理 JSON-RPC 请求，分发到对应方法 */
async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
  const id = req.id ?? null;
  const base = { jsonrpc: "2.0", id };

  try {
    switch (req.method) {
      // MCP 初始化握手
      case "initialize": {
        return {
          ...base,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "knowledge-server", version: "1.0.0" },
          },
        } as JsonRpcResponse;
      }

      // 列出可用工具
      case "tools/list": {
        return {
          ...base,
          result: { tools: TOOLS },
        } as JsonRpcResponse;
      }

      // 调用指定工具
      case "tools/call": {
        const params = req.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        if (!params || !params.name) {
          return { ...base, error: { code: -32602, message: "Missing tool name" } } as JsonRpcResponse;
        }

        const args = params.arguments ?? {};
        const articles = await loadArticles();

        switch (params.name) {
          case "search_articles": {
            const keyword = String(args.keyword ?? "");
            if (!keyword) {
              return { ...base, error: { code: -32602, message: "keyword is required" } } as JsonRpcResponse;
            }
            const limit = Math.min(Math.max(1, Number(args.limit) || 5), 50);
            const results = searchArticles(articles, keyword, limit);
            return {
              ...base,
              result: { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] },
            } as JsonRpcResponse;
          }

          case "get_article": {
            const articleId = String(args.article_id ?? "");
            if (!articleId) {
              return { ...base, error: { code: -32602, message: "article_id is required" } } as JsonRpcResponse;
            }
            const article = getArticleById(articles, articleId);
            if (!article) {
              return {
                ...base,
                result: { content: [{ type: "text", text: JSON.stringify({ error: `Article not found: ${articleId}` }, null, 2) }] },
              } as JsonRpcResponse;
            }
            return {
              ...base,
              result: { content: [{ type: "text", text: JSON.stringify(article, null, 2) }] },
            } as JsonRpcResponse;
          }

          case "knowledge_stats": {
            const stats = computeStats(articles);
            return {
              ...base,
              result: { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] },
            } as JsonRpcResponse;
          }

          default:
            return {
              ...base,
              error: { code: -32601, message: `Tool not found: ${params.name}` },
            } as JsonRpcResponse;
        }
      }

      default:
        return {
          ...base,
          error: { code: -32601, message: `Method not found: ${req.method}` },
        } as JsonRpcResponse;
    }
  } catch (err) {
    // 未捕获异常返回 Internal error
    return {
      ...base,
      error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
    } as JsonRpcResponse;
  }
}

// ── stdio 传输层 ──────────────────────────────────────────────────────────────

/** 从 stdin 逐行读取 JSON-RPC 请求，处理后写入 stdout */
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    const errResp: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
    process.stdout.write(JSON.stringify(errResp) + "\n");
    return;
  }

  const response = await handleRequest(request);
  process.stdout.write(JSON.stringify(response) + "\n");
});

rl.on("close", () => {
  // stdin 关闭时自然退出；MCP 客户端会在会话期间保持 stdin 打开。
});
