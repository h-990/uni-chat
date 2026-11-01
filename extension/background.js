/**
 * Uni-Chat AI Automator - Background Service Worker
 * Extensible orchestrator connecting Uni-Chat WebSocket with AI Web Interfaces.
 */

import { getAdapter } from './adapters/index.js';
import { getSExprInstruction, parseAIResponse } from './sexpr.js';

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  serverUrl: 'https://chat.unichat.workers.dev',
  aiUsername: 'deepseek',
  aiKey: '',
  batchSize: 20,
  strictTagMode: false,
  adapterId: 'deepseek',
  autoConnect: false,

  // Runtime
  ws: null,
  token: null,
  status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
  statusError: '',
  lastSyncedSeq: 0,
  unroutedMessages: [],
  isProcessing: false,
  hasQueuedTrigger: false,
  hasIntroducedInSession: false,
  activeTabId: null,
  logs: []
};

// ─── Logging ─────────────────────────────────────────────────────────────────

function addLog(type, text) {
  const item = {
    ts: Date.now(),
    type, // 'info' | 'success' | 'warn' | 'error' | 'ai'
    text
  };
  state.logs.unshift(item);
  if (state.logs.length > 100) state.logs.pop();
  broadcastState();
}

// ─── Storage Persistence ─────────────────────────────────────────────────────

async function loadSettings() {
  try {
    const data = await chrome.storage.local.get([
      'serverUrl',
      'aiUsername',
      'aiKey',
      'batchSize',
      'strictTagMode',
      'adapterId',
      'autoConnect',
      'lastSyncedSeq'
    ]);

    if (data.serverUrl) state.serverUrl = data.serverUrl;
    if (data.aiUsername) state.aiUsername = data.aiUsername;
    if (data.aiKey) state.aiKey = data.aiKey;
    if (data.batchSize) state.batchSize = parseInt(data.batchSize, 10) || 20;
    if (typeof data.strictTagMode === 'boolean') state.strictTagMode = data.strictTagMode;
    if (data.adapterId) state.adapterId = data.adapterId;
    if (typeof data.autoConnect === 'boolean') state.autoConnect = data.autoConnect;
    if (typeof data.lastSyncedSeq === 'number') state.lastSyncedSeq = data.lastSyncedSeq;

    addLog('info', `Config loaded. Adapter: ${state.adapterId}, StrictTagMode: ${state.strictTagMode}, Batch: ${state.batchSize}, Last Seq: ${state.lastSyncedSeq}`);

    if (state.autoConnect && state.aiKey) {
      connect();
    }
  } catch (err) {
    console.error('[Uni-Chat Background] Error loading settings:', err);
  }
}

async function saveSettings(newSettings = {}) {
  Object.assign(state, newSettings);
  if (state.strictTagMode) {
    state.unroutedMessages = state.unroutedMessages.filter(m => isMessageTaggedForMe(m));
  }
  await chrome.storage.local.set({
    serverUrl: state.serverUrl,
    aiUsername: state.aiUsername,
    aiKey: state.aiKey,
    batchSize: state.batchSize,
    strictTagMode: state.strictTagMode,
    adapterId: state.adapterId,
    autoConnect: state.autoConnect,
    lastSyncedSeq: state.lastSyncedSeq
  });
  broadcastState();
}

// ─── Authentication & WebSocket Connection ───────────────────────────────────

