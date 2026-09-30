// Ambient types for OPTIONAL storage drivers (pg/redis).
// Global script (no imports/exports) so these are declarations, not
// augmentations — typecheck passes with zero optional deps installed.
// Runtime always dynamic-imports inside try/catch with file fallback.
declare module "pg" {
  export class Client {
    constructor(opts: { connectionString: string; connectionTimeoutMillis?: number });
    connect(): Promise<void>;
    query(q: string): Promise<unknown>;
    end(): Promise<void>;
  }
}
declare module "redis" {
  export function createClient(opts: { url: string; socket?: { connectTimeout: number } }): {
    connect(): Promise<void>;
    ping(): Promise<string>;
    quit(): Promise<void>;
  };
}
