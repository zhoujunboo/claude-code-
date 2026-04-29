---
name: mk-trending
description: Collects the top 20 Imooc coding courses from HTML pages, filters AI-related entries, and prints a validated JSON array to stdout. Use when the user mentions 慕课网, imooc, 实战项目 Top 20, AI 课程榜单, mk-trending, skill-invoke, or wants AI course data in `[name, url, stars, topics, description]` format without using an API.
allowed-tools:
  - Bash
  - Read
  - Glob
  - WebFetch
---

# Mk Trending

## 使用场景

当需要抓取慕课网实战项目 Top 20，并过滤出 AI、LLM、Agent、ML 相关课程时，使用此技能。

## 快速开始

运行：`node .opencode/skills/mk-trending/scripts/mk-trending.mjs`

脚本会：

1. 抓取慕课网实战课列表页前 20 个项目。
2. 按 `ai/llm/agent/ml` 及相关关键词过滤 AI 项目。
3. 补抓课程详情页描述。
4. 校验输出是否符合 `[name, url, stars, topics, description]` 结构。
5. 仅向 stdout 输出 JSON 数组。

## 工作流

1. 优先直接运行脚本，不要改成调用 API。
2. 若抓取失败或校验失败，返回空数组 `[]`，不要抛异常。
3. 若需要人工检查，执行 `skill-invoke mk-trending` 后确认输出是合法 JSON，且每个对象字段完整。

## 注意事项

- 数据源固定为慕课网 HTML 页面。
- `stars` 字段使用课程报名人数。
- `topics` 由标题和描述中的关键词推断。
- 不做去重，不写文件，不入库。
