import type { EmbeddingProvider, SummarizerProvider } from '../store/types.js';

// ── Ollama Embedding Provider ─────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  private _dim: number = 0;

  get dim(): number {
    return this._dim;
  }

  constructor(model: string) {
    this.model = model;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { embeddings: number[][] };
    const embeddings = data.embeddings;
    if (embeddings.length > 0 && this._dim === 0) {
      this._dim = embeddings[0].length;
    }
    return embeddings;
  }
}

// ── Ollama Summarizer Provider ────────────────────────────────────────────────

export class OllamaSummarizerProvider implements SummarizerProvider {
  readonly model: string;

  constructor(model: string) {
    this.model = model;
  }

  async summarize(content: string, contextHint?: string): Promise<string> {
    const prompt = contextHint
      ? `Context: ${contextHint}\n\nSummarize the following:\n\n${content}`
      : `Summarize the following:\n\n${content}`;

    const response = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
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
