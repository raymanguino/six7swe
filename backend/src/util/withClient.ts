import { Client } from 'pg';
// import { decodeBase64 } from './decode';

// const {
//   PGHOST,
//   PGDATABASE,
//   PGUSER,
//   PGPASSWORD,
//   // PGSSLMODE,
//   // PGSSLROOTCERT
// } = process.env;

// if (PGSSLMODE === 'verify-full' && !PGSSLROOTCERT) {
//   throw new Error('PGSSLROOTCERT environment variable must be set when PGSSLMODE is verify-full');
// }

// const config = {
//   host: PGHOST,
//   database: PGDATABASE,
//   user: PGUSER,
//   password: PGPASSWORD,
// }

// Utility to manage PostgreSQL client connection lifecycle.
// For use outside of fastify route handlers.
// Example usage:
// await withClient(async (client) => {
//   // use client here
// })();
export const withClient = (cb: (client: Client) => Promise<void>) => {
  return async () => {
    const pgClient = new Client();
    await pgClient.connect();
    try {
      await cb(pgClient);
    } finally {
      await pgClient.end();
    }
  };
}
