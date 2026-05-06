#!/usr/bin/env ts-node-script
/**
 * 校验知识条目 JSON 文件。
 *
 * 根据项目 schema 检查 JSON 结构，包括必填字段、ID 格式、状态枚举、URL 格式、摘要长度及可选字段。
 *
 * 用法: npx ts-node hooks/validate_json.ts <json_file> [json_file2 ...]
 * 相对路径基于 cwd 查找，不存在时尝试脚本所在目录的父目录。
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync } from 'node:fs';

/** 脚本所在目录，用于解析相对路径。 */
const SCRIPT_DIR = path.dirname(path.resolve(process.argv[1]));

// ── 类型定义 ─────────────────────────────────────────────────────────────────

/** 合法的知识条目 JSON 文件 schema。 */
interface KnowledgeEntry {
  id: string;
  title: string;
  sourceUrl: string;
  summary: string;
  tags: string[];
  status: string;
  score?: number;
  audience?: string;
}

/** 单条校验失败信息。 */
interface ValidationError {
  file: string;
  field: string;
  message: string;
}

/** 单个文件的校验结果。 */
interface ValidationResult {
  file: string;
  valid: boolean;
  errors: ValidationError[];
}

/** 所有文件的汇总统计。 */
interface Summary {
  total: number;
  passed: number;
  failed: number;
  totalErrors: number;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** "status" 字段允许的枚举值。 */
const VALID_STATUSES = ['draft', 'review', 'published', 'archived', 'analyzed'] as const;

/** 可选字段 "audience" 允许的枚举值。 */
const VALID_AUDIENCES = ['beginner', 'intermediate', 'advanced'] as const;

/** ID 格式：{YYYYMMDD}-{source}-{slug}，例如 20260416-github_trending-ai-animation。 */
const ID_REGEX = /^\d{8}-[a-z0-9]+(?:[-_][a-z0-9]+)*$/i;

/** 基础 URL 检查 — 必须以 http:// 或 https:// 开头。 */
const URL_REGEX = /^https?:\/\/.+/;

/** 每个知识条目都必须包含的字段。 */
const REQUIRED_FIELDS = ['id', 'title', 'sourceUrl', 'summary', 'tags', 'status'] as const;

// ── 校验器 ───────────────────────────────────────────────────────────────────

/**
 * 校验单个必填字段的存在性、类型和规则。
 * 返回可能为空的错误数组。
 */
function validateRequiredField(
  entry: Record<string, unknown>,
  field: typeof REQUIRED_FIELDS[number],
  file: string,
): ValidationError[] {
  const value = entry[field];

  // 字段缺失或为 null — 直接返回错误，不再继续检查
  if (value === undefined || value === null) {
    return [{ file, field, message: `缺少必填字段 "${field}"` }];
  }

  const errors: ValidationError[] = [];

  switch (field) {
    case 'id': {
      if (typeof value !== 'string') {
        errors.push({ file, field, message: `必须是字符串，实际为 ${typeof value}` });
      } else if (!ID_REGEX.test(value)) {
        errors.push({
          file,
          field,
          message: `"${value}" 不符合 {YYYYMMDD}-{source}-{slug} 格式（例如 20260416-github_trending-ai-animation）`,
        });
      }
      break;
    }
    case 'title': {
      if (typeof value !== 'string') {
        errors.push({ file, field, message: `必须是字符串，实际为 ${typeof value}` });
      }
      break;
    }
    case 'sourceUrl': {
      if (typeof value !== 'string') {
        errors.push({ file, field, message: `必须是字符串，实际为 ${typeof value}` });
      } else if (!URL_REGEX.test(value)) {
        errors.push({ file, field, message: `"${value}" 不是有效的 URL（必须以 http:// 或 https:// 开头）` });
      }
      break;
    }
    case 'summary': {
      if (typeof value !== 'string') {
        errors.push({ file, field, message: `必须是字符串，实际为 ${typeof value}` });
      } else if (value.length < 20) {
        errors.push({ file, field, message: `摘要过短（${value.length} 字），最少需要 20 字` });
      }
      break;
    }
    case 'tags': {
      if (!Array.isArray(value)) {
        errors.push({ file, field, message: `必须是数组，实际为 ${typeof value}` });
      } else if (value.length === 0) {
        errors.push({ file, field, message: '至少需要 1 个标签' });
      } else {
        // 每个元素必须是字符串
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] !== 'string') {
            errors.push({ file, field, message: `tags[${i}] 必须是字符串，实际为 ${typeof value[i]}` });
          }
        }
      }
      break;
    }
    case 'status': {
      if (typeof value !== 'string') {
        errors.push({ file, field, message: `必须是字符串，实际为 ${typeof value}` });
      } else if (!(VALID_STATUSES as readonly string[]).includes(value)) {
        errors.push({ file, field, message: `"${value}" 无效，必须是以下之一: ${VALID_STATUSES.join(', ')}` });
      }
      break;
    }
  }

  return errors;
}

/**
 * 校验可选字段：score（1-10）和 audience（beginner/intermediate/advanced）。
 */
function validateOptionalFields(entry: Record<string, unknown>, file: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // 可选：数字评分 1-10
  if (entry.score !== undefined) {
    if (typeof entry.score !== 'number' || !Number.isFinite(entry.score)) {
      errors.push({ file, field: 'score', message: `必须是有限数字，实际为 ${typeof entry.score}` });
    } else if (entry.score < 1 || entry.score > 10) {
      errors.push({ file, field: 'score', message: `必须在 1-10 之间，实际为 ${entry.score}` });
    }
  }

  // 可选：目标受众级别
  if (entry.audience !== undefined) {
    if (typeof entry.audience !== 'string') {
      errors.push({ file, field: 'audience', message: `必须是字符串，实际为 ${typeof entry.audience}` });
    } else if (!(VALID_AUDIENCES as readonly string[]).includes(entry.audience)) {
      errors.push({
        file,
        field: 'audience',
        message: `"${entry.audience}" 无效，必须是以下之一: ${VALID_AUDIENCES.join(', ')}`,
      });
    }
  }

  return errors;
}

