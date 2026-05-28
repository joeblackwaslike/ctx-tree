import type { EmbeddingProvider, SummarizerProvider } from '../store/types.js';

// ── Ollama Embedding Provider ─────────────────────────────────────────────────

const OLLAMA_BASE_URL = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
const OLLAMA_TIMEOUT_MS = 30_000;

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
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { embeddings: number[][] };
    const embeddings = data.embeddings;
    if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
      throw new Error(`Ollama embed response length mismatch: expected ${texts.length}, got ${embeddings?.length}`);
    }
    const dim = embeddings[0]?.length ?? 0;
    if (dim === 0 || embeddings.some((v) => v.length !== dim)) {
      throw new Error('Ollama embed response has inconsistent or zero dimensions');
    }
    if (this._dim === 0) {
      this._dim = dim;
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
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Ollama generate request failed: ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { response: string };
    return data.response;
  }
}
