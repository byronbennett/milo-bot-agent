import type { AgentConfig } from '../config/schema.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('local-models');

export interface LocalModel {
  name: string;
  provider: 'ollama' | 'lm-studio';
}

/**
 * Probe Ollama and LM Studio for locally running models.
 * Returns an empty array if neither is available.
 */
export async function detectLocalModels(config: AgentConfig): Promise<LocalModel[]> {
  const results: LocalModel[] = [];
  const timeoutMs = config.localModels.timeoutMs;

  const probes: Promise<void>[] = [];

  if (config.localModels.ollama.enabled) {
    probes.push(
      (async () => {
        try {
          const res = await fetch(
            `http://localhost:${config.localModels.ollama.port}/api/tags`,
            { signal: AbortSignal.timeout(timeoutMs) },
          );
          if (res.ok) {
            const data = (await res.json()) as { models?: Array<{ name: string }> };
            if (data.models) {
              for (const m of data.models) {
                results.push({ name: m.name, provider: 'ollama' });
              }
            }
          }
        } catch {
          logger.verbose('Ollama not available');
        }
      })(),
    );
  }

  if (config.localModels.lmStudio.enabled) {
    probes.push(
      (async () => {
        try {
          const res = await fetch(
            `http://localhost:${config.localModels.lmStudio.port}/v1/models`,
            { signal: AbortSignal.timeout(timeoutMs) },
          );
          if (res.ok) {
            const data = (await res.json()) as { data?: Array<{ id: string }> };
            if (data.data) {
              for (const m of data.data) {
                results.push({ name: m.id, provider: 'lm-studio' });
              }
            }
          }
        } catch {
          logger.verbose('LM Studio not available');
        }
      })(),
    );
  }

  // Probe in parallel
  await Promise.all(probes);

  if (results.length > 0) {
    logger.info(`Detected ${results.length} local model(s)`);
  }

  return results;
}
