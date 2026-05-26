import type { MemtreeConfig } from '../store/types.js';
import type { EmbeddingProvider, SummarizerProvider } from './types.js';
import { OllamaEmbeddingProvider, OllamaSummarizerProvider } from './ollama.js';
import { OpenAIEmbeddingProvider, OpenAISummarizerProvider } from './openai.js';
import { AnthropicSummarizerProvider } from './anthropic.js';

export { OllamaEmbeddingProvider, OllamaSummarizerProvider } from './ollama.js';
export { OpenAIEmbeddingProvider, OpenAISummarizerProvider } from './openai.js';
export { AnthropicSummarizerProvider } from './anthropic.js';
export type { EmbeddingProvider, SummarizerProvider } from './types.js';

export function loadProviders(config: MemtreeConfig): {
  embedding: EmbeddingProvider | null;
  summarizer: SummarizerProvider | null;
} {
  let embedding: EmbeddingProvider | null = null;
  if (config.embeddingModel) {
    try {
      if (config.embeddingModel.startsWith('openai/')) {
        embedding = new OpenAIEmbeddingProvider(config.embeddingModel.slice(7));
      } else {
        embedding = new OllamaEmbeddingProvider(config.embeddingModel);
      }
    } catch (err) {
      process.stderr.write(`memtree: embedding provider unavailable: ${err}\n`);
      embedding = null;
    }
  }

  let summarizer: SummarizerProvider | null = null;
  if (config.summarizerModel) {
    try {
      if (config.summarizerModel.startsWith('claude-')) {
        summarizer = new AnthropicSummarizerProvider(config.summarizerModel);
      } else if (config.summarizerModel.startsWith('openai/')) {
        summarizer = new OpenAISummarizerProvider(config.summarizerModel.slice(7));
      } else {
        summarizer = new OllamaSummarizerProvider(config.summarizerModel);
      }
    } catch (err) {
      process.stderr.write(`memtree: summarizer provider unavailable: ${err}\n`);
      summarizer = null;
    }
  }

  return { embedding, summarizer };
}
