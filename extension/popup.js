/**
 * Uni-Chat AI Automator - Popup Controller
 */

const adapterSelect = document.getElementById('adapter-select');
const serverUrlInput = document.getElementById('server-url');
const aiUsernameInput = document.getElementById('ai-username');
const aiKeyInput = document.getElementById('ai-key');
const toggleKeyBtn = document.getElementById('toggle-key-visibility');
const batchSizeInput = document.getElementById('batch-size');
const strictTagModeInput = document.getElementById('strict-tag-mode');
const connectBtn = document.getElementById('connect-btn');
const openTabBtn = document.getElementById('open-tab-btn');
const statusPill = document.getElementById('status-pill');
const errorBanner = document.getElementById('error-banner');
const logConsole = document.getElementById('log-console');
const clearLogBtn = document.getElementById('clear-log-btn');

let currentStatus = 'disconnected';

// ─── Initialize ──────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Request current state from background service worker
  chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch(() => {});
});

// Listen for updates from background
chrome.runtime.onMessage.addListener((request) => {
  if (request.type === 'STATE_UPDATE' && request.state) {
    renderState(request.state);
  }
});

function renderState(state) {
  currentStatus = state.status;

  // Status pill
  statusPill.className = `status-pill ${state.status}`;
  if (state.isProcessing) {
    statusPill.textContent = 'Generating...';
    statusPill.className = 'status-pill connecting';
  } else {
    statusPill.textContent = state.status.toUpperCase();
  }

  // Connect button
  if (state.status === 'connected') {
    connectBtn.textContent = 'Disconnect';
    connectBtn.className = 'btn-primary disconnect';
  } else if (state.status === 'connecting') {
    connectBtn.textContent = 'Connecting...';
    connectBtn.className = 'btn-primary';
  } else {
    connectBtn.textContent = 'Connect as AI';
    connectBtn.className = 'btn-primary';
  }

  // Error banner
  if (state.status === 'error' && state.statusError) {
    errorBanner.textContent = state.statusError;
    errorBanner.hidden = false;
  } else {
    errorBanner.hidden = true;
  }

  // Populate inputs if not focused
  if (document.activeElement !== serverUrlInput && state.serverUrl) {
    serverUrlInput.value = state.serverUrl;
  }
  if (document.activeElement !== aiUsernameInput && state.aiUsername) {
    aiUsernameInput.value = state.aiUsername;
  }
  if (document.activeElement !== aiKeyInput && state.aiKey) {
    aiKeyInput.value = state.aiKey;
  }
  if (document.activeElement !== batchSizeInput && state.batchSize) {
    batchSizeInput.value = state.batchSize;
  }
  if (document.activeElement !== adapterSelect && state.adapterId) {
    adapterSelect.value = state.adapterId;
  }
  if (typeof state.strictTagMode === 'boolean') {
    strictTagModeInput.checked = state.strictTagMode;
  }

  // Render logs
  if (state.logs && state.logs.length > 0) {
    logConsole.innerHTML = state.logs
      .map((item) => {
        const timeStr = new Date(item.ts).toLocaleTimeString();
        return `<div class="log-entry ${item.type}">[${timeStr}] ${escapeHtml(item.text)}</div>`;
      })
      .join('');
    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

// ─── Input Change Listeners ──────────────────────────────────────────────────

function saveFormSettings() {
  const settings = {
    serverUrl: serverUrlInput.value.trim(),
    aiUsername: aiUsernameInput.value.trim(),
    aiKey: aiKeyInput.value.trim(),
    batchSize: parseInt(batchSizeInput.value, 10) || 20,
    strictTagMode: Boolean(strictTagModeInput.checked),
    adapterId: adapterSelect.value
  };

  chrome.runtime.sendMessage({
    type: 'UPDATE_SETTINGS',
    settings
  }).catch(() => {});
}

[serverUrlInput, aiUsernameInput, aiKeyInput, batchSizeInput, adapterSelect].forEach((elem) => {
  elem.addEventListener('change', saveFormSettings);
  elem.addEventListener('input', saveFormSettings);
});
strictTagModeInput.addEventListener('change', saveFormSettings);

// Toggle password visibility
toggleKeyBtn.addEventListener('click', () => {
  if (aiKeyInput.type === 'password') {
    aiKeyInput.type = 'text';
    toggleKeyBtn.textContent = '🔒';
  } else {
    aiKeyInput.type = 'password';
    toggleKeyBtn.textContent = '👁';
  }
});

// ─── Connect Button ──────────────────────────────────────────────────────────

connectBtn.addEventListener('click', () => {
  saveFormSettings();

  if (currentStatus === 'connected') {
    chrome.runtime.sendMessage({ type: 'DISCONNECT' }).catch(() => {});
  } else {
    const key = aiKeyInput.value.trim();
    if (!key) {
      errorBanner.textContent = 'AI Key is required. Enter the password set by the Admin for the AI account.';
      errorBanner.hidden = false;
      aiKeyInput.focus();
      return;
    }
    errorBanner.hidden = true;
    chrome.runtime.sendMessage({ type: 'CONNECT' }).catch(() => {});
  }
});

// ─── Open Target Tab Button ──────────────────────────────────────────────────

openTabBtn.addEventListener('click', () => {
  const targetUrl = 'https://chat.deepseek.com';
  chrome.tabs.query({ url: '*://*.deepseek.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: targetUrl });
    }
  });
});

// ─── Clear Logs ──────────────────────────────────────────────────────────────

clearLogBtn.addEventListener('click', () => {
  logConsole.innerHTML = '<div class="log-entry info">Logs cleared.</div>';
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