// ── Glob 展开 ────────────────────────────────────────────────────────────────

/** 判断字符串是否包含类 shell 的 glob 通配符。 */
function isGlobPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * 展开为 .json 文件列表。支持文件、目录、*.json / **\/*.json 等 glob。
 *
 * 相对路径优先基于当前工作目录查找，不存在时尝试基于脚本所在目录的父目录。
 */
async function expandPattern(pattern: string): Promise<string[]> {
  const projectRoot = path.resolve(SCRIPT_DIR, '..');
  const candidates = [path.resolve(pattern), path.resolve(projectRoot, pattern)];

  function exists(p: string): boolean {
    try { return existsSync(p); } catch { return false; }
  }

  // 查找首个存在的候选路径
  let resolved = '';
  if (path.isAbsolute(pattern)) {
    resolved = pattern;
  } else {
    resolved = candidates.find(p => exists(p)) || candidates[0];
  }

  // 如果是目录，列出其中 .json 文件
  if (exists(resolved) && (await fs.stat(resolved)).isDirectory()) {
    const entries = await fs.readdir(resolved);
    return (entries as string[])
      .filter((e: string) => e.endsWith('.json'))
      .map((e: string) => path.join(resolved, e))
      .sort();
  }

  // 普通文件
  if (!isGlobPattern(pattern)) {
    if (exists(resolved) && (await fs.stat(resolved)).isFile()) {
      return [resolved];
    }
    throw new Error(`文件不存在: ${pattern}`);
  }

  // Glob：在 cwd 下展开
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

/** 递归遍历目录树，收集所有 .json 文件路径。 */
async function walkDir(dir: string, results: string[], recursive: boolean): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 静默跳过无法读取的目录
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

/**
 * 读取、解析并校验单个 JSON 文件。
 * 返回包含所有错误的 ValidationResult。
 */
async function validateFile(filePath: string): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  // 第 1 步：从磁盘读取文件
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ file: filePath, field: '(file)', message: `无法读取文件: ${msg}` });
    return { file: filePath, valid: false, errors };
  }

  // 第 2 步：解析 JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push({ file: filePath, field: '(json)', message: `JSON 解析错误: ${msg}` });
    return { file: filePath, valid: false, errors };
  }

  // 第 3 步：必须是顶层对象（不能是数组或原始类型）
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push({ file: filePath, field: '(root)', message: 'JSON 根节点必须是对象，不能是数组或原始类型' });
    return { file: filePath, valid: false, errors };
  }

  const entry = parsed as Record<string, unknown>;

  // 第 4 步：检查所有必填字段
  for (const field of REQUIRED_FIELDS) {
    errors.push(...validateRequiredField(entry, field, filePath));
  }

  // 第 5 步：检查可选字段
  errors.push(...validateOptionalFields(entry, filePath));

  return { file: filePath, valid: errors.length === 0, errors };
}

// ── 输出辅助 ─────────────────────────────────────────────────────────────────

const HELP_TEXT = `
校验知识条目 JSON 文件。

用法:
  npx ts-node hooks/validate_json.ts <json_file> [json_file2 ...]
  npx ts-node hooks/validate_json.ts "knowledge/**/*.json"

选项:
  -h, --help    显示帮助信息

校验项:
  - JSON 解析是否合法
  - 必填字段: id, title, sourceUrl, summary, tags, status
  - 可选字段: score (1-10), audience (beginner/intermediate/advanced)
  - ID 格式: {YYYYMMDD}-{source}-{slug}  (例如 20260416-github_trending-ai-animation)
  - status 必须是以下之一: draft, review, published, archived, analyzed
  - URL 必须以 http:// 或 https:// 开头
  - 摘要至少 20 字
  - 标签至少 1 个
` as const;

/** 将单条校验错误输出到 stderr。 */
function printError(error: ValidationError): void {
  process.stderr.write(`  [${error.field}] ${error.message}\n`);
}

// ── 入口函数 ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 处理 --help / 无参数
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stderr.write(HELP_TEXT);
    process.exit(args.length === 0 ? 1 : 0);
  }

  // 将所有参数展开为 .json 文件路径的扁平列表
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
    process.stderr.write('错误: 没有找到需要校验的 JSON 文件。\n');
    process.exit(1);
  }

  // 并发校验所有文件
  const uniqueFiles = [...new Set(files)];
  const results = await Promise.all(uniqueFiles.map(f => validateFile(f)));

  // 汇总统计
  const summary: Summary = {
    total: results.length,
    passed: results.filter(r => r.valid).length,
    failed: results.filter(r => !r.valid).length,
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
  };

  // 输出所有失败详情
  let hasFailure = false;
  for (const result of results) {
    if (!result.valid) {
      hasFailure = true;
      process.stderr.write(`\n失败  ${result.file}\n`);
      for (const err of result.errors) {
        printError(err);
      }
    }
  }

  // 输出汇总行
  const border = '─'.repeat(50);
  process.stderr.write(`\n${border}\n`);
  process.stderr.write(
    `汇总: ${summary.total} 个文件, ${summary.passed} 通过, ${summary.failed} 失败, ${summary.totalErrors} 个错误\n`,
  );

  process.exit(hasFailure ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`意外错误: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
