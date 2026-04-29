# AI 知识库助手项目 - TypeScript Agents 文档

## 1. 项目定位

本项目用于构建一个面向 AI/LLM/Agent 资讯的知识库系统，围绕结构化知识条目数据进行接入、整理、分析与工具化处理。

当前协作默认以 TypeScript 实现为准。所有 Agent、脚本、工具与数据处理逻辑，优先遵循类型安全、可维护性和模块化原则。

## 2. 技术方向

- **TypeScript**：主导开发语言，用于数据建模、工具函数、Agent 脚本与 API 客户端
- **ES Modules**：统一使用标准模块体系
- **Fetch API**：优先用于 HTTP 请求封装
- **OpenCode + 大模型**：用于辅助生成、整理和校验知识库内容

## 3. Agent 分工

| Agent | 职责 | 主要输出 |
|------|------|----------|
| 内容接入 Agent | 对接知识条目数据源，完成拉取、校验、标准化 | 可消费的数据对象或 JSON |
| 分析 Agent | 对摘要、标签、来源、分发状态等信息进行结构化处理 | 标准化字段、统计结果、分析数据 |
| 工具 Agent | 实现 API Client、格式化函数、类型定义、通用工具 | `types`、`utils`、请求封装 |

## 4. 编码规范

项目开发规范统一以 `specs/coding-stabdards.md` 为准。

补充要求：

- 新增代码默认使用 TypeScript。
- 若外部数据字段与内部约定不一致，必须在适配层完成转换。
- 输出应优先可运行、可维护、可继续扩展。

## 5. 推荐目录结构

```text
ai-knowledge-base/
├── .agents/                 # Agent 配置与能力定义
├── .opencode/               # OpenCode 配置
├── knowledge/               # 知识条目数据
├── specs/                   # 规范与说明文档
├── utils/                   # TypeScript 工具与 API Client
├── AGENTS.md                # Agent 协作说明
└── skills-lock.json         # 技能锁定文件
```

目录以当前仓库现状为准；新增内容优先落在现有结构内，避免无必要扩目录。

## 6. 知识条目 TypeScript 类型约定

```ts
export type KnowledgeSourceType = 'github_trending' | 'hackernews' | 'blog';

export type KnowledgeStatus = 'pending' | 'analyzed' | 'published' | 'archived';

export interface KnowledgeArticle {
  id: string;
  title: string;
  sourceUrl: string;
  sourceType: KnowledgeSourceType;
  summary: string;
  tags: string[];
  status: KnowledgeStatus;
}
```

约定说明：内部统一使用 `camelCase`；外部 `snake_case` 字段必须在适配层转换。

## 7. 工程红线

1. 禁止提交包含密钥、Token、Cookie、私有链接的代码或示例数据。
2. 禁止直接硬编码环境配置、接口地址或鉴权信息。
3. 禁止使用 `any` 回避类型问题，除非有明确边界隔离并附带说明。
4. 禁止忽略空数据、请求失败、请求超时等异常路径。
5. 禁止把外部原始响应直接传入业务逻辑，必须经过类型约束与字段映射。
6. 禁止引入无必要的复杂抽象；优先做小而清晰的实现。
7. 禁止修改与当前任务无关的现有逻辑、目录和数据结构。

## 8. Agent 执行要求

- 在动手前先阅读相关文件，基于现有结构做最小修改
- 新增代码优先补齐类型，再补齐实现
- 若发现外部字段命名与 TypeScript 约定不一致，应在适配层修正
- 输出应优先可运行、可维护、可继续扩展
- 若需要示例代码，默认提供 TypeScript 版本，而不是 Python 版本

---

*最后更新：2026-04-16*
