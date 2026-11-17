import fastifyCors from '@fastify/cors';
import Fastify from 'fastify';
import { getCorsOrigin } from '../../config/cors';

describe('getCorsOrigin', () => {
  it('allows every origin outside production', () => {
    expect(getCorsOrigin({ NODE_ENV: 'development' })).toBe(true);
    expect(getCorsOrigin({})).toBe(true);
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
  });
});
