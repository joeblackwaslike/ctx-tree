import type { EmbeddingProvider, SummarizerProvider } from '../store/types.js';

// ── Ollama Embedding Provider ─────────────────────────────────────────────────

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly baseUrl = 'http://localhost:11434';

  constructor(model: string, dim = 768) {
    this.model = model;
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}

// ── Ollama Summarizer Provider ────────────────────────────────────────────────

export class OllamaSummarizerProvider implements SummarizerProvider {
  readonly model: string;
  private readonly baseUrl = 'http://localhost:11434';

  constructor(model: string) {
    this.model = model;
  }

  async summarize(content: string, contextHint?: string): Promise<string> {
    const prompt = contextHint
      ? `Context: ${contextHint}\n\nSummarize the following:\n\n${content}`
      : `Summarize the following:\n\n${content}`;

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt, stream: false }),
    });
    if (!response.ok) {
      throw new Error(`Ollama generate request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { response: string };
    return data.response;
  }
}
