import type { Database } from 'bun:sqlite';
import type { MemtreeConfig } from '../store/types.js';
import type { SummarizerProvider } from '../store/types.js';

const CHAR_THRESHOLD_MULTIPLIER = 20; // summarizerSubtreeThreshold (nodes) * 20 = char threshold

let inFlight = false;

export function runSummarizerWalker(
  db: Database,
  config: MemtreeConfig,
  provider: SummarizerProvider | null
): void {
  if (!provider) return;
  if (inFlight) return;

  const charThreshold = Math.max(
    500,
    config.walkers.summarizerSubtreeThreshold * CHAR_THRESHOLD_MULTIPLIER
  );
  const batchSize = 10;

  const rows = db.query<{ id: string; content: string; source_uri: string | null }, [number, number]>(`
    SELECT id, content, source_uri FROM nodes
    WHERE status = 'live'
      AND (summary IS NULL OR summary = '')
      AND length(content) > ?
    LIMIT ?
  `).all(charThreshold, batchSize);

  if (rows.length === 0) return;

  inFlight = true;
  let pending = rows.length;

  for (const row of rows) {
    provider.summarize(row.content, row.source_uri ?? undefined).then(summary => {
      const now = Date.now();
      db.run(
        'UPDATE nodes SET summary = ?, updated_at = ? WHERE id = ?',
        summary, now, row.id
      );
    }).catch((e: unknown) => {
      process.stderr.write(`memtree summarizer error: ${e}\n`);
    }).finally(() => {
      pending--;
      if (pending === 0) inFlight = false;
    });
  }
}
