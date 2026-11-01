/**
 * Uni-Chat AI Automator - Injected Content Script
 * Runs inside AI web interfaces (e.g. chat.deepseek.com)
 *
 * Responsibilities:
 * - Injects chat prompts into the AI input box and triggers send.
 * - Attaches images if present.
 * - Monitors the response generation until completion.
 * - Extracts and returns the clean response text.
 * - Zero extra toggling: the admin manually controls DeepThink/Search as desired.
 */

(function () {
  'use strict';

  if (window.__UNICHAT_AUTOMATOR_INJECTED__) {
    console.log('[Uni-Chat Bridge] Content script already active in tab.');
    return;
  }
  window.__UNICHAT_AUTOMATOR_INJECTED__ = true;

  console.log(
    '%c[Uni-Chat Bridge] AI Automator active on: ' + window.location.hostname,
    'background: #1e293b; color: #38bdf8; font-weight: bold; padding: 4px; border-radius: 4px;'
  );

  // Keepalive connection with background service worker
  let keepAlivePort = null;
  function connectKeepAlivePort() {
    try {
      keepAlivePort = chrome.runtime.connect({ name: 'unichat_keepalive' });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        setTimeout(connectKeepAlivePort, 2000);
      });
    } catch {
      setTimeout(connectKeepAlivePort, 3000);
    }
  }
  connectKeepAlivePort();

  chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_MOUNTED', url: window.location.href }).catch(() => {});

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_MOUNTED', url: window.location.href }).catch(() => {});
      if (!keepAlivePort) connectKeepAlivePort();
    }
  });

  // Message Dispatcher
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'PING') {
      sendResponse({ status: 'pong', url: window.location.href });
      return true;
    }

    if (request.type === 'EXECUTE_PROMPT') {
      executePromptSequence(request.prompt, request.imagePayload)
        .then((responseText) => {
          chrome.runtime.sendMessage({
            type: 'PROMPT_COMPLETED',
            result_text: responseText,
            triggerSeq: request.triggerSeq
          }).catch(() => {});
        })
        .catch((err) => {
          console.error('[Uni-Chat Bridge] Execution failed:', err);
          chrome.runtime.sendMessage({
            type: 'PROMPT_FAILED',
            error: err.message,
            triggerSeq: request.triggerSeq
          }).catch(() => {});
        });

      sendResponse({ status: 'executing' });
      return true;
    }
  });

  // ─── Main Execution Pipeline ──────────────────────────────────────────────

  async function executePromptSequence(promptText, imagePayload) {
    console.log(`[Uni-Chat Bridge] Injecting prompt (${promptText.length} chars, hasImage: ${Boolean(imagePayload)})`);

    // 1. Snapshot baseline assistant messages to ensure we only capture NEW output
    const baselineMessages = getExistingAssistantMessages();
    const baselineCount = baselineMessages.length;

    // 2. Attach physical image if present
    if (imagePayload && imagePayload.data) {
      try {
        await attachImage(imagePayload.data, imagePayload.mime, imagePayload.name);
        await sleep(400);
      } catch (err) {
        console.warn('[Uni-Chat Bridge] Image attachment warning:', err.message);
      }
    }

    // 3. Locate input textarea / contenteditable
    const inputElem = await waitForInputElement(7000);
    if (!inputElem) {
      throw new Error('Could not find AI chat input element on page.');
    }

    // 4. Inject prompt text
    setInputText(inputElem, promptText);
    await sleep(350);

    // 5. Trigger send
    const sent = await clickSendButton(inputElem);
    if (!sent) {
      throw new Error('Failed to click Send button on AI chat page.');
    }

    // 6. Verify input cleared
    const cleared = await verifyInputCleared(inputElem, 3000);
    if (!cleared) {
      console.warn('[Uni-Chat Bridge] Input did not clear, sending Enter key...');
      dispatchEnterKey(inputElem);
    }

    // 7. Wait for streaming response to finish
    console.log('[Uni-Chat Bridge] Waiting for AI response to finish generating...');
    const resultText = await waitForNewResponse(baselineCount, baselineMessages, 90000);
    console.log(`[Uni-Chat Bridge] Response generated (${resultText.length} chars).`);
    return resultText;
  }

  // ─── DOM Helpers ──────────────────────────────────────────────────────────

  function getExistingAssistantMessages() {
    const list = [];
    const elements = document.querySelectorAll(
      '.ds-markdown, .chat-message-assistant, div[class*="message-assistant"], .ds-chat-bubble, div[class*="message"]:not([class*="user"])'
    );
    elements.forEach((el) => {
      const txt = (el.innerText || el.textContent || '').trim();
      if (txt.length > 5) {
        list.push(txt);
      }
    });
    return list;
  }

  async function waitForInputElement(timeoutMs = 7000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = document.querySelector(
        '#chat-input, textarea, div[contenteditable="true"], [placeholder*="DeepSeek"], [placeholder*="Message"], [placeholder*="Ask"]'
      );
      if (el && !el.disabled) return el;
      await sleep(200);
    }
    return null;
  }

  function setInputText(elem, text) {
    elem.focus();
    if (elem.tagName === 'TEXTAREA' || elem.tagName === 'INPUT') {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) {
        nativeSetter.call(elem, text);
      } else {
        elem.value = text;
      }
      elem.dispatchEvent(new Event('input', { bubbles: true }));
      elem.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (elem.isContentEditable) {
      elem.innerHTML = '';
      document.execCommand('insertText', false, text);
      elem.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  async function clickSendButton(inputElem) {
    await sleep(250);

    // Look for send button near input or globally
    const selectors = [
      'button[type="submit"]',
      'div[role="button"][aria-label*="Send"]',
      'button[aria-label*="Send"]',
      'div.ds-icon-button:last-child',
      'div[class*="send-button"]',
      'button[class*="send"]'
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
        const style = window.getComputedStyle(btn);
        if (style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none') {
          btn.click();
          return true;
        }
      }
    }

    // Fallback: Dispatch Enter key on the input element
    dispatchEnterKey(inputElem);
    return true;
  }

  function dispatchEnterKey(inputElem) {
    inputElem.focus();
    const enterOpts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    inputElem.dispatchEvent(new KeyboardEvent('keydown', enterOpts));
    inputElem.dispatchEvent(new KeyboardEvent('keypress', enterOpts));
    inputElem.dispatchEvent(new KeyboardEvent('keyup', enterOpts));
  }

  async function verifyInputCleared(inputElem, maxWaitMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const val = inputElem.value || inputElem.innerText || '';
      if (val.trim().length === 0) return true;
      await sleep(200);
    }
    return false;
  }

  async function waitForNewResponse(baselineCount, baselineList, maxWaitMs = 90000) {
    const startTime = Date.now();
    let stableText = '';
    let stableCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
      await sleep(1000);

      // Check if generation is in progress (stop button visible)
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop"], div[role="button"][aria-label*="Stop"], div[class*="stop"]'
      );

      const currentMessages = getExistingAssistantMessages();

      // Look for the newest assistant message not in baseline
      let latestMessage = '';
      if (currentMessages.length > baselineCount) {
        latestMessage = currentMessages[currentMessages.length - 1];
      } else if (currentMessages.length > 0) {
        const last = currentMessages[currentMessages.length - 1];
        if (!baselineList.includes(last)) {
          latestMessage = last;
        }
      }

      if (latestMessage && latestMessage.length > 0) {
        if (!stopBtn) {
          // If no stop button, text stability indicates completion
          if (latestMessage === stableText) {
            stableCount++;
            if (stableCount >= 2) {
              return latestMessage;
            }
          } else {
            stableText = latestMessage;
            stableCount = 0;
          }
        } else {
          // Generation is still actively streaming
          stableText = latestMessage;
          stableCount = 0;
        }
      }
    }

    if (stableText && stableText.length > 0) {
      return stableText;
    }
    throw new Error('Timeout waiting for AI response to complete.');
  }

  async function attachImage(base64Data, mimeType, filename = 'image.png') {
    const fileInput = document.querySelector('input[type="file"]');
    if (!fileInput) return false;

    // Convert base64 data to File object
    const byteString = atob(base64Data.split(',')[1] || base64Data);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
      ia[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([ab], { type: mimeType || 'image/png' });
    const file = new File([blob], filename, { type: mimeType || 'image/png' });

    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
