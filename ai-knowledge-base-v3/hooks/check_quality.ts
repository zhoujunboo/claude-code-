#!/usr/bin/env ts-node-script
/**
 * 知识条目 5 维度质量评分脚本。
 *
 * 评分维度（加权总分 100 分）：
 *   摘要质量 25分 | 技术深度 25分 | 格式规范 20分 | 标签精度 15分 | 空洞词检测 15分
 *
 * 等级: A >= 80, B >= 60, C < 60
 * 存在任意 C 级条目时退出码为 1，否则为 0。
 *
 * 用法: npx ts-node hooks/check_quality.ts <json_file> [json_file2 ...]
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

/** ANSI 颜色转义。 */
const C = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
} as const;

/** 脚本所在目录，用于解析相对路径。 */
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1]));

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** 单个维度的评分结果。 */
interface DimensionScore {
  name: string;
  score: number;
  maxScore: number;
  detail: string;
}

/** 单个条目的质量报告。 */
interface QualityReport {
  file: string;
  total: number;
  dimensions: DimensionScore[];
  grade: 'A' | 'B' | 'C';
  errors: string[];
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 标准标签白名单（匹配时忽略大小写）。 */
const STANDARD_TAGS = [
  'agent', 'ai', 'llm', 'machine-learning', 'deep-learning', 'nlp',
  'prompt-engineering', 'rag', 'fine-tuning', 'embedding', 'vector-db',
  'automation', 'workflow', 'coding', 'cli', 'api', 'sdk',
  'frontend', 'backend', 'fullstack', 'web', 'mobile', 'cross-platform',
  'design', 'ui', 'ux', 'animation', 'visualization',
  'data', 'analytics', 'database', 'search', 'recommendation',
  'security', 'privacy', 'auth', 'devops', 'infra', 'cloud',
  'testing', 'debugging', 'observability', 'monitoring', 'logging',
  'open-source', 'tooling', 'framework', 'library', 'runtime',
  'tutorial', 'learning', 'education', 'research', 'paper',
  'productivity', 'collaboration', 'communication', 'social',
  'game', 'gaming', 'creative', 'art', 'music', 'video', 'audio',
  'chrome-extension', 'browser', 'vscode', 'obsidian', 'notion',
  'github', 'git', 'ci-cd', 'serverless', 'edge', 'cdn',
  'typescript', 'javascript', 'python', 'rust', 'go', 'wasm',
  'react', 'vue', 'angular', 'node', 'deno', 'bun',
  'nextjs', 'nuxt', 'svelte', 'solidjs', 'htmx',
  'tailwind', 'css', 'html', 'webgpu', 'webgl', 'threejs',
  'docker', 'kubernetes', 'terraform', 'ansible',
  'postgres', 'redis', 'mongodb', 'sqlite', 'clickhouse',
  'grpc', 'rest', 'graphql', 'websocket', 'webhook',
  'blockchain', 'web3', 'crypto', 'nft', 'defi',
  'robotics', 'iot', 'embedded', 'edge-computing',
  'accessibility', 'i18n', 'performance', 'seo',
].map(t => t.toLowerCase());

/** 中文空洞词黑名单。 */
const BUZZ_CN = ['赋能', '抓手', '闭环', '打通', '全链路', '底层逻辑', '颗粒度', '对齐', '拉通', '沉淀', '强大的', '革命性的'];

/** 英文空洞词黑名单（忽略大小写）。 */
const BUZZ_EN = ['groundbreaking', 'revolutionary', 'game-changing', 'cutting-edge', 'innovative', 'disruptive', 'unprecedented', 'breakthrough'];

/** 技术关键词（摘要质量奖励分用）。 */
const TECH_KEYWORDS = [
  'ai', 'llm', 'agent', 'rag', 'embedding', 'transformer', 'attention',
  'neural network', 'deep learning', 'machine learning', 'natural language',
  'vector', 'diffusion', 'reinforcement', 'fine-tuning', 'prompt',
  '人工智能', '机器学习', '深度学习', '大模型', '智能体', '神经网络',
];

/** 五个评分维度的名称与满分。 */
const DIMENSIONS = [
  { name: '摘要质量', maxScore: 25 },
  { name: '技术深度', maxScore: 25 },
  { name: '格式规范', maxScore: 20 },
  { name: '标签精度', maxScore: 15 },
  { name: '空洞词检测', maxScore: 15 },
] as const;

// ── 评分函数 ─────────────────────────────────────────────────────────────────

/** 摘要质量评分 (25分)。 */
function scoreSummary(entry: Record<string, unknown>): DimensionScore {
  const summary = (entry.summary ?? entry.summary) as string | undefined;
  if (!summary || typeof summary !== 'string') {
    return { name: '摘要质量', score: 0, maxScore: 25, detail: '缺少摘要字段' };
  }

  const len = summary.length;
  let score = 0;

  // 长度分
  if (len >= 50) {
    score = 20;
  } else if (len >= 20) {
    score = 12;
  } else {
    score = 5;
  }

  // 技术关键词奖励 (最多 +5)
  const lower = summary.toLowerCase();
  const matchedKeywords = TECH_KEYWORDS.filter(kw => lower.includes(kw.toLowerCase()));
  const bonus = Math.min(matchedKeywords.length, 5);
  score = Math.min(score + bonus, 25);

  const detail = `摘要 ${len} 字，命中 ${matchedKeywords.length} 个技术关键词，得分 ${score}/${25}`;
  return { name: '摘要质量', score, maxScore: 25, detail };
}

/** 技术深度评分 (25分) — 基于 score 字段。 */
function scoreTechDepth(entry: Record<string, unknown>): DimensionScore {
  const s = entry.score;
  if (typeof s !== 'number' || !Number.isFinite(s)) {
    return { name: '技术深度', score: 0, maxScore: 25, detail: '缺少 score 字段' };
  }
  const clamped = Math.max(1, Math.min(10, s));
  const score = Math.round((clamped / 10) * 25);
  return { name: '技术深度', score, maxScore: 25, detail: `score=${clamped} → ${score}/25` };
}

/** 格式规范评分 (20分) — 每项 4 分。 */
function scoreFormat(entry: Record<string, unknown>): DimensionScore {
  let score = 0;
  const issues: string[] = [];

  // id: 4分
  if (typeof entry.id === 'string' && entry.id.length > 0) {
    score += 4;
  } else {
    issues.push('id 缺失');
  }

  // title: 4分
  if (typeof entry.title === 'string' && entry.title.length > 0) {
    score += 4;
  } else {
    issues.push('title 缺失');
  }

  // source_url / sourceUrl: 4分
  const sourceUrl = (entry.source_url ?? entry.sourceUrl) as string | undefined;
  if (typeof sourceUrl === 'string' && /^https?:\/\//.test(sourceUrl)) {
    score += 4;
  } else {
    issues.push('source_url 缺失或格式错误');
  }

  // status: 4分
  const validStatuses = ['draft', 'review', 'published', 'archived', 'analyzed', 'pending'];
  if (typeof entry.status === 'string' && validStatuses.includes(entry.status)) {
    score += 4;
  } else {
    issues.push('status 缺失或无效');
  }

  // 时间戳 (id 中的 YYYYMMDD): 4分
  if (typeof entry.id === 'string') {
    const m = entry.id.match(/(\d{8})/);
    if (m) {
      const y = parseInt(m[1].slice(0, 4), 10);
      const mo = parseInt(m[1].slice(4, 6), 10);
      const d = parseInt(m[1].slice(6, 8), 10);
      if (y >= 2020 && y <= 2030 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        score += 4;
      } else {
        issues.push('id 中日期无效');
      }
    } else {
      issues.push('id 缺少日期部分');
    }
  } else {
    issues.push('id 缺失');
  }

  const detail = issues.length > 0 ? issues.join('；') : '全部合规';
  return { name: '格式规范', score, maxScore: 20, detail };
}

/** 标签精度评分 (15分)。 */
function scoreTags(entry: Record<string, unknown>): DimensionScore {
  const tags = entry.tags;
  if (!Array.isArray(tags) || tags.length === 0) {
    return { name: '标签精度', score: 0, maxScore: 15, detail: '缺少标签' };
  }

  // 标签数量评分 (最多 8分)
  let countScore = 0;
  if (tags.length >= 1 && tags.length <= 3) {
    countScore = 8;
  } else if (tags.length <= 5) {
    countScore = 5;
  } else {
    countScore = 2;
  }

  // 标签合法性评分 (最多 7分)
  const tagSet = new Set(STANDARD_TAGS);
  let validCount = 0;
  const lowerTags = tags.map(t => String(t).toLowerCase());
  for (const t of lowerTags) {
    if (tagSet.has(t)) {
      validCount++;
    }
  }
  const validRatio = tags.length > 0 ? validCount / tags.length : 0;
  const validScore = Math.round(validRatio * 7);

  const total = countScore + validScore;
  const detail = `${tags.length} 个标签，${validCount} 个在标准列表中，得分 ${total}/15`;
  return { name: '标签精度', score: total, maxScore: 15, detail };
}

/** 空洞词检测评分 (15分)。 */
function scoreBuzzwords(entry: Record<string, unknown>): DimensionScore {
  const fieldsToCheck = [
    String(entry.title ?? ''),
    String((entry.summary ?? entry.summary) ?? ''),
    String((entry.source_url ?? entry.sourceUrl) ?? ''),
  ];
  const text = fieldsToCheck.join(' ');

  let hits = 0;
  const found: string[] = [];

  // 检查中文空洞词
  for (const word of BUZZ_CN) {
    if (text.includes(word)) {
      hits++;
      found.push(word);
    }
  }

  // 检查英文空洞词
  const lower = text.toLowerCase();
  for (const word of BUZZ_EN) {
    // 使用正则匹配完整单词
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(text)) {
      hits++;
      found.push(word);
    }
  }

