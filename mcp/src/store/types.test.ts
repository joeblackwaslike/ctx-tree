import { describe, test, expect } from 'bun:test';
import type { MemtreeNode, MemtreeConfig, NodeStatus } from './types';

describe('types', () => {
  test('NodeStatus values are a closed set', () => {
    const valid: NodeStatus[] = ['pending', 'live', 'stale', 'superseded', 'pruned'];
    expect(valid).toHaveLength(5);
  });

  test('MemtreeNode shape is stable', () => {
    const node: MemtreeNode = {
      id: '01HX', parent_id: null, kind: 'session',
      source_uri: null, content: '', content_hash: '',
      status: 'live', mtime: 0, created_at: 0, updated_at: 0,
      truncated: 0, original_bytes: 0, metadata: '{}',
    };
    expect(node.kind).toBe('session');
  });
});
