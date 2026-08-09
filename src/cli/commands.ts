import type { AdminApiClient, ApiError } from '../admin/client.js';
import type { AuditFilters } from '../admin/repo.js';

export interface CommandIO {
  client: AdminApiClient;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Bad CLI usage: prints the usage line and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const USAGE = `totemctl — admin surface for the totem action layer

usage: totemctl <command> [args]

commands:
  create-tenant <name>
  create-key <tenant-id> [--scope actions|admin]        (prints the key once)
  disable-key <tenant-id> <key-id>                      (alias: revoke-key)
  set-feishu-creds <tenant-id> <app-id> <app-secret>
  set-allowlist <connection-id> <action> [action...]
  suspend-connection <connection-id>
  resume-connection <connection-id>
  query-audit <tenant-id> [--user <id>] [--action <name>] [--since <iso-timestamp>]
              [--source mcp|admin_api|cli] [--success true|false]
  help

environment:
  TOTEM_ADMIN_URL   admin API base URL (default http://localhost:3000)
  TOTEM_ADMIN_KEY   admin key (required; see create-key --scope admin)`;

/** Runs one totemctl command; returns the process exit code. */
export async function run(argv: string[], io: CommandIO): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
        io.stdout(USAGE);
        return 0;

      case 'create-tenant': {
        const [name] = rest;
        if (!name) throw new UsageError('create-tenant <name>');
        const tenant = await io.client.createTenant(name);
        io.stdout(tenant.id);
        return 0;
      }

      case 'create-key': {
        const { positionals, flags } = parseFlags(rest);
        const [tenantId] = positionals;
        if (!tenantId) throw new UsageError('create-key <tenant-id> [--scope actions|admin]');
        const scope = flags.scope ?? 'actions';
        if (scope !== 'actions' && scope !== 'admin') {
          throw new UsageError('--scope must be "actions" or "admin"');
        }
        const key = await io.client.createKey(tenantId, scope);
        io.stdout(key.key);
        return 0;
      }

      case 'disable-key':
      case 'revoke-key': {
        const [tenantId, keyId] = rest;
        if (!tenantId || !keyId) throw new UsageError(`${command} <tenant-id> <key-id>`);
        const result = await io.client.disableKey(tenantId, keyId);
        io.stdout(
          result.changed ? `Key ${keyId} disabled` : `Key ${keyId} was already disabled`,
        );
        return 0;
      }

      case 'set-feishu-creds': {
        const [tenantId, appId, appSecret] = rest;
        if (!tenantId || !appId || !appSecret) {
          throw new UsageError('set-feishu-creds <tenant-id> <app-id> <app-secret>');
        }
        await io.client.setFeishuCreds(tenantId, appId, appSecret);
        io.stdout(`Feishu credentials updated for tenant ${tenantId}`);
        return 0;
      }

      case 'set-allowlist': {
        const [connectionId, ...actions] = rest;
        if (!connectionId || actions.length === 0) {
          throw new UsageError('set-allowlist <connection-id> <action> [action...]');
        }
        await io.client.setAllowlist(connectionId, actions);
        io.stdout(`Allowlist for connection ${connectionId}: ${actions.join(', ')}`);
        return 0;
      }

      case 'suspend-connection':
      case 'resume-connection': {
        const [connectionId] = rest;
        if (!connectionId) throw new UsageError(`${command} <connection-id>`);
        if (command === 'suspend-connection') {
          await io.client.suspendConnection(connectionId);
          io.stdout(`Connection ${connectionId} suspended`);
        } else {
          await io.client.resumeConnection(connectionId);
          io.stdout(`Connection ${connectionId} resumed`);
        }
        return 0;
      }

      case 'query-audit': {
        const { positionals, flags } = parseFlags(rest);
        const [tenantId] = positionals;
        if (!tenantId) throw new UsageError('query-audit <tenant-id> [--user --action --since --source --success]');
        const filters = flagsToAuditFilters(flags);
        const { rows } = await io.client.queryAudit(tenantId, filters);
        for (const row of rows) {
          io.stdout(
            [
              row.createdAt,
              row.actionName,
              row.userId ?? '-',
              row.source,
              row.success ? 'ok' : 'FAIL',
              row.errorCode ?? '',
            ].join('\t'),
          );
        }
        return 0;
      }

      default:
        throw new UsageError(`unknown command "${command}" (try "totemctl help")`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`usage: ${err.message}`);
      return 2;
    }
    if (isApiError(err)) {
      io.stderr(`error: ${err.message}`);
      return 1;
    }
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function parseFlags(argv: string[]): { positionals: string[]; flags: Record<string, string> } {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`flag --${name} requires a value`);
      }
      flags[name] = value;
      i++;
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

const AUDIT_FLAGS = ['user', 'action', 'since', 'source', 'success'] as const;

function flagsToAuditFilters(flags: Record<string, string>): AuditFilters {
  const filters: AuditFilters = {};
  for (const [name, value] of Object.entries(flags)) {
    if (!(AUDIT_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(`unknown flag --${name} for query-audit`);
    }
    if (name === 'user') filters.userId = value;
    else if (name === 'action') filters.action = value;
    else if (name === 'since') filters.since = value;
    else if (name === 'source') {
      if (value !== 'mcp' && value !== 'admin_api' && value !== 'cli') {
        throw new UsageError('--source must be "mcp", "admin_api" or "cli"');
      }
      filters.source = value;
    } else if (name === 'success') {
      if (value !== 'true' && value !== 'false') {
        throw new UsageError('--success must be "true" or "false"');
      }
      filters.success = value === 'true';
    }
  }
  return filters;
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && err.name === 'ApiError';
}