  let score = 15;
  if (hits === 1) score = 10;
  else if (hits === 2) score = 5;
  else if (hits >= 3) score = 0;

  const detail = hits === 0 ? '无空洞词' : `发现 ${hits} 个空洞词: ${found.join(', ')}`;
  return { name: '空洞词检测', score, maxScore: 15, detail };
}

// ── 等级评定 ─────────────────────────────────────────────────────────────────

function determineGrade(total: number): 'A' | 'B' | 'C' {
  if (total >= 80) return 'A';
  if (total >= 60) return 'B';
  return 'C';
}

// ── 进度条 ───────────────────────────────────────────────────────────────────

/** 输出单行进度条 (覆盖当前行)。 */
function renderProgress(current: number, total: number, label: string): void {
  const pct = total > 0 ? Math.round((current / total) * 100) : 100;
  const barWidth = 30;
  const filled = Math.round((pct / 100) * barWidth);
  const empty = barWidth - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const line = `\r进度 ${bar} ${String(pct).padStart(3)}% (${current}/${total}) ${label}`;
  process.stderr.write(line);
}

/** 清除进度条行。 */
function clearProgress(): void {
  process.stderr.write('\r\x1b[K');
}

// ── Glob 展开 ────────────────────────────────────────────────────────────────

function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

