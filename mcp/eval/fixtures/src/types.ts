export interface Node { id: string; kind: string; content: string; }
export type Status = 'pending' | 'live' | 'stale' | 'pruned';
export function isLive(n: Node & { status: Status }): boolean { return n.status === 'live'; }
