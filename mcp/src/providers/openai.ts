import OpenAI from 'openai';
import type { EmbeddingProvider, SummarizerProvider } from '../store/types.js';

// ── OpenAI Embedding Provider ─────────────────────────────────────────────────

const OPENAI_EMBEDDING_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly client: OpenAI;

  constructor(model: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.client = new OpenAI({ apiKey });
    this.model = model || 'text-embedding-3-small';
    this.dim = OPENAI_EMBEDDING_DIMS[this.model] ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    const embeddings = response.data.map(e => e.embedding);
    if (embeddings.length > 0 && embeddings[0].length !== this.dim) {
      process.stderr.write(
        `[OpenAIEmbeddingProvider] warning: expected dim=${this.dim} but got ${embeddings[0].length} for model="${this.model}"\n`,
      );
    }
    return embeddings;
  }
}

// ── OpenAI Summarizer Provider ────────────────────────────────────────────────

export class OpenAISummarizerProvider implements SummarizerProvider {
  readonly model: string;
  private readonly client: OpenAI;

  constructor(model: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.client = new OpenAI({ apiKey });
    this.model = model || 'gpt-4o-mini';
  }

  async summarize(content: string, contextHint?: string): Promise<string> {
    const systemPrompt = contextHint
      ? `You are a summarizer. Context: ${contextHint}`
      : 'You are a summarizer.';

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Summarize the following:\n\n${content}` },
      ],
    });
    return response.choices[0]?.message?.content ?? '';
  }
}
