/**
 * Type declarations for scripts/migrate.mjs (the runner is plain JS so it
 * runs without a build step; this file keeps the typed surface in sync).
 */
export interface MigrateOptions {
  log?: (message: string) => void;
}

/** Applies all pending migrations; returns the number applied. */
export function migrateUp(connectionString: string, options?: MigrateOptions): Promise<number>;

/** Rolls back the most recently applied migration; returns 1 when applied. */
export function migrateDown(connectionString: string, options?: MigrateOptions): Promise<number>;
