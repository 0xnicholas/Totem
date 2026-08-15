import type { AdminApiClient, ApiError } from '../admin/client.js';
import type { AuditFilters, ConnectionView } from '../admin/repo.js';

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
  set-dingtalk-creds <tenant-id> <app-key> <app-secret>
  oauth-start <tenant-id> [redirect-uri] [--connection <id>] [--connector feishu_docs|dingtalk_docs]
                                      (prints the authorization URL;
                                       --connection re-authorizes an existing
                                       connection instead of creating one;
                                       --connector picks the flow, default feishu_docs)
  set-allowlist <connection-id> <action> [action...]
                                      (--allow-destructive true acknowledges that the list
                                       includes destructive actions, ADR-0018)
  suspend-connection <connection-id>
  resume-connection <connection-id>
  list-connections <tenant-id>                          (id, name, connector, auth state)
  query-audit <tenant-id> [--user <id>] [--action <name>] [--since <iso-timestamp>]
              [--source mcp|admin_api|cli] [--success true|false] [--destructive true|false]
              (--destructive filters rows stamped with the irreversible class,
               ADR-0018; stamped rows also print a DESTRUCTIVE marker)
  get-audit-policy <tenant-id>                          (retention days, error-only, capture-body)
  set-audit-policy <tenant-id> [--retention-days N] [--error-only true|false]
                  [--capture-body true|false]           (omitted fields are kept)
  purge-audit <tenant-id>                               (deletes audit rows older than
                                                         the tenant's retention window)
  get-defender-policy <tenant-id>                       (enabled, block-high-risk)
  set-defender-policy <tenant-id> [--enabled true|false]
                  [--block-high-risk true|false]        (omitted fields are kept)
  help

environment:
  TOTEM_ADMIN_URL          admin API base URL (default http://localhost:3000)
  TOTEM_ADMIN_KEY          admin key (required; see create-key --scope admin)
  TOTEM_OAUTH_REDIRECT_URI default redirect URI for oauth-start (optional;
                           the server's canonical callback URL)`;

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

      case 'set-dingtalk-creds': {
        const [tenantId, appKey, appSecret] = rest;
        if (!tenantId || !appKey || !appSecret) {
          throw new UsageError('set-dingtalk-creds <tenant-id> <app-key> <app-secret>');
        }
        await io.client.setDingTalkCreds(tenantId, appKey, appSecret);
        io.stdout(`DingTalk credentials updated for tenant ${tenantId}`);
        return 0;
      }

      case 'oauth-start': {
        const { positionals, flags } = parseFlags(rest);
        const [tenantId] = positionals;
        if (!tenantId) throw new UsageError('oauth-start <tenant-id> [redirect-uri]');
        const redirectUri =
          positionals[1] ?? process.env.TOTEM_OAUTH_REDIRECT_URI;
        if (!redirectUri) {
          throw new UsageError(
            'oauth-start needs a redirect-uri argument (or set TOTEM_OAUTH_REDIRECT_URI)',
          );
        }
        const connectionId = flags.connection;
        const connectorId = flags.connector;
        if (connectorId !== undefined && connectorId !== 'feishu_docs' && connectorId !== 'dingtalk_docs') {
          throw new UsageError('--connector must be "feishu_docs" or "dingtalk_docs"');
        }
        const { authorizationUrl } = await io.client.startOAuth(
          tenantId,
          redirectUri,
          connectionId,
          connectorId,
        );
        io.stdout(authorizationUrl);
        io.stdout(
          connectorId === 'dingtalk_docs'
            ? 'Open the URL above in a browser and authorize with DingTalk.'
            : 'Open the URL above in a browser and authorize with Feishu.',
        );
        return 0;
      }

      case 'list-connections': {
        const [tenantId] = rest;
        if (!tenantId) throw new UsageError('list-connections <tenant-id>');
        const { connections } = await io.client.listConnections(tenantId);
        for (const connection of connections) {
          io.stdout(formatConnection(connection));
        }
        return 0;
      }

      case 'set-allowlist': {
        const { positionals, flags } = parseFlags(rest);
        const [connectionId, ...actions] = positionals;
        if (!connectionId || actions.length === 0) {
          throw new UsageError(
            'set-allowlist <connection-id> <action> [action...] [--allow-destructive true|false]',
          );
        }
        if (flags['allow-destructive'] !== undefined && flags['allow-destructive'] !== 'true' && flags['allow-destructive'] !== 'false') {
          throw new UsageError('--allow-destructive must be "true" or "false"');
        }
        const allowDestructive = flags['allow-destructive'] === 'true';
        await io.client.setAllowlist(connectionId, actions, {
          ...(allowDestructive ? { allowDestructive: true } : {}),
        });
        io.stdout(
          `Allowlist for connection ${connectionId}: ${actions.join(', ')}` +
            (allowDestructive ? ' (destructive acknowledged)' : ''),
        );
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
          const destructive =
            typeof row.metadata === 'object' &&
            row.metadata !== null &&
            (row.metadata as { effects?: unknown }).effects === 'destructive';
          io.stdout(
            [
              row.createdAt,
              row.actionName,
              row.userId ?? '-',
              row.source,
              row.success ? 'ok' : 'FAIL',
              row.errorCode ?? '',
              ...(destructive ? ['DESTRUCTIVE'] : []),
            ].join('\t'),
          );
        }
        return 0;
      }

      case 'get-audit-policy': {
        const [tenantId] = rest;
        if (!tenantId) throw new UsageError('get-audit-policy <tenant-id>');
        const policy = await io.client.getAuditPolicy(tenantId);
        io.stdout(formatAuditPolicy(policy));
        return 0;
      }

      case 'set-audit-policy': {
        const { positionals, flags } = parseFlags(rest);
        const [tenantId] = positionals;
        if (!tenantId) throw new UsageError('set-audit-policy <tenant-id> [--retention-days --error-only --capture-body]');
        const patch = auditPolicyPatchFromFlags(flags);
        const policy = await io.client.setAuditPolicy(tenantId, patch);
        io.stdout(formatAuditPolicy(policy));
        return 0;
      }

      case 'purge-audit': {
        const [tenantId] = rest;
        if (!tenantId) throw new UsageError('purge-audit <tenant-id>');
        const { deleted } = await io.client.purgeAudit(tenantId);
        io.stdout(`Deleted ${deleted} expired audit rows for tenant ${tenantId}`);
        return 0;
      }

      case 'get-defender-policy': {
        const [tenantId] = rest;
        if (!tenantId) throw new UsageError('get-defender-policy <tenant-id>');
        const policy = await io.client.getDefenderPolicy(tenantId);
        io.stdout(formatDefenderPolicy(policy));
        return 0;
      }

      case 'set-defender-policy': {
        const { positionals, flags } = parseFlags(rest);
        const [tenantId] = positionals;
        if (!tenantId) {
          throw new UsageError('set-defender-policy <tenant-id> [--enabled --block-high-risk]');
        }
        const patch = defenderPolicyPatchFromFlags(flags);
        const policy = await io.client.setDefenderPolicy(tenantId, patch);
        io.stdout(formatDefenderPolicy(policy));
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

const AUDIT_FLAGS = ['user', 'action', 'since', 'source', 'success', 'destructive'] as const;

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
    } else if (name === 'destructive') {
      if (value !== 'true' && value !== 'false') {
        throw new UsageError('--destructive must be "true" or "false"');
      }
      filters.destructive = value === 'true';
    }
  }
  return filters;
}

