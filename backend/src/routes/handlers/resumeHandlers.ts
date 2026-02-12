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
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/fbd253c4-3e7e-4ffa-ba01-a72af7a8b319',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'A',location:'backend/src/routes/handlers/resumeHandlers.ts:resumeHandler:entry',message:'resumeHandler entry',data:{cwd:process.cwd(),hasSupabaseUrl:!!process.env.SUPABASE_URL,hasSupabaseSecretKey:!!(process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY),bucket:process.env.SUPABASE_STORAGE_BUCKET||'portfolio-files'},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  try {
    const { profile } = await getPortfolioData();
    const filename = profile?.resumeFilename || 'resume.pdf';
    const publicDir = path.join(process.cwd(), 'public');
    const localPath = path.join(publicDir, filename);
    const fallbackFilename = 'resume.pdf';
    const fallbackLocalPath = path.join(publicDir, fallbackFilename);

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/fbd253c4-3e7e-4ffa-ba01-a72af7a8b319',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'C',location:'backend/src/routes/handlers/resumeHandlers.ts:resumeHandler:portfolio',message:'resolved resume filenames/paths',data:{profileResumeFilename:profile?.resumeFilename||null,filename,localPath,fallbackFilename,fallbackLocalPath},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

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

      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/fbd253c4-3e7e-4ffa-ba01-a72af7a8b319',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'B',location:'backend/src/routes/handlers/resumeHandlers.ts:resumeHandler:supabase',message:'supabase download miss',data:{filename,hasData:!!data,error:error?{name:(error as any).name,message:(error as any).message,status:(error as any).status}:null},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      // Fallback to resume.pdf in Storage (common deploy convention) while preserving the
      // DB-provided download name via Content-Disposition.
      if (filename !== fallbackFilename) {
        const { data: fallbackData, error: fallbackError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .download(fallbackFilename);
        if (!fallbackError && fallbackData) {
          const buffer = Buffer.from(await fallbackData.arrayBuffer());
          reply.header('Content-Type', 'application/pdf');
          reply.header('Content-Disposition', `attachment; filename="${filename}"`);
          return reply.send(buffer);
        }

        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/fbd253c4-3e7e-4ffa-ba01-a72af7a8b319',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'B',location:'backend/src/routes/handlers/resumeHandlers.ts:resumeHandler:supabase:fallback',message:'supabase fallback download miss',data:{fallbackFilename,hasData:!!fallbackData,error:fallbackError?{name:(fallbackError as any).name,message:(fallbackError as any).message,status:(fallbackError as any).status}:null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
    }

    // Fallback to local file
    const hasLocal = fs.existsSync(localPath);
    const hasFallbackLocal = fs.existsSync(fallbackLocalPath);

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/fbd253c4-3e7e-4ffa-ba01-a72af7a8b319',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({runId:'pre-fix',hypothesisId:'D',location:'backend/src/routes/handlers/resumeHandlers.ts:resumeHandler:local',message:'local resume existence check',data:{localPath,hasLocal,fallbackLocalPath,hasFallbackLocal},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    if (hasLocal) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(localPath));
    }

    // If DB points to a custom filename but only a generic resume.pdf exists locally,
    // serve it while keeping the user-facing download name.
    if (hasFallbackLocal) {
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(fs.createReadStream(fallbackLocalPath));
    }

    return reply.code(404).send({ error: 'Resume not found' });
  } catch (error) {
    _request.log.error(error, 'Error serving resume');
    return reply.code(500).send({ error: 'Failed to serve resume' });
  }
}
