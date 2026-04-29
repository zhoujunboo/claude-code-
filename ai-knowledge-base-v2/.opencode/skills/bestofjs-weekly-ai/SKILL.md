---
name: bestofjs-weekly-ai
description: Collects AI-related projects from the Best of JS weekly ranking, filters unrelated entries, writes a stable Top 15 JSON dataset into `knowledge/raw/`, and supports collector-style sourcing for the AI knowledge-base pipeline. Use when the user mentions Best of JS, bestofjs, weekly stars, stars added in the last 7 days, 最近7天涨星, 周榜, 热门 JS 项目, AI 项目榜单, AI 开源项目, JavaScript AI 项目, top 15, top15, JSON 榜单, 原始采集数据, knowledge/raw, collector, 抓榜单, 采集周榜, 过滤 AI 相关, 输出 JSON, 或要把榜单结果沉淀到知识库原始数据中。
allowed-tools:
  - Read
  - Glob
  - Bash
---

# Best of JS Weekly AI

## 使用场景

当需要从 Best of JS 周榜采集 AI 相关热门项目，并整理为结构稳定的 JSON 原始数据时，使用此技能。

它对应 `specs/agents-collaboration.md` 中的 `collector` 职责变体，适合在知识库流水线里充当“榜单采集 -> AI 过滤 -> raw 落盘”的上游步骤。

## 执行步骤

1. 运行脚本：`node .opencode/skills/bestofjs-weekly-ai/scripts/collect-bestofjs-weekly-ai.mjs`
2. 脚本会抓取 Best of JS `sort=weekly` 页面，按榜单顺序解析项目。
3. 结合 Best of JS 标签、项目标题、卡片描述和仓库链接过滤掉非 AI 项目。
4. 仅保留前 15 个 AI 相关项目，并生成约 50 字中文描述。
5. 输出 JSON 到 `knowledge/raw/bestofjs-weekly-ai-YYYY-MM-DD.json`。

## 注意事项

- 必须基于真实榜单页面中的可验证信息，不能编造项目或热度。
- 优先保留 AI、LLM、Agent、Prompt、Inference、AI Builder、AI Workflow 相关项目。
- 默认排除纯前端 UI、图表、CMS、通用框架等与 AI 无直接关系的项目。
- 若合格项目不足 15 个，应如实输出实际数量。
- 输出前应检查 JSON 可解析且字段结构稳定。
- 输出文件应可被下游分析流程直接消费，因此字段命名和结构不要随意漂移。

## 输出格式

```json
{
  "source": "bestofjs",
  "skill": "bestofjs-weekly-ai",
  "collectedAt": "2026-04-17T00:00:00.000Z",
  "ranking": {
    "period": "last_7_days",
    "sort": "weekly",
    "limit": 15,
    "filter": "ai_related_only"
  },
  "items": [
    {
      "rank": 1,
      "name": "OpenClaw",
      "bestofjsUrl": "https://bestofjs.org/projects/openclaw",
      "githubUrl": "https://github.com/openclaw/openclaw",
      "starsPerDay": 796.1,
      "estimatedWeeklyStars": 5573,
      "summary": "一个面向本机运行场景的开源 AI Agent 平台，强调聊天驱动执行与技能演化，适合自动化助手实验。"
    }
  ]
}
```
