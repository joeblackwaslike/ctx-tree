scalar type NodeKind extending enum<
  session, file_chunk, tool_output, summary, note,
  observation, web_chunk, prompt, thinking, response
>;
scalar type NodeStatus extending enum<pending, live, stale, superseded, pruned>;
scalar type EdgeKind extending enum<
  derived_from, references, summarizes, supersedes, follows
>;

type Node {
  required kind:           NodeKind;
  required status:         NodeStatus  { default := 'pending' };
  required content:        str         { default := '' };
  required content_hash:   str         { default := '' };
  required mtime:          int64       { default := 0 };
  required created_at:     int64;
  required updated_at:     int64;
  required truncated:      bool        { default := false };
  required original_bytes: int64       { default := 0 };
  source_uri:              str;
  metadata:                json        { default := '{}' };
  summary:                 str;
  parent:                  Node;

  index fts on (.content);
}

type Edge {
  required src:        Node;
  required dst:        Node;
  required kind:       EdgeKind;
  required created_at: int64;

  constraint exclusive on ((.src, .dst, .kind));
}
