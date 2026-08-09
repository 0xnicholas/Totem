#!/usr/bin/env node
import { AdminApiClient } from '../admin/client.js';
import { run } from './commands.js';

const baseUrl = process.env.TOTEM_ADMIN_URL ?? 'http://localhost:3000';
const adminKey = process.env.TOTEM_ADMIN_KEY;
if (!adminKey) {
  console.error(
    'TOTEM_ADMIN_KEY is required: set it to the server\'s bootstrap admin key, or to an ' +
      'admin-scoped tenant key issued with `totemctl create-key <tenant> --scope admin`.',
  );
  process.exit(1);
}

const client = new AdminApiClient({ baseUrl, apiKey: adminKey });
const code = await run(process.argv.slice(2), {
  client,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
process.exit(code);
