import type { Plugin } from "@opencode-ai/plugin";
import * as path from "node:path";

const plugin: Plugin = async (input) => {
  return {
    // Agent 执行工具后触发
    "tool.execute.after": async (toolInput, toolOutput) => {
      const { tool, args } = toolInput;
      // 仅关注写入/编辑知识条目 JSON 的操作
      if (tool !== "write" && tool !== "edit") return;

      const filePath: unknown = args.file_path ?? args.filePath;
      if (typeof filePath !== "string") return;

      // 只处理 knowledge/articles/ 目录下的 JSON 文件
      const normalised = filePath.replace(/\\/g, "/");
      if (!normalised.includes("knowledge/articles/") || !normalised.endsWith(".json")) return;

      // 拼接绝对路径（相对路径基于 worktree 根目录）
      const resolved = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(input.worktree, filePath);

      try {
        // 用 Bun Shell 执行校验脚本，.nothrow() 防止非零退出码抛异常
        const result = await input.$`npx ts-node hooks/validate_json.ts ${resolved}`.nothrow();
        if (result.exitCode !== 0) {
          // 校验失败时将错误信息注入工具输出
          toolOutput.title = `⚠️ 校验失败: ${filePath}`;
          toolOutput.output = result.stderr?.toString() ?? "";
        }
      } catch (err) {
        // 捕获 shell 调用异常，避免阻塞 Agent
        toolOutput.title = "❌ 校验脚本异常";
        toolOutput.output = err instanceof Error ? err.message : String(err);
      }
    },
  };
};

export default plugin;
