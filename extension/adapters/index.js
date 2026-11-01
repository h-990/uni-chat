/**
 * AI Adapter Registry
 * Easily extendable for any web-based AI assistant (DeepSeek, ChatGPT, Claude, etc.)
 */

import { DeepSeekAdapter } from './deepseek.js';

export const AI_ADAPTERS = {
  deepseek: DeepSeekAdapter,
  // Future AIs can be added here seamlessly:
  // chatgpt: ChatGPTAdapter,
  // claude: ClaudeAdapter,
};

export function getAdapter(id = 'deepseek') {
  return AI_ADAPTERS[id] || AI_ADAPTERS.deepseek;
}

export function listAdapters() {
  return Object.values(AI_ADAPTERS).map(a => ({
    id: a.id,
    name: a.name,
    defaultUsername: a.defaultUsername,
    targetUrl: a.targetUrl
  }));
}