async function connect() {
  if (state.status === 'connecting' || state.status === 'connected') return;

  const adapter = getAdapter(state.adapterId);

  // 1. Validate credentials
  if (!state.aiKey || state.aiKey.trim().length === 0) {
    state.status = 'error';
    state.statusError = `AI Key / Password is required. Please set the password created by the Admin for @${state.aiUsername}.`;
    addLog('error', state.statusError);
    broadcastState();
    return;
  }

  state.status = 'connecting';
  state.statusError = '';
  addLog('info', `Authenticating as @${state.aiUsername} with ${state.serverUrl}...`);
  broadcastState();

  try {
    // 2. Fetch JWT from server auth
    const authUrl = `${state.serverUrl.replace(/\/+$/, '')}/api/auth`;
    const res = await fetch(authUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: state.aiUsername,
        password: state.aiKey
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Authentication failed with status ${res.status}`);
    }

    const authData = await res.json();
    if (authData.role !== 'ai') {
      throw new Error(`Account @${state.aiUsername} does not have the 'ai' role (current role: ${authData.role}). Admin must register it as AI.`);
    }

    state.token = authData.token;
    addLog('success', `Authenticated successfully as @${state.aiUsername} (role: ai).`);

    // 3. Connect to WebSocket
    const wsUrl = state.serverUrl.replace(/^http/, 'ws').replace(/\/+$/, '') + `/ws?token=${encodeURIComponent(state.token)}`;
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.status = 'connected';
      state.statusError = '';
      addLog('success', `Connected to Uni-Chat room as @${state.aiUsername}.`);
      broadcastState();
      ensureTargetTab(adapter);

      // Perform cold-start brief introduction if not yet done in this session
      if (!state.hasIntroducedInSession) {
        state.hasIntroducedInSession = true;
        setTimeout(() => triggerColdStartIntro(adapter), 2000);
      }
    };

    state.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleServerMessage(msg);
      } catch (err) {
        console.error('[Uni-Chat Background] Error parsing message:', err);
      }
    };

    state.ws.onerror = (err) => {
      console.error('[Uni-Chat Background] WebSocket error:', err);
      state.status = 'error';
      state.statusError = 'WebSocket connection error';
      addLog('error', 'WebSocket error encountered.');
      broadcastState();
    };

    state.ws.onclose = (event) => {
      const wasConnected = state.status === 'connected';
      state.status = 'disconnected';
      state.ws = null;
      addLog('warn', `WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'}).`);
      broadcastState();

      if (wasConnected && state.autoConnect) {
        addLog('info', 'Reconnecting in 5s...');
        setTimeout(() => connect(), 5000);
      }
    };

  } catch (err) {
    state.status = 'error';
    state.statusError = err.message;
    addLog('error', err.message);
    broadcastState();
  }
}

function disconnect() {
  if (state.ws) {
    try { state.ws.close(1000, 'User disconnected'); } catch {}
    state.ws = null;
  }
  state.status = 'disconnected';
  state.statusError = '';
  addLog('info', 'Disconnected by user.');
  broadcastState();
}

// ─── Server Message Handler & Routing Rules ──────────────────────────────────

