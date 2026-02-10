import { FastifyRequest, FastifyReply } from 'fastify';
import fs from 'fs';
import path from 'path';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getPortfolioData } from '../../services/portfolioService';

const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'portfolio-files';

let supabaseClient: SupabaseClient | null = null;

function getSupabaseClient(): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL;
  // Prefer secret key (sb_secret_...); fall back to legacy service_role JWT
  const secretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !secretKey) return null;
  supabaseClient = createClient(url, secretKey);
  return supabaseClient;
}

export async function resumeHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profile } = await getPortfolioData();
    const filename = profile?.resumeFilename || 'resume.pdf';
    const localPath = path.join(__dirname, '..', '..', '..', 'public', filename);

    // Try Supabase Storage first if configured
    const supabase = getSupabaseClient();
    if (supabase) {
      const { data, error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .download(filename);
      if (!error && data) {
        const buffer = Buffer.from(await data.arrayBuffer());
        reply.header('Content-Type', 'application/pdf');
        reply.header('Content-Disposition', `attachment; filename="${filename}"`);
        return reply.send(buffer);
      }
    }

    // Fallback to local file
    if (fs.existsSync(localPath)) {
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(localPath));
    }

    return reply.code(404).send({ error: 'Resume not found' });
  } catch (error) {
    _request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}
