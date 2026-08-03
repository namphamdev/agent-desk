// Harness + model catalogs — ports of crates/harness's curated static
// catalogs. The desktop overlays these on runtime discovery; the phone uses
// them directly for the pickers. Defaults mirror pickers.rs: first catalog
// row, reasoning xhigh where the ladder has it, else high.

import type { ChatConfig } from './Entities';

export interface HarnessInfo {
  id: string;
  label: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
  // Unified reasoning ladder, lowercase wire values. Empty = no efforts.
  reasoningLevels: string[];
}

const FULL_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'];
const CLAUDE_XHIGH_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'];
const CODEX_ULTRA_LADDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CODEX_MAX_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_XHIGH_LADDER = ['low', 'medium', 'high', 'xhigh'];

export const HarnessCatalog = {
  harnesses: [
    { id: 'claude-code', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'acp', label: 'ACP' },
  ] as HarnessInfo[],

  modelsFor(harness: string): ModelInfo[] {
    switch (harness) {
      case 'acp':
        return [
          {
            id: 'default',
            label: 'Agent default',
            description: "Use the active ACP agent's default model",
            reasoningLevels: [],
          },
        ];
      case 'codex':
        return [
          { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Frontier reasoning flagship', reasoningLevels: CODEX_ULTRA_LADDER },
          { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: 'Deep multi-step agentic work', reasoningLevels: CODEX_ULTRA_LADDER },
          { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Fast frontier model', reasoningLevels: CODEX_MAX_LADDER },
          { id: 'gpt-5.5', label: 'GPT-5.5', description: 'Previous generation flagship', reasoningLevels: CODEX_XHIGH_LADDER },
          { id: 'gpt-5.4', label: 'GPT-5.4', description: 'Reliable general coding', reasoningLevels: CODEX_XHIGH_LADDER },
          { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', description: 'Small, fast and capable', reasoningLevels: CODEX_XHIGH_LADDER },
          { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark', description: 'Ultra-fast lightweight coding', reasoningLevels: CODEX_XHIGH_LADDER },
        ];
      default: // claude-code (mock shares it)
        return [
          { id: 'claude-fable-5', label: 'Fable 5', description: 'Most intelligent model for building agents', reasoningLevels: FULL_LADDER },
          { id: 'claude-opus-5', label: 'Opus 5', description: 'Powerful model for complex work', reasoningLevels: FULL_LADDER },
          { id: 'claude-opus-4-8', label: 'Opus 4.8', description: 'Previous generation Opus', reasoningLevels: FULL_LADDER },
          { id: 'claude-opus-4-7', label: 'Opus 4.7', description: 'Older generation Opus', reasoningLevels: CLAUDE_XHIGH_LADDER },
          { id: 'claude-sonnet-5', label: 'Sonnet 5', description: 'Balanced speed and intelligence', reasoningLevels: CLAUDE_XHIGH_LADDER },
          { id: 'claude-haiku-4-5', label: 'Haiku 4.5', description: 'Fastest model for everyday tasks', reasoningLevels: [] },
        ];
    }
  },

  defaultModelFor(harness: string): ModelInfo {
    return this.modelsFor(harness)[0];
  },

  // pickers.rs:126 — X-High when the ladder has it, else High.
  defaultReasoningFor(model: ModelInfo): string | null {
    if (model.reasoningLevels.length === 0) return null;
    return model.reasoningLevels.includes('xhigh') ? 'xhigh' : 'high';
  },

  reasoningLabel(level: string): string {
    switch (level) {
      case 'low': return 'Low';
      case 'medium': return 'Medium';
      case 'high': return 'High';
      case 'xhigh': return 'X-High';
      case 'max': return 'Max';
      case 'ultra': return 'Ultra';
      case 'ultracode': return 'Ultracode';
      case 'ultrathink': return 'Ultrathink';
      default: return level.charAt(0).toUpperCase() + level.slice(1);
    }
  },

  modelLabel(harness: string, modelId?: string): string {
    if (!modelId) return this.defaultModelFor(harness).label;
    const found = this.modelsFor(harness).find((m) => m.id === modelId);
    return found ? found.label : modelId;
  },

  effortHint(level: string): string | null {
    switch (level) {
      case 'low': return 'Fastest responses';
      case 'medium': return 'Balanced speed and depth';
      case 'high': return 'Thorough reasoning';
      case 'xhigh': return 'Extended reasoning';
      case 'max': return 'Maximum reasoning budget';
      case 'ultra': return 'Highest Codex tier';
      case 'ultracode': return 'X-High plus the ultracode setting';
      case 'ultrathink': return 'Deep-thinking prompt mode';
      default: return null;
    }
  },

  effortHintForConfig(config?: ChatConfig | null): string | null {
    if (!config?.reasoning) return null;
    return this.effortHint(config.reasoning);
  },
};
