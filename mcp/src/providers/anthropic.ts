import Anthropic from '@anthropic-ai/sdk';
import type { SummarizerProvider } from '../store/types.js';

// ── Anthropic Summarizer Provider ─────────────────────────────────────────────
// Note: Anthropic has no embeddings API; only summarization is supported.

export class AnthropicSummarizerProvider implements SummarizerProvider {
  readonly model: string;
  private readonly client: Anthropic;

  constructor(model: string) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async summarize(content: string, contextHint?: string): Promise<string> {
    const systemPrompt = contextHint
      ? `You are a summarizer. Context: ${contextHint}`
      : 'You are a summarizer.';

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Summarize the following:\n\n${content}` },
      ],
    });
    const block = response.content[0];
    return block?.type === 'text' ? block.text : '';
  }
}