function handleServerMessage(data) {
  switch (data.type) {
    case 'INIT_STATE': {
      addLog('info', `Joined room. Epoch: ${data.epoch}, Messages: ${data.messages?.length || 0}`);
      
      // Seed lastSyncedSeq if zero
      if (state.lastSyncedSeq === 0 && data.messages && data.messages.length > 0) {
        state.lastSyncedSeq = data.messages[data.messages.length - 1].seq;
        saveSettings({ lastSyncedSeq: state.lastSyncedSeq });
      }

      // Sync server-side tag_only flag for this AI account if present
      if (data.self && typeof data.self.tag_only === 'boolean') {
        if (data.self.tag_only && !state.strictTagMode) {
          state.strictTagMode = true;
          saveSettings({ strictTagMode: true });
        }
      }

      // Check for offline mentions: messages where DeepSeek was tagged while offline!
      if (data.offline_mentions && data.offline_mentions.length > 0) {
        const offlineList = data.offline_mentions;
        addLog('ai', `Detected ${offlineList.length} offline mention(s) sent while @${state.aiUsername} was away! Extracting...`);

        // Acknowledge receipt to server
        const offlineSeqs = offlineList.map(m => m.seq);
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'ACK_OFFLINE_MENTIONS', seqs: offlineSeqs }));
        }

        // Add to unrouted messages as verified tagged mentions and trigger catch-up routing
        for (const m of offlineList) {
          m.is_offline_mention = true;
          if (!state.unroutedMessages.find(existing => existing.seq === m.seq)) {
            state.unroutedMessages.push(m);
          }
        }

        // Trigger prompt catch-up for offline mentions
        setTimeout(() => triggerPrompt(offlineSeqs[offlineSeqs.length - 1]), 1200);
      }
      break;
    }

    case 'AI_SWITCH_CHANGED': {
      if (data.ai_username?.toLowerCase() === state.aiUsername.toLowerCase() && data.switch_id === 'tag_only') {
        state.strictTagMode = Boolean(data.enabled);
        saveSettings({ strictTagMode: state.strictTagMode });
        addLog('info', `Strict Tag Mode synced from server: ${state.strictTagMode ? 'ENABLED' : 'DISABLED'}`);
      }
      break;
    }

    case 'MESSAGE_CREATED': {
      const msg = data.message;
      if (!msg) return;

      const isFromSelfAI = msg.sender_tag?.toLowerCase() === ('@' + state.aiUsername).toLowerCase() || msg.sender_role === 'ai';

      // If message is from this AI itself, do not trigger prompt injection
      if (isFromSelfAI) {
        return;
      }

      // Check if message directly tags this AI
      const isTaggedForMe = isMessageTaggedForMe(msg);

      // ─── STRICT TAG MODE ──────────────────────────────────────────────────
      if (state.strictTagMode) {
        if (!isTaggedForMe) {
          // In Strict Tag Mode, non-tagged messages are completely ignored and not queued
          return;
        }

        // In Strict Tag Mode, ONLY track tagged messages
        if (!state.unroutedMessages.find(m => m.seq === msg.seq)) {
          state.unroutedMessages.push(msg);
        }

        addLog('ai', `[Strict Tag Mode] Direct tag detected in #${msg.seq} from ${msg.sender_tag}. Routing to AI...`);
        triggerPrompt(msg.seq);
        return;
      }

      // ─── NORMAL BATCH MODE ────────────────────────────────────────────────
      // Track incoming message in unrouted list (deduplicating by seq)
      if (!state.unroutedMessages.find(m => m.seq === msg.seq)) {
        state.unroutedMessages.push(msg);
      }

      // Rule 1: Direct tag routes immediately with backlog
      if (isTaggedForMe) {
        addLog('ai', `Direct tag detected in #${msg.seq} from ${msg.sender_tag}. Routing backlog to AI...`);
        triggerPrompt(msg.seq);
        return;
      }

      // Rule 2: Batch size reached
      const humanMessageCount = state.unroutedMessages.filter(m => m.sender_role !== 'ai').length;
      if (humanMessageCount >= state.batchSize) {
        addLog('ai', `Batch threshold reached (${humanMessageCount}/${state.batchSize}). Routing backlog to AI...`);
        triggerPrompt();
        return;
      }

      // Rule 3: Below batch size and untagged -> messages stay in unroutedMessages waiting.
      break;
    }

    case 'PONG':
      break;

    default:
      break;
  }
}

function isMessageTaggedForMe(msg) {
  if (!msg) return false;
  if (msg.is_offline_mention) return true;
  const tagRegex = new RegExp(`@${state.aiUsername}\\b`, 'i');
  if (tagRegex.test(msg.body || '')) return true;
  if (msg.reply_to_seq && isReplyToSelfAI(msg)) return true;
  return false;
}

function isReplyToSelfAI(msg) {
  if (!msg.reply_sender_tag) return false;
  return msg.reply_sender_tag.toLowerCase() === ('@' + state.aiUsername).toLowerCase() || msg.reply_sender_role === 'ai';
}

// ─── Prompt Trigger & Injection Pipeline ─────────────────────────────────────

