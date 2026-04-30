/**
 * AI 知识库五步流水线：初始化 → 采集 → 分析 → 整理 → 保存
 *
 * 运行方式：
 *   node pipeline/pipeline.ts                    # 完整流水线（默认 github+rss, limit=20）
 *   node pipeline/pipeline.ts --sources github   # 仅 GitHub
 *   node pipeline/pipeline.ts --sources rss      # 仅 RSS
 *   node pipeline/pipeline.ts --limit 5          # 每源最多 5 条
 *   node pipeline/pipeline.ts --dry-run          # 干跑模式（不写入文件）
 *   node pipeline/pipeline.ts --verbose          # 详细日志
 *   node pipeline/pipeline.ts --steps 0,1        # 仅采集（无 LLM，免费）
 *   node pipeline/pipeline.ts --steps 2,3,4      # 仅分析入库（读取已采集的 raw 数据）
 *
 * CLI 参数：
 *   --sources <github,rss>   采集来源，逗号分隔，默认 github,rss
 *   --limit <N>              单源上限，默认 20
 *   --dry-run                干跑模式，仅预览不保存
 *   --verbose                输出详细日志
 *   --steps <0,1,2,3,4>      指定运行的步骤，逗号分隔；不传则运行全部
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import axios from "axios";
import { chatWithRetry, createProvider, type ChatMessage, type ChatOptions } from "./model_client.ts";

// ── 常量 ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RAW_DIR = path.resolve(__dirname, "../knowledge/raw");
const ARTICLE_DIR = path.resolve(__dirname, "../knowledge/articles");
const TODAY = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
const RSS_FEED_URL = "https://hnrss.org/frontpage?count=30";

// ── 类型 ─────────────────────────────────────────────────────────────────────

interface RawItem {
  title: string;
  url: string;
  summary: string;
  source: string;
  collectedAt: string;
  stars?: number;
  language?: string | null;
  topics?: string[];
}

interface Article {
  id: string;
  title: string;
  sourceUrl: string;
  summary: string;
  tags: string[];
  status: string;
}

interface CliArgs {
  sources: string[];
  limit: number;
  dryRun: boolean;
  verbose: boolean;
  steps: number[];
}

// ── 日志与计时 ──────────────────────────────────────────────────────────────

const START = Date.now();
let LAST_TICK = Date.now();

function ts(): string {
  return new Date().toISOString();
}

function elapsed(since?: number): string {
  const from = since ?? START;
  const ms = Date.now() - from;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function tick(label: string): void {
  const cost = Date.now() - LAST_TICK;
  LAST_TICK = Date.now();
  if (!label) return;
  const costStr = cost < 1000 ? `${cost}ms` : `${(cost / 1000).toFixed(1)}s`;
  info(`  ⏱ ${label} 耗时 ${costStr}`, true);
}

function info(msg: string, force = false): void {
  if (force) console.log(`[${ts()}] [INFO] ${msg}`);
}

function verbose(msg: string, v: boolean): void {
  if (v) console.log(`[${ts()}] [VERB] ${msg}`);
}

function warn(msg: string): void {
  console.log(`[${ts()}] [WARN] ${msg}`);
}

function step(n: number, label: string): void {
  console.log(`[${ts()}] [STEP ${n}/5] ${label}`);
}

// ── 辅助 ─────────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function now(): string {
  return new Date().toISOString();
}

// ── Step 0: 初始化 ───────────────────────────────────────────────────────────

async function initStep(args: CliArgs): Promise<void> {
  const configured = ["DEEPSEEK_API_KEY", "QWEN_API_KEY", "OPENAI_API_KEY"].filter(k => process.env[k]);
  info(`  API Key: ${configured.length}/3 (${configured.join(", ") || "无"})`, true);
  info(`  来源: ${args.sources.join(", ")}  |  上限: ${args.limit}  |  干跑: ${args.dryRun}`, true);
  LAST_TICK = Date.now();
}

// ── Step 1: 采集 ─────────────────────────────────────────────────────────────

async function collectGitHub(limit: number, v: boolean): Promise<RawItem[]> {
  verbose(`GitHub 搜索: GET ${GITHUB_SEARCH_URL}?q=ai&per_page=${Math.min(limit, 100)}`, v);
  const t0 = Date.now();
  const res = await axios.get(GITHUB_SEARCH_URL, {
    params: { q: "ai", sort: "stars", order: "desc", per_page: Math.min(limit, 100) },
    headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "knowledge-pipeline" },
    timeout: 30_000,
  });
  const cost = Date.now() - t0;
  const remaining = res.headers["x-ratelimit-remaining"];
  verbose(`GitHub API 响应: ${res.status}, 耗时 ${cost}ms, 剩余配额 ${remaining ?? "未知"}`, v);

  const items: RawItem[] = (res.data.items ?? []).slice(0, limit).map((r: any) => ({
    title: r.full_name,
    url: r.html_url,
    summary: (r.description ?? "").slice(0, 300),
    source: "github",
    collectedAt: now(),
    stars: r.stargazers_count,
    language: r.language,
    topics: r.topics ?? [],
  }));

  info(`  GitHub 采集到 ${items.length} 条`, true);
  for (const item of items) {
    verbose(`    ${item.stars}★ ${item.title}`, v);
  }
  return items;
}

async function collectRSS(limit: number, v: boolean): Promise<RawItem[]> {
  verbose(`RSS 抓取: GET ${RSS_FEED_URL}`, v);
  const t0 = Date.now();
  const res = await axios.get(RSS_FEED_URL, { timeout: 30_000 });
  verbose(`RSS 响应: ${res.status}, ${res.data.length} bytes, ${Date.now() - t0}ms`, v);

  const items: RawItem[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(res.data)) !== null && items.length < limit) {
    const block = m[1];
    const rawTitle = block.match(/<title>(.*?)<\/title>/)?.[1] ?? "";
    const title = rawTitle.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    const link = block.match(/<link>(.*?)<\/link>/)?.[1] ?? "";
    const desc = (block.match(/<description>(.*?)<\/description>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[|\]\]>/g, "")
      .replace(/<[^>]*>/g, "")
      .slice(0, 300)
      .trim();
    if (title && link) {
      items.push({ title, url: link, summary: desc, source: "rss", collectedAt: now() });
    }
  }

  info(`  RSS 采集到 ${items.length} 条`, true);
  for (const item of items) {
    verbose(`    ${item.title.slice(0, 60)}`, v);
  }
  return items;
}

async function saveRaw(source: string, items: RawItem[], v: boolean): Promise<void> {
  if (!existsSync(RAW_DIR)) {
    await fs.mkdir(RAW_DIR, { recursive: true });
    verbose(`创建目录: ${RAW_DIR}`, v);
  }
  const file = path.join(RAW_DIR, `${source}-${TODAY}.json`);
  const data = { source, collectedAt: now(), items };
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(file, json, "utf-8");
  info(`  → 原始数据已保存: ${file} (${(json.length / 1024).toFixed(1)} KB)`, true);
}

// ── Step 2: 分析 ─────────────────────────────────────────────────────────────

const ANALYZE_PROMPT = `你是一个知识库分析助手。请分析以下 AI 项目信息，返回 JSON（不要加 markdown 代码块标记）：

{
  "summary": "中文摘要（20-80 字，突出技术价值）",
  "score": <1-10 整数>,
  "tags": ["标签1", "标签2", ...]
}

项目信息：`;

async function analyzeItem(item: RawItem, index: number, total: number, v: boolean): Promise<{ summary: string; score: number; tags: string[] }> {
  const prompt = ANALYZE_PROMPT + `\n名称: ${item.title}\n描述: ${item.summary}\n语言: ${item.language ?? "未知"}\n星标: ${item.stars ?? 0}`;
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  const options: ChatOptions = { temperature: 0.3, maxTokens: 300 };

  const label = `【${index + 1}/${total}】分析 ${item.title}`;
  info(`  ${label}...`, true);
  const t0 = Date.now();

  try {
    const provider = createProvider();
    const resp = await chatWithRetry(provider, messages, options);
    const raw = resp.content.trim();
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));

    verbose(`  ${label} 完成 ${Date.now() - t0}ms, tokens=${resp.usage.totalTokens}`, v);
    verbose(`    摘要: ${String(json.summary).slice(0, 50)}...`, v);
    verbose(`    评分: ${json.score}/10, 标签: ${(json.tags ?? []).join(", ")}`, v);

    return {
      summary: String(json.summary ?? item.summary).slice(0, 200),
      score: Math.max(1, Math.min(10, Number(json.score) || 5)),
      tags: Array.isArray(json.tags) ? json.tags.map(String) : [],
    };
  } catch {
    warn(`  ${label} 失败，使用兜底值`);
    return { summary: item.summary, score: 5, tags: ["ai"] };
  }
}

// ── Step 3: 整理 ─────────────────────────────────────────────────────────────

function organize(items: RawItem[], analyzed: Map<number, { summary: string; score: number; tags: string[] }>, v: boolean): Article[] {
  const seen = new Set<string>();
  const articles: Article[] = [];
  let seq = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const key = item.url.toLowerCase();
    if (seen.has(key)) {
      verbose(`  去重跳过: ${item.url}`, v);
      continue;
    }
    seen.add(key);

    const a = analyzed.get(i);
    seq++;
    const id = `${TODAY}-${item.source}-${slugify(item.title)}`;

    articles.push({
      id,
      title: item.title,
      sourceUrl: item.url,
      summary: a?.summary ?? item.summary,
      tags: a?.tags?.length ? a.tags : ["ai"],
      status: "draft",
    });
  }

  const dupCount = items.length - articles.length;
  if (dupCount > 0) info(`  去重移除: ${dupCount} 条重复`, true);
  return articles;
}

// ── Step 4: 保存 ─────────────────────────────────────────────────────────────

async function saveArticles(articles: Article[], dryRun: boolean, v: boolean): Promise<void> {
  if (dryRun) {
    info(`  [干跑模式] 将保存 ${articles.length} 篇文章`, true);
    for (const art of articles) {
      console.log(`    ${art.id}`);
      console.log(`      标题: ${art.title}`);
      console.log(`      链接: ${art.sourceUrl}`);
      console.log(`      标签: ${art.tags.join(", ")}`);
      console.log("");
    }
    return;
  }

  if (!existsSync(ARTICLE_DIR)) {
    await fs.mkdir(ARTICLE_DIR, { recursive: true });
    verbose(`创建目录: ${ARTICLE_DIR}`, v);
  }

  let totalBytes = 0;
  for (const art of articles) {
    const file = path.join(ARTICLE_DIR, `${art.id}.json`);
    const json = JSON.stringify(art, null, 2);
    await fs.writeFile(file, json, "utf-8");
    totalBytes += json.length;
    verbose(`  → 已保存: ${art.id} (${(json.length / 1024).toFixed(1)} KB)`, v);
  }

  info(`  → 共 ${articles.length} 篇, ${(totalBytes / 1024).toFixed(1)} KB, 保存至 ${ARTICLE_DIR}`, true);
}

// ── Step 1 跳过时：从磁盘加载原始数据 ───────────────────────────────────────

async function loadRawFromDisk(sources: string[], v: boolean): Promise<RawItem[]> {
  const allItems: RawItem[] = [];
  for (const source of sources) {
    const file = path.join(RAW_DIR, `${source}-${TODAY}.json`);
    if (!existsSync(file)) {
      warn(`  原始数据文件不存在: ${file}，跳过`);
      continue;
    }
    const raw = JSON.parse(await fs.readFile(file, "utf-8"));
    const items: RawItem[] = raw.items ?? [];
    info(`  从磁盘加载 ${source} 原始数据: ${items.length} 条`, true);
    allItems.push(...items);
    for (const item of items) {
      verbose(`    ${item.stars ?? 0}★ ${item.title}`, v);
    }
  }
  return allItems;
}

// ── 流水线编排 ───────────────────────────────────────────────────────────────

async function runPipeline(args: CliArgs): Promise<void> {
  const runSteps = args.steps.length > 0 ? new Set(args.steps) : new Set([0, 1, 2, 3, 4]);

  console.log(`\n${"█".repeat(50)}`);
  console.log(`  知识库自动化流水线`);
  console.log(`  来源: ${args.sources.join(", ")}  |  上限: ${args.limit}  |  干跑: ${args.dryRun}`);
  if (args.steps.length > 0) console.log(`  步骤: ${args.steps.join(", ")}`);
  console.log(`${"█".repeat(50)}\n`);

  let allItems: RawItem[] = [];

  // ── Step 0: 初始化 ──
  if (runSteps.has(0)) {
    step(0, "初始化 Init");
    await initStep(args);
  }

  // ── Step 1: 采集 ──
  if (runSteps.has(1)) {
    step(1, "采集 Collect");
    for (const source of args.sources) {
      if (source === "github") {
        const items = await collectGitHub(args.limit, args.verbose);
        await saveRaw("github", items, args.verbose);
        allItems.push(...items);
      } else if (source === "rss") {
        const items = await collectRSS(args.limit, args.verbose);
        await saveRaw("rss", items, args.verbose);
        allItems.push(...items);
      } else {
        warn(`未知来源: ${source}，跳过`);
      }
    }
  } else if (runSteps.has(2) || runSteps.has(3) || runSteps.has(4)) {
    // Step 1 被跳过但后续步骤需要数据 → 从磁盘加载
    allItems = await loadRawFromDisk(args.sources, args.verbose);
  }

  // ── Step 2: 分析 ──
  let analyzed = new Map<number, { summary: string; score: number; tags: string[] }>();
  if (runSteps.has(2) && allItems.length > 0) {
    step(2, "分析 Analyze");
    for (let i = 0; i < allItems.length; i++) {
      const result = await analyzeItem(allItems[i], i, allItems.length, args.verbose);
      analyzed.set(i, result);
    }
    tick("分析");
  } else if (runSteps.has(2)) {
    info(`  无数据可分析，跳过`, true);
  }

  // ── Step 3: 整理 ──
  let articles: Article[] = [];
  if (runSteps.has(3) && allItems.length > 0) {
    step(3, "整理 Organize");
    articles = organize(allItems, analyzed, args.verbose);
  }

  // ── Step 4: 保存 ──
  if (runSteps.has(4)) {
    step(4, "保存 Save");
    await saveArticles(articles, args.dryRun, args.verbose);
    info(`  完成: 采集 ${allItems.length} → 分析 ${analyzed.size} → 去重 ${allItems.length - articles.length} → 入库 ${articles.length} (${elapsed()})`, true);
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const args: CliArgs = { sources: ["github", "rss"], limit: 20, dryRun: false, verbose: false, steps: [] };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--sources":
        args.sources = (argv[++i] ?? "").split(",").map(s => s.trim()).filter(Boolean);
        break;
      case "--limit":
        args.limit = parseInt(argv[++i], 10) || 20;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--verbose":
        args.verbose = true;
        break;
      case "--steps":
        args.steps = (argv[++i] ?? "").split(",").map(Number).filter(n => n >= 0 && n <= 4);
        break;
      default:
        warn(`未知参数: ${argv[i]}`);
    }
  }

  return args;
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs();
  runPipeline(args).catch(err => {
    console.error(`[${ts()}] [ERROR] 流水线异常: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