function isApiError(err: unknown): err is ApiError {
  return err instanceof Error && err.name === 'ApiError';
}

const AUDIT_POLICY_FLAGS = ['retention-days', 'error-only', 'capture-body'] as const;
const DEFENDER_POLICY_FLAGS = ['enabled', 'block-high-risk'] as const;

function auditPolicyPatchFromFlags(flags: Record<string, string>): {
  retentionDays?: number;
  errorOnly?: boolean;
  captureBody?: boolean;
} {
  const patch: { retentionDays?: number; errorOnly?: boolean; captureBody?: boolean } = {};
  for (const [name, value] of Object.entries(flags)) {
    if (!(AUDIT_POLICY_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(`unknown flag --${name} for set-audit-policy`);
    }
    if (name === 'retention-days') {
      const days = Number(value);
      if (!Number.isInteger(days) || days < 1 || days > 3650) {
        throw new UsageError('--retention-days must be an integer between 1 and 3650');
      }
      patch.retentionDays = days;
    } else {
      if (value !== 'true' && value !== 'false') {
        throw new UsageError(`--${name} must be "true" or "false"`);
      }
      if (name === 'error-only') patch.errorOnly = value === 'true';
      else patch.captureBody = value === 'true';
    }
  }
  return patch;
}

function formatAuditPolicy(policy: {
  retentionDays: number;
  errorOnly: boolean;
  captureBody: boolean;
}): string {
  return [
    `retentionDays=${policy.retentionDays}`,
    `errorOnly=${policy.errorOnly}`,
    `captureBody=${policy.captureBody}`,
  ].join('\t');
}

function defenderPolicyPatchFromFlags(flags: Record<string, string>): {
  enabled?: boolean;
  blockHighRisk?: boolean;
} {
  const patch: { enabled?: boolean; blockHighRisk?: boolean } = {};
  for (const [name, value] of Object.entries(flags)) {
    if (!(DEFENDER_POLICY_FLAGS as readonly string[]).includes(name)) {
      throw new UsageError(`unknown flag --${name} for set-defender-policy`);
    }
    if (value !== 'true' && value !== 'false') {
      throw new UsageError(`--${name} must be "true" or "false"`);
    }
    if (name === 'enabled') patch.enabled = value === 'true';
    else patch.blockHighRisk = value === 'true';
  }
  return patch;
}

function formatDefenderPolicy(policy: { enabled: boolean; blockHighRisk: boolean }): string {
  return [`enabled=${policy.enabled}`, `blockHighRisk=${policy.blockHighRisk}`].join('\t');
}

function formatConnection(connection: ConnectionView): string {
  return [connection.id, connection.name, connection.connectorId, connection.status].join('\t');
}