async function triggerPrompt(triggerSeq = null) {
  if (state.isProcessing) {
    state.hasQueuedTrigger = true;
    addLog('info', 'AI is busy generating; queued for execution immediately after completion.');
    return;
  }

  // In Strict Tag Mode: Strictly route ONLY messages where DeepSeek was tagged (online or offline)
  let messagesToRoute = [...state.unroutedMessages];
  if (state.strictTagMode) {
    messagesToRoute = messagesToRoute.filter(m => isMessageTaggedForMe(m));
  }

  if (messagesToRoute.length === 0) {
    if (state.strictTagMode) {
      state.unroutedMessages = [];
    }
    return;
  }

  const adapter = getAdapter(state.adapterId);
  const tab = await findOrCreateTargetTab(adapter);
  if (!tab) {
    addLog('error', `Cannot route: No active tab found for ${adapter.name} (${adapter.targetUrl}).`);
    return;
  }

  state.isProcessing = true;
  state.hasQueuedTrigger = false;
  broadcastState();

  const maxSeqInBatch = Math.max(...messagesToRoute.map(m => m.seq));

  // Determine target reply-to sequence
  const targetReplySeq = triggerSeq || (messagesToRoute.length > 0 ? messagesToRoute[messagesToRoute.length - 1].seq : null);

  // Build clean sequential prompt with S-expression formatting instruction
  const promptText = formatPrompt(messagesToRoute, state.aiUsername, targetReplySeq);

  // Check if the trigger message has an image attachment
  let imagePayload = null;
  const lastWithImage = [...messagesToRoute].reverse().find(m => m.image_id);
  if (lastWithImage) {
    try {
      imagePayload = await fetchImagePayload(lastWithImage.image_id);
    } catch (err) {
      addLog('warn', `Failed to fetch image #${lastWithImage.image_id}: ${err.message}`);
    }
  }

  addLog('ai', `Dispatching prompt with ${messagesToRoute.length} messages (up to #${maxSeqInBatch}) to ${adapter.name}...`);

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_PROMPT',
      prompt: promptText,
      imagePayload,
      triggerSeq: targetReplySeq
    });

    if (response?.status !== 'executing') {
      throw new Error('Content script did not accept prompt.');
    }
  } catch (err) {
    state.isProcessing = false;
    addLog('error', `Failed to dispatch prompt to tab: ${err.message}. Tab may need refresh.`);
    broadcastState();
  }
}

// ─── Cold Start Brief Introduction ───────────────────────────────────────────

async function triggerColdStartIntro(adapter) {
  if (state.isProcessing) return;

  const tab = await findOrCreateTargetTab(adapter);
  if (!tab) return;

  addLog('info', 'Injecting initial brief introduction on connect...');
  state.isProcessing = true;
  broadcastState();

  const introPrompt = [
    `[System: You have just connected to the Uni-Chat group room as @${state.aiUsername}.]`,
    `[Instructions: Please output a very short one-sentence greeting to the group in S-expression format: (:reply-to 0 :body "your brief greeting here")]`
  ].join('\n');

  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'EXECUTE_PROMPT',
      prompt: introPrompt,
      imagePayload: null,
      triggerSeq: 0
    });
  } catch (err) {
    state.isProcessing = false;
    broadcastState();
  }
}

// ─── Content Script Response Handler ─────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.type === 'PROMPT_COMPLETED') {
    handlePromptCompleted(request.result_text, request.triggerSeq);
  } else if (request.type === 'PROMPT_FAILED') {
    state.isProcessing = false;
    addLog('error', `AI generation failed: ${request.error}`);
    broadcastState();
    checkQueuedTrigger();
  } else if (request.type === 'GET_STATE') {
    broadcastState();
  } else if (request.type === 'CONNECT') {
    connect();
  } else if (request.type === 'DISCONNECT') {
    disconnect();
  } else if (request.type === 'UPDATE_SETTINGS') {
    saveSettings(request.settings);
  }
});

function handlePromptCompleted(rawResultText, triggerSeq) {
  state.isProcessing = false;

  if (!rawResultText || rawResultText.trim().length === 0) {
    addLog('warn', 'AI returned empty response.');
    broadcastState();
    checkQueuedTrigger();
    return;
  }

  // Parse S-expression response (:reply-to <seq> :body "...")
  const parsed = parseAIResponse(rawResultText, triggerSeq);
  const responseBody = parsed.body || rawResultText.trim();
  const replyToSeq = parsed.replyToSeq || triggerSeq || null;

  addLog('success', `AI response parsed (ReplyTo: #${replyToSeq || 'none'}, ${responseBody.length} chars). Broadcasting to Uni-Chat...`);

  // Send response back to Uni-Chat WebSocket
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type: 'SEND_MESSAGE',
      body: responseBody,
      reply_to_seq: replyToSeq
    }));
  }

  // Update sync markers: clear routed messages up to maxSeq
  if (state.unroutedMessages.length > 0) {
    const highestSeq = Math.max(...state.unroutedMessages.map(m => m.seq));
    state.lastSyncedSeq = Math.max(state.lastSyncedSeq, highestSeq);
    state.unroutedMessages = [];
    saveSettings({ lastSyncedSeq: state.lastSyncedSeq });
  }

  broadcastState();
  checkQueuedTrigger();
}

