import { MCPServerStreamableHttp, MCPServerStdio, type MCPServer } from '@openai/agents';
import { getMcpRequestHeaders, getMcpStdioArgs, isAgentMcpEnabled } from '../config/portfolioMcp';

/**
 * OpenAI Agents SDK MCP server handles (same endpoint/command as portfolio data MCP).
 * Used when AGENT_MCP_ENABLED is true and PORTFOLIO_DATA_SOURCE=mcp.
 */
export function createPortfolioMcpServers(): MCPServer[] {
  if (!isAgentMcpEnabled()) {
    return [];
  }

  const url = process.env.MCP_PORTFOLIO_URL?.trim();
  const command = process.env.MCP_PORTFOLIO_COMMAND?.trim();

  if (url) {
    const headers = getMcpRequestHeaders();
    return [
      new MCPServerStreamableHttp({
        name: 'portfolio_mcp',
        url,
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
        cacheToolsList: true,
      }),
    ];
  }

  if (command) {
    const args = getMcpStdioArgs();
    return [
      new MCPServerStdio({
        name: 'portfolio_mcp',
        command,
        args,
        cacheToolsList: true,
      }),
    ];
  }

  return [];
}

export async function withPortfolioMcpServers<T>(fn: (servers: MCPServer[]) => Promise<T>): Promise<T> {
  const servers = createPortfolioMcpServers();
  if (servers.length === 0) {
    return fn([]);
  }
  for (const s of servers) {
    await s.connect();
  }
  try {
    return await fn(servers);
  } finally {
    await Promise.all(servers.map((s) => s.close()));
  }
}
