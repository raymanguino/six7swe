import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { PortfolioData, PortfolioProfileData, ContentSectionData } from '../types/portfolio';
import {
  getMcpPortfolioToolName,
  getMcpRequestHeaders,
  getMcpResumeToolName,
  getMcpStdioArgs,
} from '../config/portfolioMcp';

function textFromToolContent(
  content: Array<{ type: string; text?: string; resource?: { blob?: string; text?: string } }>,
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJsonFromToolResult(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Empty MCP tool response');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new Error('MCP tool did not return JSON');
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function normalizeProfile(p: Record<string, unknown>, index: number): PortfolioProfileData {
  return {
    id: typeof p.id === 'number' ? p.id : index,
    name: String(p.name ?? ''),
    title: String(p.title ?? ''),
    email: String(p.email ?? ''),
    phone: p.phone != null ? String(p.phone) : null,
    location: p.location != null ? String(p.location) : null,
    linkedinUrl: p.linkedinUrl != null ? String(p.linkedinUrl) : p.linkedin_url != null ? String(p.linkedin_url) : null,
    githubUrl: p.githubUrl != null ? String(p.githubUrl) : p.github_url != null ? String(p.github_url) : null,
    summary: p.summary != null ? String(p.summary) : null,
    skills: toStringArray(p.skills),
    experience: Array.isArray(p.experience) ? (p.experience as PortfolioProfileData['experience']) : [],
    projects: Array.isArray(p.projects) ? (p.projects as PortfolioProfileData['projects']) : [],
    fullResumeText: String(p.fullResumeText ?? p.full_resume_text ?? ''),
    resumeFilename:
      p.resumeFilename != null
        ? String(p.resumeFilename)
        : p.resume_filename != null
          ? String(p.resume_filename)
          : null,
  };
}

function normalizeSections(raw: unknown): ContentSectionData[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((item, i) => {
    const s = item as Record<string, unknown>;
    return {
      id: typeof s.id === 'number' ? s.id : i + 1,
      filename: String(s.filename ?? `section-${i + 1}`),
      content: String(s.content ?? ''),
      sortOrder: typeof s.sortOrder === 'number' ? s.sortOrder : typeof s.sort_order === 'number' ? s.sort_order : i,
    };
  });
}

export function parsePortfolioPayload(data: unknown): PortfolioData {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid portfolio payload');
  }
  const obj = data as Record<string, unknown>;
  const profileRaw = obj.profile ?? obj.portfolio_profile ?? obj.portfolioProfile;
  const sectionsRaw = obj.contentSections ?? obj.content_sections ?? obj.sections;

  const profile =
    profileRaw && typeof profileRaw === 'object'
      ? normalizeProfile(profileRaw as Record<string, unknown>, 1)
      : null;

  return {
    profile,
    contentSections: normalizeSections(sectionsRaw),
  };
}

async function withMcpSdkClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const urlStr = process.env.MCP_PORTFOLIO_URL?.trim();
  const command = process.env.MCP_PORTFOLIO_COMMAND?.trim();

  let transport: StreamableHTTPClientTransport | StdioClientTransport;

  if (urlStr) {
    const url = new URL(urlStr);
    const headers = getMcpRequestHeaders();
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    });
  } else if (command) {
    const args = getMcpStdioArgs();
    transport = new StdioClientTransport({
      command,
      args,
      stderr: 'inherit',
    });
  } else {
    throw new Error('MCP_PORTFOLIO_URL or MCP_PORTFOLIO_COMMAND must be set when PORTFOLIO_DATA_SOURCE=mcp');
  }

  const client = new Client({ name: 'six7swe-backend', version: '1.0.0' });
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

export async function fetchPortfolioFromMcp(): Promise<PortfolioData> {
  const toolName = getMcpPortfolioToolName();
  return withMcpSdkClient(async (client) => {
    const result = await client.callTool({ name: toolName, arguments: {} });
    if (result.isError) {
      throw new Error(`MCP tool ${toolName} failed`);
    }
    const text = textFromToolContent(result.content as Parameters<typeof textFromToolContent>[0]);
    const parsed = parseJsonFromToolResult(text);
    return parsePortfolioPayload(parsed);
  });
}

function bufferFromContent(
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    resource?: { blob?: string; text?: string; mimeType?: string };
  }>,
): Buffer | null {
  for (const block of content) {
    if (block.type === 'resource' && block.resource) {
      const r = block.resource;
      if ('blob' in r && typeof r.blob === 'string') {
        return Buffer.from(r.blob, 'base64');
      }
      if ('text' in r && typeof r.text === 'string') {
        const t = r.text.trim();
        if (t.startsWith('%PDF') || t.includes('JVBER')) {
          return Buffer.from(t, 'base64');
        }
      }
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const t = block.text.trim();
      try {
        const j = JSON.parse(t) as { data?: string; base64?: string; pdf?: string };
        const b64 = j.data ?? j.base64 ?? j.pdf;
        if (typeof b64 === 'string') {
          return Buffer.from(b64, 'base64');
        }
      } catch {
        if (t.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(t.replace(/\s/g, ''))) {
          return Buffer.from(t.replace(/\s/g, ''), 'base64');
        }
      }
    }
    if (block.type === 'image' && typeof block.data === 'string') {
      return Buffer.from(block.data, 'base64');
    }
  }
  return null;
}

export async function fetchResumePdfFromMcp(filename: string): Promise<Buffer | null> {
  const toolName = getMcpResumeToolName();
  return withMcpSdkClient(async (client) => {
    try {
      const result = await client.callTool({
        name: toolName,
        arguments: { filename, name: filename },
      });
      if (result.isError) {
        return null;
      }
      return bufferFromContent(result.content as Parameters<typeof bufferFromContent>[0]);
    } catch {
      return null;
    }
  });
}
