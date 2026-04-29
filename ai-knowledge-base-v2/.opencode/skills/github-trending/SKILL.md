---
name: github-trending
description: 当需要采集 GitHub 热门开源项目时使用此技能
allowed-tools:
  - Read
  - Grep
  - Glob
  - WebFetch
---

# GitHub Trending 技能

## 使用场景

当需要采集 GitHub 热门开源项目，并沉淀为知识库原始数据时，使用此技能。适用于每日榜单采集、AI 方向开源项目筛选、热门仓库追踪等场景。

## 执行步骤

1. 搜索热门仓库（GitHub API）
   通过 GitHub API 获取当前热门开源仓库，优先覆盖 Trending 语义下的高热度候选项目。

2. 提取信息
   从返回结果中提取项目基础信息，包括仓库名、链接、星标数、主要语言和 topics。

3. 过滤
   仅保留 AI、LLM、Agent 相关项目；排除 `Awesome` 列表、纯资源汇总、导航集合和明显非目标领域项目。

4. 去重
   基于仓库唯一链接或标准仓库标识去重，避免同一项目重复进入结果集。

5. 撰写中文摘要
   按统一公式生成摘要：`项目名 + 做什么 + 为什么值得关注`。
   摘要需简洁、中文表达自然、避免空话和模板化描述。

6. 排序取 Top15
   按热度优先排序，取前 15 个项目作为最终结果。

7. 输出 JSON 到 `knowledge/raw/github-trending-YYYY-MM-DD.json`
   将结果保存为标准 JSON 文件，供后续分析 Agent 直接消费。

## 注意事项

- 必须基于真实可验证的 GitHub 数据，不能编造项目或热度。
- `Awesome`、教程索引、资源导航类仓库默认排除，除非任务明确要求保留。
- 如果 topics 缺失，可结合仓库标题和描述辅助判断，但不能脱离事实扩写。
- 摘要必须是中文，且要体现“做什么”和“为什么值得关注”。
- 输出结果应保持结构稳定，便于后续 `analyzer` 或其他处理流程直接读取。
- 若不足 15 个合格项目，应如实输出实际数量，不要凑数。

## 输出格式

输出文件路径：`knowledge/raw/github-trending-YYYY-MM-DD.json`

```json
{
  "source": "github",
  "skill": "github-trending",
  "collected_at": "2026-04-17T00:00:00Z",
  "items": [
    {
      "name": "example-repo",
      "url": "https://github.com/org/example-repo",
      "summary": "example-repo 是一个用于构建 AI Agent 工作流的开源项目，支持快速编排多步骤任务，因此值得持续关注。",
      "stars": 12345,
      "language": "TypeScript",
      "topics": ["ai", "agent", "workflow"]
    }
  ]
}
```
