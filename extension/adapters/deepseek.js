/**
 * DeepSeek Adapter for Uni-Chat Automator
 * Handles site-specific selectors and targeting for chat.deepseek.com
 */

export const DeepSeekAdapter = {
  id: 'deepseek',
  name: 'DeepSeek',
  defaultUsername: 'deepseek',
  targetUrl: 'https://chat.deepseek.com',
  matchPattern: '*://*.deepseek.com/*',
  tabQueryPatterns: [
    'https://chat.deepseek.com/*',
    '*://*.deepseek.com/*'
  ],
  selectors: {
    input: '#chat-input, textarea, div[contenteditable="true"]',
    sendButton: 'button[type="submit"], div[role="button"][aria-label*="Send"], div.ds-icon-button',
    assistantMessage: '.ds-markdown, .chat-message-assistant, div[class*="message-assistant"], .ds-chat-bubble',
    fileInput: 'input[type="file"]'
  }
};

