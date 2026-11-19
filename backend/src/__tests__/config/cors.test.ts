import fastifyCors from '@fastify/cors';
import Fastify from 'fastify';
import { CORS_METHODS, getCorsOrigin } from '../../config/cors';

describe('getCorsOrigin', () => {
  it.each(['development', 'test'])('allows every origin when NODE_ENV is %s', (nodeEnv) => {
    expect(getCorsOrigin({ NODE_ENV: nodeEnv })).toBe(true);
  });

  it.each([undefined, 'Production', 'staging', ''])(
    'requires CORS_ORIGINS when NODE_ENV is %p',
    (nodeEnv) => {
      expect(() => getCorsOrigin({ NODE_ENV: nodeEnv })).toThrow(/CORS_ORIGINS/);
      expect(getCorsOrigin({ NODE_ENV: nodeEnv, CORS_ORIGINS: 'https://a.example.com' })).toEqual([
        'https://a.example.com',
      ]);
    },
  );

  it('names the expected origin for a non-normalized value', () => {
    expect(() =>
      getCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: 'https://A.example.com/path' }),
    ).toThrow(/normalized origin, expected "https:\/\/a\.example\.com"/);
  });

  it('parses and normalizes the production list', () => {
    expect(
      getCorsOrigin({
        NODE_ENV: 'production',
        CORS_ORIGINS: ' https://a.example.com/ , http://localhost:5173,https://a.example.com ',
      }),
    ).toEqual(['https://a.example.com', 'http://localhost:5173']);
  });

  it.each([undefined, '', ' , ', '*', 'not a url', 'ftp://a.example.com', 'https://a.com/path'])(
    'fails fast in production for %p',
    (value) => {
      expect(() => getCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: value })).toThrow(
        /CORS_ORIGINS/,
      );
    },
  );

  describe('with @fastify/cors', () => {
    async function allowOriginHeader(origin: string) {
      const app = Fastify();
      await app.register(fastifyCors, {
        origin: getCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' }),
        credentials: true,
      });
      app.get('/', async () => ({ ok: true }));
      const res = await app.inject({ method: 'GET', url: '/', headers: { origin } });
      await app.close();
      return res.headers['access-control-allow-origin'];
    }

    it('reflects an allowed origin', async () => {
      expect(await allowOriginHeader('https://app.example.com')).toBe('https://app.example.com');
    });

    it('does not allow an unlisted origin', async () => {
      expect(await allowOriginHeader('https://evil.example.com')).toBeUndefined();
    });

    async function preflight(origin: string, method = 'GET') {
      const app = Fastify();
      await app.register(fastifyCors, {
        origin: getCorsOrigin({ NODE_ENV: 'production', CORS_ORIGINS: 'https://app.example.com' }),
        methods: CORS_METHODS,
        credentials: true,
      });
      app.get('/', async () => ({ ok: true }));
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/',
        headers: { origin, 'access-control-request-method': method },
      });
      await app.close();
      return res.headers;
    }

    it('answers a preflight from an allowed origin with credentials', async () => {
      const headers = await preflight('https://app.example.com');
      expect(headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(headers['access-control-allow-credentials']).toBe('true');
    });

    it.each(['PUT', 'PATCH', 'DELETE'])('allows %s in a preflight', async (method) => {
      const headers = await preflight('https://app.example.com', method);
      const allowed = String(headers['access-control-allow-methods']).split(/,\s*/);
      expect(allowed).toContain(method);
    });

    it('does not allow a preflight from an unlisted origin', async () => {
      const headers = await preflight('https://evil.example.com');
      expect(headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
