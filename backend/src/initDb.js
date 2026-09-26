import fs from 'node:fs';
import pg from 'pg';
import { config } from './config.js';

if (!config.databaseUrl) {
  console.error('Set DATABASE_URL in backend/.env first (your Tiger Data connection string).');
  process.exit(1);
}
const client = new pg.Client({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(fs.readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
console.log('Tables created.');
await client.end();