async function expandPattern(pattern: string): Promise<string[]> {
  const projectRoot = path.resolve(SCRIPT_DIR, '..');
  const candidates = [path.resolve(pattern), path.resolve(projectRoot, pattern)];

  function exists(p: string): boolean {
    try { return existsSync(p); } catch { return false; }
  }

  let resolved = '';
  if (path.isAbsolute(pattern)) {
    resolved = pattern;
  } else {
    resolved = candidates.find(p => exists(p)) || candidates[0];
  }

  if (exists(resolved) && (await fs.stat(resolved)).isDirectory()) {
    const entries = await fs.readdir(resolved);
    return (entries as string[])
      .filter((e: string) => e.endsWith('.json'))
      .map((e: string) => path.join(resolved, e))
      .sort();
  }

  if (!isGlobPattern(pattern)) {
    if (exists(resolved) && (await fs.stat(resolved)).isFile()) {
      return [resolved];
    }
    throw new Error(`文件不存在: ${pattern}`);
  }

  const norm = path.resolve(candidates[0]).replace(/\\/g, '/');
  const starIdx = norm.indexOf('*');
  const baseDir = path.resolve(norm.substring(0, norm.lastIndexOf('/', starIdx) + 1) || '.');
  const isRecursive = norm.includes('**');

  if (!exists(baseDir)) {
    throw new Error(`目录不存在: ${baseDir}`);
  }

  const results: string[] = [];
  await walkDir(baseDir, results, isRecursive);
  return [...new Set(results)].sort();
}

async function walkDir(dir: string, results: string[], recursive: boolean): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        await walkDir(fullPath, results, recursive);
      }
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push(fullPath);
    }
  }
}

// ── 文件处理 ─────────────────────────────────────────────────────────────────

