/**
 * 3d 插件 MCP 工具汇总。
 * ------------------------------------------------------------------
 * 文件级工具在 `mcp.js`，领域级在 `mcp-3d-tools.js`。入口 `boot.js` 调
 * `installMcpBridge({ extraTools: d3McpTools() })` 一并挂给宿主。
 */
import { mcpToolNames } from './mcp.js';
import { d3McpTools } from './mcp-3d-tools.js';

export { d3McpTools };

/** 完整工具名清单（文件级 + 领域级），顺序须与 plugin.json 的 mcp.expose 一致。 */
export function d3ToolNames() {
  return [...mcpToolNames(), ...d3McpTools().map((tool) => tool.name)];
}
