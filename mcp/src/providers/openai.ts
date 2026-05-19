import OpenAI from 'openai';
import type { EmbeddingProvider, SummarizerProvider } from '../store/types.js';

// ── OpenAI Embedding Provider ─────────────────────────────────────────────────

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dim: number;
  private readonly client: OpenAI;

  constructor(model: string) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    this.client = new OpenAI({ apiKey });
    this.model = model || 'text-embedding-3-small';
    this.dim = 0; // resolved on first embed call
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data.map(e => e.embedding);
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