async function scoreFile(filePath: string): Promise<QualityReport> {
  const errors: string[] = [];

  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      file: filePath,
      total: 0,
      dimensions: DIMENSIONS.map(d => ({ name: d.name, score: 0, maxScore: d.maxScore, detail: '文件无法读取' })),
      grade: 'C',
      errors: [`无法读取文件: ${msg}`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      file: filePath,
      total: 0,
      dimensions: DIMENSIONS.map(d => ({ name: d.name, score: 0, maxScore: d.maxScore, detail: 'JSON 解析错误' })),
      grade: 'C',
      errors: [`JSON 解析错误: ${msg}`],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      file: filePath,
      total: 0,
      dimensions: DIMENSIONS.map(d => ({ name: d.name, score: 0, maxScore: d.maxScore, detail: '根节点非对象' })),
      grade: 'C',
      errors: ['JSON 根节点不是对象'],
    };
  }

  const entry = parsed as Record<string, unknown>;
  const dims: DimensionScore[] = [
    scoreSummary(entry),
    scoreTechDepth(entry),
    scoreFormat(entry),
    scoreTags(entry),
    scoreBuzzwords(entry),
  ];

  const total = dims.reduce((sum, d) => sum + d.score, 0);
  const grade = determineGrade(total);

  return { file: filePath, total, dimensions: dims, grade, errors };
}

// ── 输出辅助 ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `
知识条目 5 维度质量评分。

用法:
  npx ts-node hooks/check_quality.ts <json_file> [json_file2 ...]
  npx ts-node hooks/check_quality.ts "knowledge/**/*.json"

选项:
  -h, --help    显示帮助信息

评分维度 (总分 100):
  摘要质量 25分 | 技术深度 25分 | 格式规范 20分 | 标签精度 15分 | 空洞词检测 15分

等级: A >= 80, B >= 60, C < 60
退出码: 存在 C 级返回 1，否则返回 0
` as const;

function gradeColor(grade: 'A' | 'B' | 'C'): string {
  if (grade === 'A') return `${C.green}${C.bold}A${C.reset}`;
  if (grade === 'B') return `${C.yellow}${C.bold}B${C.reset}`;
  return `${C.red}${C.bold}C${C.reset}`;
}

function printReport(report: QualityReport): void {
  process.stdout.write(`\n${report.file}\n`);
  process.stdout.write(`  总分: ${report.total}/100  等级: ${gradeColor(report.grade)}\n`);
  for (const dim of report.dimensions) {
    const bar = '█'.repeat(Math.round((dim.score / dim.maxScore) * 10)) + '░'.repeat(10 - Math.round((dim.score / dim.maxScore) * 10));
    process.stdout.write(`  ${dim.name.padEnd(8)} ${bar} ${dim.score}/${dim.maxScore}  ${dim.detail}\n`);
  }
  if (report.errors.length > 0) {
    for (const e of report.errors) {
      process.stdout.write(`  错误: ${e}\n`);
    }
  }
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stderr.write(HELP_TEXT);
    process.exit(args.length === 0 ? 1 : 0);
  }

  const files: string[] = [];
  for (const arg of args) {
    try {
      const expanded = await expandPattern(arg);
      files.push(...expanded);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`错误: ${msg}\n`);
      process.exit(1);
    }
  }

  if (files.length === 0) {
    process.stderr.write('错误: 没有找到 JSON 文件。\n');
    process.exit(1);
  }

  const uniqueFiles = [...new Set(files)];
  const totalFiles = uniqueFiles.length;

  // 逐个评分并显示进度条
  const reports: QualityReport[] = [];
  for (let i = 0; i < totalFiles; i++) {
    const label = path.basename(uniqueFiles[i]);
    renderProgress(i + 1, totalFiles, label);
    const report = await scoreFile(uniqueFiles[i]);
    reports.push(report);
  }
  clearProgress();

  // 输出结果
  process.stdout.write(`\n${'═'.repeat(60)}\n`);
  process.stdout.write('质量评分报告\n');
  process.stdout.write(`${'═'.repeat(60)}\n`);

  for (const report of reports) {
    printReport(report);
  }

  // 汇总
  const summary = {
    total: totalFiles,
    aCount: reports.filter(r => r.grade === 'A').length,
    bCount: reports.filter(r => r.grade === 'B').length,
    cCount: reports.filter(r => r.grade === 'C').length,
    avgScore: Math.round(reports.reduce((s, r) => s + r.total, 0) / totalFiles),
  };

  process.stdout.write(`\n${'─'.repeat(60)}\n`);
  process.stdout.write(`汇总: ${summary.total} 个文件 | ${C.green}A: ${summary.aCount}${C.reset} | ${C.yellow}B: ${summary.bCount}${C.reset} | ${C.red}C: ${summary.cCount}${C.reset} | 平均分: ${summary.avgScore}/100\n`);

  const hasC = summary.cCount > 0;
  process.exit(hasC ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`意外错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
