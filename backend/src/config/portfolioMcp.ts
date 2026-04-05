/**
 * Portfolio data can be loaded from Postgres (Drizzle) or from an MCP server.
 * Set PORTFOLIO_DATA_SOURCE=mcp and configure MCP_* variables to use MCP.
 */

export type PortfolioDataSource = 'db' | 'mcp';

export function getPortfolioDataSource(): PortfolioDataSource {
  const v = (process.env.PORTFOLIO_DATA_SOURCE || 'db').toLowerCase();
  if (v === 'mcp') return 'mcp';
  return 'db';
}

export function isPortfolioMcpEnabled(): boolean {
  return getPortfolioDataSource() === 'mcp' && isMcpConnectionConfigured();
}

/** True when streamable HTTP URL or stdio command is set. */
export function isMcpConnectionConfigured(): boolean {
  const url = process.env.MCP_PORTFOLIO_URL?.trim();
  const cmd = process.env.MCP_PORTFOLIO_COMMAND?.trim();
  return Boolean(url || cmd);
}

/** When true (default), attach MCP servers to chat / job-match / fitcheck agents. */
export function isAgentMcpEnabled(): boolean {
  if (!isPortfolioMcpEnabled()) return false;
  const v = (process.env.AGENT_MCP_ENABLED ?? 'true').toLowerCase();
  return v !== 'false' && v !== '0';
}

export function getMcpPortfolioToolName(): string {
  return process.env.MCP_PORTFOLIO_TOOL_GET?.trim() || 'get_portfolio';
}

export function getMcpResumeToolName(): string {
  return process.env.MCP_RESUME_TOOL_GET?.trim() || 'get_resume_pdf';
}

export function getMcpRequestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const bearer = process.env.MCP_PORTFOLIO_BEARER_TOKEN?.trim();
  if (bearer) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  const raw = process.env.MCP_PORTFOLIO_HEADERS_JSON?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      Object.assign(headers, parsed);
    } catch {
      // ignore invalid JSON
    }
  }
  return headers;
}

export function getMcpStdioArgs(): string[] {
  const raw = process.env.MCP_PORTFOLIO_ARGS_JSON?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
