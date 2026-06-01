import path from 'path';
import { createSqliteBackend } from './backends/sqlite/index.js';
import { createEdgeliteBackend } from './backends/edgelite/index.js';
import type { BackendConfig } from './types.js';
import type { StoreBackend } from './interface.js';

export type { StoreBackend } from './interface.js';
export type { InsertNodeParams } from './interface.js';

export async function createBackend(config: BackendConfig, dbPath: string): Promise<StoreBackend> {
  if (config.kind === 'edgelite') {
    const schemaPath = config.schemaPath
      ?? path.join(process.cwd(), 'dbschema', 'schema.esdl');
    return createEdgeliteBackend(dbPath, schemaPath);
  }
  return createSqliteBackend(dbPath);
}