function checkQueuedTrigger() {
  if (state.hasQueuedTrigger && state.unroutedMessages.length > 0) {
    state.hasQueuedTrigger = false;
    setTimeout(() => triggerPrompt(), 1500);
  }
}

// ─── Prompt Builder (With S-Expr & Self-Attribution by Seq Only) ──────────────

function formatPrompt(messages, aiUsername, targetReplySeq = null) {
  const lines = [
    `[System: You are an active participant named @${aiUsername} in a real-time group chat called Uni-Chat.]`,
    `[Below is the conversation transcript since your previous turn:]`,
    ''
  ];

  for (const m of messages) {
    const isAiSelf = m.sender_tag?.toLowerCase() === ('@' + aiUsername).toLowerCase() || m.sender_role === 'ai';

    if (isAiSelf) {
      // Per specification: Do NOT return actual message text of own responses; only place that seq number was your own prev response!
      lines.push(`[#${m.seq} was your own previous response]`);
    } else {
      let senderInfo = `#${m.seq} - ${m.sender_tag}`;
      if (m.reply_to_seq) {
        senderInfo += ` (replying to #${m.reply_to_seq})`;
      }
      let content = m.body || '';
      if (m.image_id) {
        content += ` [Attached Image]`;
      }
      lines.push(`[${senderInfo}]: ${content}`);
    }
  }

  lines.push('');
  // Append S-expression format instruction (without forcing short answers)
  lines.push(getSExprInstruction(targetReplySeq, aiUsername));

  return lines.join('\n');
}

// ─── Image Payload Helper ────────────────────────────────────────────────────

async function fetchImagePayload(imageId) {
  const url = `${state.serverUrl.replace(/\/+$/, '')}/api/image/${imageId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve({
        data: reader.result,
        mime: blob.type || 'image/png',
        name: `image_${imageId}.png`
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─── Tab Discovery & Management ──────────────────────────────────────────────

async function findOrCreateTargetTab(adapter) {
  try {
    const tabs = await chrome.tabs.query({ url: adapter.tabQueryPatterns });
    if (tabs.length > 0) {
      state.activeTabId = tabs[0].id;
      return tabs[0];
    }

    const newTab = await chrome.tabs.create({ url: adapter.targetUrl, active: false });
    state.activeTabId = newTab.id;
    addLog('info', `Opened new tab for ${adapter.name}: ${adapter.targetUrl}`);
    await new Promise(r => setTimeout(r, 4000));
    return newTab;
  } catch (err) {
    console.error('[Uni-Chat Background] Tab query error:', err);
    return null;
  }
}

async function ensureTargetTab(adapter) {
  const tabs = await chrome.tabs.query({ url: adapter.tabQueryPatterns });
  if (tabs.length === 0) {
    addLog('info', `${adapter.name} tab is not currently open. It will be opened automatically upon first prompt.`);
  } else {
    state.activeTabId = tabs[0].id;
    addLog('success', `Connected to active ${adapter.name} tab (ID: ${tabs[0].id}).`);
  }
}

// ─── Keepalive Alarms ────────────────────────────────────────────────────────

chrome.alarms.create('unichat_ping', { periodInMinutes: 0.35 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'unichat_ping') {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'PING' }));
    }
  }
});

chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {});
});

// ─── Broadcast State to Popup ────────────────────────────────────────────────

function broadcastState() {
  const payload = {
    type: 'STATE_UPDATE',
    state: {
      serverUrl: state.serverUrl,
      aiUsername: state.aiUsername,
      aiKey: state.aiKey,
      batchSize: state.batchSize,
      strictTagMode: state.strictTagMode,
      adapterId: state.adapterId,
      autoConnect: state.autoConnect,
      status: state.status,
      statusError: state.statusError,
      lastSyncedSeq: state.lastSyncedSeq,
      unroutedCount: state.unroutedMessages.length,
      isProcessing: state.isProcessing,
      logs: state.logs.slice(0, 30)
    }
  };
  chrome.runtime.sendMessage(payload).catch(() => {});
}

// ─── Initialize ──────────────────────────────────────────────────────────────

loadSettings();
