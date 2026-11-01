// ============================================================================
// UNI-CHAT — Frontend Application
// Single-file SPA: Auth, WebSocket Chat, Replies, Images, Admin Dashboard
// ============================================================================

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────────

  const state = {
    token: localStorage.getItem('uni-chat-token'),
    self: null,          // { username, tag, role }
    epoch: 1,
    ws: null,
    messages: [],        // Array of message objects
    onlineUsers: [],     // Array of { username, role }
    replyTo: null,       // Message object being replied to
    pendingImageId: null, // Uploaded image ID awaiting send
    pendingImageFile: null,
    adminPage: 1,
    adminTotal: 0,
    sidebarOpen: false,
    aiSwitches: { deepseek: { deepthink: false, search: false, tag_only: false } },
    activeAiModalUser: null,
    isImportantActive: false,
  };

  // ─── DOM Refs ────────────────────────────────────────────────────────────

  const $ = (id) => document.getElementById(id);
  const loginView = $('login-view');
  const chatView = $('chat-view');
  const loginForm = $('login-form');
  const loginUsername = $('login-username');
  const loginPassword = $('login-password');
  const loginError = $('login-error');
  const loginBtn = $('login-btn');

  const headerEpoch = $('header-epoch');
  const onlineCountText = $('online-count-text');
  const adminPanelBtn = $('admin-panel-btn');
  const logoutBtn = $('logout-btn');
  const sidebarToggle = $('sidebar-toggle');
  const sidebar = $('sidebar');
  const onlineUsersList = $('online-users-list');
  const selfInfo = $('self-info');

  const messagesContainer = $('messages-container');
  const messageInput = $('message-input');
  const sendBtn = $('send-btn');
  const imageUploadBtn = $('image-upload-btn');
  const imageFileInput = $('image-file-input');
  const importantToggleBtn = $('important-toggle-btn');

  const replyBar = $('reply-bar');
  const replyBarTag = $('reply-bar-tag');
  const replyBarText = $('reply-bar-text');
  const replyCancel = $('reply-cancel');

  const imagePreviewBar = $('image-preview-bar');
  const imagePreviewThumb = $('image-preview-thumb');
  const imagePreviewName = $('image-preview-name');
  const imagePreviewSize = $('image-preview-size');
  const imagePreviewCancel = $('image-preview-cancel');

  const adminOverlay = $('admin-overlay');
  const adminClose = $('admin-close');

  const aiModalOverlay = $('ai-modal-overlay');
  const aiModalClose = $('ai-modal-close');
  const aiModalName = $('ai-modal-name');
  const aiModalAvatar = $('ai-modal-avatar');
  const aiSwitchesContainer = $('ai-switches-container');
  const lightbox = $('lightbox');
  const lightboxImg = $('lightbox-img');
  const lightboxClose = $('lightbox-close');

  const confirmDialog = $('confirm-dialog');
  const confirmTitle = $('confirm-title');
  const confirmMessage = $('confirm-message');
  const confirmCancel = $('confirm-cancel');
  const confirmOk = $('confirm-ok');

  // Mention autocomplete, emoji picker, mobile drawer backdrop, message info modal
  const sidebarBackdrop = $('sidebar-backdrop');
  const mentionAutocomplete = $('mention-autocomplete');
  const emojiPickerBtn = $('emoji-picker-btn');
  const emojiPickerPanel = $('emoji-picker-panel');

  const msgInfoModalOverlay = $('msg-info-modal-overlay');
  const msgInfoSeqPill = $('msg-info-seq-pill');
  const msgInfoClose = $('msg-info-close');
  const msgInfoAvatar = $('msg-info-avatar');
  const msgInfoSender = $('msg-info-sender');
  const msgInfoRoleBadge = $('msg-info-role-badge');
  const msgInfoImportantBadge = $('msg-info-important-badge');
  const msgInfoFullTime = $('msg-info-full-time');
  const msgInfoReplyBox = $('msg-info-reply-box');
  const msgInfoReplyTarget = $('msg-info-reply-target');
  const msgInfoTextPreview = $('msg-info-text-preview');
  const msgInfoImageContainer = $('msg-info-image-container');
  const msgInfoImage = $('msg-info-image');
  const msgInfoReplyBtn = $('msg-info-reply-btn');
  const msgInfoCopyBtn = $('msg-info-copy-btn');
  const msgInfoStarBtn = $('msg-info-star-btn');
  const msgInfoDeleteBtn = $('msg-info-delete-btn');

  let currentInfoMsg = null;

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function apiUrl(path) {
    return path; // Same origin
  }

  function getAllKnownUsers() {
    const map = new Map();

    // 1. AI accounts & active switches
    if (state.aiSwitches) {
      Object.keys(state.aiSwitches).forEach((aiName) => {
        const clean = aiName.replace(/^@/, '').toLowerCase();
        map.set(clean, {
          name: clean,
          tag: '@' + clean,
          role: 'ai',
          displayName: '@' + clean,
          isAi: true
        });
      });
    }

    // 2. Online users
    (state.onlineUsers || []).forEach((u) => {
      const rawTag = u.tag || u.username || '';
      const clean = rawTag.replace(/^@/, '').toLowerCase();
      if (!clean) return;
      map.set(clean, {
        name: clean,
        tag: '@' + clean,
        role: u.role || 'user',
        displayName: u.nickname || ('@' + clean),
        isAi: u.role === 'ai' || (state.aiSwitches && Boolean(state.aiSwitches[clean]))
      });
    });

    // 3. Past message senders from history
    (state.messages || []).forEach((m) => {
      const rawTag = m.sender_tag || '';
      const clean = rawTag.replace(/^@/, '').toLowerCase();
      if (!clean) return;
      if (!map.has(clean)) {
        map.set(clean, {
          name: clean,
          tag: '@' + clean,
          role: m.sender_role || 'user',
          displayName: '@' + clean,
          isAi: m.sender_role === 'ai' || (state.aiSwitches && Boolean(state.aiSwitches[clean]))
        });
      }
    });

    return Array.from(map.values());
  }

  function findUserByMention(mentionName) {
    if (!mentionName) return null;
    const clean = mentionName.replace(/^@/, '').trim().toLowerCase();
    const all = getAllKnownUsers();
    return all.find((u) => u.name === clean) || null;
  }

  function insertMentionInInput(tag) {
    const val = messageInput.value;
    const cleanTag = tag.startsWith('@') ? tag : '@' + tag;
    const needsSpace = val.length > 0 && !val.endsWith(' ');
    messageInput.value = val + (needsSpace ? ' ' : '') + cleanTag + ' ';
    messageInput.focus();
    autoResizeTextarea();
  }

  function autoResizeTextarea() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 150) + 'px';
  }

  function getRelativeTimeString(ts) {
    const elapsedMs = Date.now() - ts;
    const elapsedSec = Math.floor(elapsedMs / 1000);
    if (elapsedSec < 10) return 'just now';
    if (elapsedSec < 60) return `${elapsedSec}s ago`;
    const elapsedMin = Math.floor(elapsedSec / 60);
    if (elapsedMin < 60) return `${elapsedMin}m ago`;
    const elapsedHr = Math.floor(elapsedMin / 60);
    if (elapsedHr < 24) return `${elapsedHr}h ago`;
    const elapsedDays = Math.floor(elapsedHr / 24);
    return `${elapsedDays}d ago`;
  }

  async function apiFetch(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    const res = await fetch(apiUrl(path), { ...opts, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function roleBadge(role) {
    return `<span class="badge badge-${role}">${role}</span>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showConfirm(title, message) {
    return new Promise((resolve) => {
      confirmTitle.textContent = title;
      confirmMessage.textContent = message;
      confirmDialog.hidden = false;
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      const cleanup = () => {
        confirmDialog.hidden = true;
        confirmOk.removeEventListener('click', onOk);
        confirmCancel.removeEventListener('click', onCancel);
      };
      confirmOk.addEventListener('click', onOk);
      confirmCancel.addEventListener('click', onCancel);
    });
  }

  // ─── Pluggable Renderer Registry ─────────────────────────────────────────

  window.CUSTOM_MESSAGE_RENDERERS = [];

  // ─── Message Rendering Pipeline ──────────────────────────────────────────

  function renderMessageBody(rawText, containerEl) {
    // 1. Extract fenced code blocks first
    const codeBlocks = [];
    let processed = rawText.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang, code });
      return `\x00CODE_BLOCK_${idx}\x00`;
    });

    // 2. Extract display math $$...$$
    const mathBlocks = [];
    processed = processed.replace(/\$\$([\s\S]*?)\$\$/g, (match, tex) => {
      const idx = mathBlocks.length;
      mathBlocks.push({ tex, display: true });
      return `\x00MATH_BLOCK_${idx}\x00`;
    });

    // 3. Split into paragraphs
    const paragraphs = processed.split(/\n\n+/);

    paragraphs.forEach((para) => {
      const lines = para.split('\n');
      const p = document.createElement('p');

      lines.forEach((line, lineIdx) => {
        if (lineIdx > 0) p.appendChild(document.createElement('br'));

        // Check for code block placeholder
        const codeMatch = line.match(/\x00CODE_BLOCK_(\d+)\x00/);
        if (codeMatch) {
          const block = codeBlocks[parseInt(codeMatch[1])];
          const pre = document.createElement('pre');
          const code = document.createElement('code');
          if (block.lang) code.className = 'language-' + block.lang;
          code.textContent = block.code;
          pre.appendChild(code);
          containerEl.appendChild(pre);
          // Try to highlight
          try { if (window.hljs) window.hljs.highlightElement(code); } catch {}
          return;
        }

        // Check for math block placeholder
        const mathMatch = line.match(/\x00MATH_BLOCK_(\d+)\x00/);
        if (mathMatch) {
          const block = mathBlocks[parseInt(mathMatch[1])];
          const span = document.createElement('div');
          span.className = 'math-block';
          try {
            if (window.katex) {
              window.katex.render(block.tex, span, { displayMode: true, throwOnError: false });
            } else {
              span.textContent = '$$' + block.tex + '$$';
            }
          } catch { span.textContent = '$$' + block.tex + '$$'; }
          containerEl.appendChild(span);
          return;
        }

        // Process inline tokens
        renderInlineTokens(line, p);
      });

      if (p.childNodes.length > 0) containerEl.appendChild(p);
    });

    // 4. Run custom renderers
    for (const renderer of window.CUSTOM_MESSAGE_RENDERERS) {
      try {
        const text = containerEl.textContent;
        const match = text.match(renderer.matchRegex);
        if (match) {
          const mountNode = document.createElement('div');
          renderer.renderFn(match, mountNode);
          containerEl.appendChild(mountNode);
        }
      } catch {}
    }
  }

  function renderInlineTokens(text, parentEl) {
    // Process: inline code, inline math, mentions, links, bold, italic
    const regex = /(`[^`]+`)|(\$[^$]+\$)|(@\w+)|(https?:\/\/[^\s<]+)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;

    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      // Add text before match
      if (match.index > lastIndex) {
        parentEl.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[1]) {
        // Inline code
        const code = document.createElement('code');
        code.textContent = match[1].slice(1, -1);
        parentEl.appendChild(code);
      } else if (match[2]) {
        // Inline math
        const span = document.createElement('span');
        try {
          if (window.katex) {
            window.katex.render(match[2].slice(1, -1), span, { displayMode: false, throwOnError: false });
          } else {
            span.textContent = match[2];
          }
        } catch { span.textContent = match[2]; }
        parentEl.appendChild(span);
      } else if (match[3]) {
        // @mention check if exists
        const rawMention = match[3];
        const knownUser = findUserByMention(rawMention);
        if (knownUser) {
          const mention = document.createElement('span');
          mention.className = `mention-tag clickable ${knownUser.isAi ? 'role-ai' : ''}`;
          mention.textContent = rawMention;
          mention.title = knownUser.isAi ? `Open ${rawMention} options` : `Mention ${rawMention}`;
          mention.setAttribute('role', 'button');
          mention.setAttribute('tabindex', '0');
          mention.addEventListener('click', (e) => {
            e.stopPropagation();
            if (knownUser.isAi) {
              openAiModal(knownUser.name);
            } else {
              insertMentionInInput(knownUser.tag);
            }
          });
          parentEl.appendChild(mention);
        } else {
          // If @<following-name> doesn't match any user's name it won't be clickable
          parentEl.appendChild(document.createTextNode(rawMention));
        }
      } else if (match[4]) {
        // URL
        const link = document.createElement('a');
        link.href = match[4];
        link.textContent = match[4].length > 50 ? match[4].slice(0, 47) + '...' : match[4];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parentEl.appendChild(link);
      } else if (match[5]) {
        // Bold
        const b = document.createElement('strong');
        b.textContent = match[5].slice(2, -2);
        parentEl.appendChild(b);
      } else if (match[6]) {
        // Italic
        const i = document.createElement('em');
        i.textContent = match[6].slice(1, -1);
        parentEl.appendChild(i);
      }

      lastIndex = match.index + match[0].length;
    }

    // Remaining text
    if (lastIndex < text.length) {
      parentEl.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    // If nothing was added (empty string), add the text as-is
    if (lastIndex === 0 && text.length === 0) return;
    if (parentEl.childNodes.length === 0) {
      parentEl.appendChild(document.createTextNode(text));
    }
  }

  // ─── Auth ────────────────────────────────────────────────────────────────

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.hidden = true;
    loginBtn.disabled = true;

    try {
      const data = await apiFetch('/api/auth', {
        method: 'POST',
        body: JSON.stringify({
          username: loginUsername.value.trim(),
          password: loginPassword.value,
        }),
      });

      state.token = data.token;
      localStorage.setItem('uni-chat-token', data.token);
      state.self = { username: data.username, tag: '@' + data.username, role: data.role };
      showChat();
    } catch (err) {
      loginError.textContent = err.message;
      loginError.hidden = false;
    } finally {
      loginBtn.disabled = false;
    }
  });

  logoutBtn.addEventListener('click', () => {
    state.token = null;
    state.self = null;
    localStorage.removeItem('uni-chat-token');
    if (state.ws) { state.ws.close(); state.ws = null; }
    state.messages = [];
    state.onlineUsers = [];
    chatView.hidden = true;
    loginView.hidden = false;
    loginForm.reset();
  });

  // ─── Chat Initialization ────────────────────────────────────────────────

  function showChat() {
    loginView.hidden = true;
    chatView.hidden = false;
    connectWebSocket();
  }

  function connectWebSocket() {
    if (state.ws) { state.ws.close(); state.ws = null; }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws?token=${state.token}`;

    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.addEventListener('open', () => {
      console.log('[WS] Connected');
    });

    ws.addEventListener('message', (evt) => {
      try {
        const data = JSON.parse(evt.data);
        handleWsMessage(data);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    });

    ws.addEventListener('close', (evt) => {
      console.log('[WS] Closed:', evt.code, evt.reason);
      state.ws = null;
      // Auto-reconnect after 3 seconds
      if (state.token) {
        setTimeout(() => {
          if (state.token && !state.ws) connectWebSocket();
        }, 3000);
      }
    });

    ws.addEventListener('error', (err) => {
      console.error('[WS] Error:', err);
    });
  }

  // ─── WebSocket Message Handler ───────────────────────────────────────────

  function handleWsMessage(data) {
    switch (data.type) {
      case 'INIT_STATE':
        state.self = data.self;
        state.epoch = data.epoch;
        state.messages = data.messages || [];
        state.onlineUsers = data.onlineUsers || [];
        state.aiSwitches = data.aiSwitches || { deepseek: { deepthink: false, search: false } };
        headerEpoch.textContent = 'Epoch ' + data.epoch;
        updateOnlineUsers();
        renderSelfInfo();
        renderAllMessages();
        scrollToBottom();

        // Show admin button if admin
        if (state.self.role === 'admin') {
          adminPanelBtn.hidden = false;
        }
        break;

      case 'AI_SWITCH_CHANGED':
        if (!state.aiSwitches[data.ai_username]) state.aiSwitches[data.ai_username] = {};
        state.aiSwitches[data.ai_username][data.switch_id] = data.enabled;
        if (state.activeAiModalUser === data.ai_username) {
          renderAiModalSwitches(data.ai_username);
        }
        updateOnlineUsers();
        break;

      case 'AI_SWITCHES_REGISTERED':
        state.aiSwitches[data.ai_username] = { ...(state.aiSwitches[data.ai_username] || {}), ...data.switches };
        if (state.activeAiModalUser === data.ai_username) {
          renderAiModalSwitches(data.ai_username);
        }
        updateOnlineUsers();
        break;

      case 'MESSAGE_CREATED':
        state.messages.push(data.message);
        appendMessage(data.message);
        // Auto-scroll if near bottom or if sent by self
        if (isNearBottom() || data.message.sender_tag === state.self?.tag) {
          scrollToBottom();
        }
        break;

      case 'MESSAGE_IMPORTANT_CHANGED': {
        const m = state.messages.find((x) => x.seq === data.seq);
        if (m) m.is_important = data.is_important;

        const el = messagesContainer.querySelector(`[data-msg-seq="${data.seq}"]`);
        if (el) {
          const bubble = el.querySelector('.msg-bubble');
          if (bubble) bubble.classList.toggle('is-important', data.is_important);

          const starBtn = el.querySelector('.msg-star-btn');
          if (starBtn) {
            starBtn.classList.toggle('is-important', data.is_important);
            starBtn.title = data.is_important ? 'Unmark Important' : 'Mark as Important';
          }

          let badge = el.querySelector('.msg-important-badge');
          if (data.is_important) {
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'msg-important-badge';
              badge.title = 'Marked as Important (synced during offline catch-up)';
              badge.textContent = '⭐ Important';
              const header = el.querySelector('.msg-header');
              if (header) {
                const timeEl = header.querySelector('.msg-time');
                header.insertBefore(badge, timeEl);
              }
            }
          } else if (badge) {
            badge.remove();
          }
        }

        if (currentInfoMsg && currentInfoMsg.seq === data.seq) {
          currentInfoMsg.is_important = data.is_important;
          msgInfoImportantBadge.hidden = !data.is_important;
          updateInfoStarBtnState(data.is_important);
        }
        break;
      }

      case 'CHAT_CLEARED':
        state.epoch = data.epoch;
        state.messages = [];
        headerEpoch.textContent = 'Epoch ' + data.epoch;
        messagesContainer.innerHTML = '';
        addSystemMessage('Chat has been cleared by admin. Epoch ' + data.epoch);
        break;

      case 'USER_JOINED':
        if (!state.onlineUsers.find(u => u.username === data.username)) {
          state.onlineUsers.push({ username: data.username, role: data.role });
        }
        updateOnlineUsers();
        break;

      case 'USER_LEFT':
        state.onlineUsers = state.onlineUsers.filter(u => u.username !== data.username);
        updateOnlineUsers();
        break;

      case 'MESSAGE_DELETED':
        state.messages = state.messages.filter(m => m.seq !== data.seq);
        if (currentInfoMsg && currentInfoMsg.seq === data.seq) {
          closeMessageInfoModal();
        }
        const elToDelete = messagesContainer.querySelector(`[data-msg-seq="${data.seq}"]`);
        if (elToDelete) {
          elToDelete.style.transition = 'opacity 0.3s, transform 0.3s';
          elToDelete.style.opacity = '0';
          elToDelete.style.transform = 'scale(0.95)';
          setTimeout(() => elToDelete.remove(), 300);
        }
        break;

      case 'MEDIA_DELETED':
        const imgs = messagesContainer.querySelectorAll(`img[src*="${data.image_id}"]`);
        imgs.forEach(img => {
          const placeholder = document.createElement('div');
          placeholder.className = 'media-deleted-tag';
          placeholder.textContent = '🗑️ [Image removed by admin]';
          img.replaceWith(placeholder);
        });
        break;

      case 'PONG':
        break;

      case 'ERROR':
        console.error('[Server Error]', data.message);
        break;
    }
  }

  // ─── Online Users ────────────────────────────────────────────────────────

  function updateOnlineUsers() {
    onlineCountText.textContent = state.onlineUsers.length + ' online';

    onlineUsersList.innerHTML = '';
    state.onlineUsers.forEach((u) => {
      const isAi = u.role === 'ai';
      const li = document.createElement('li');
      li.className = `online-user-item ${isAi ? 'ai-user-clickable' : ''}`;

      // Check if this AI has any active switches
      const switches = state.aiSwitches[u.username] || {};
      let miniTagsHtml = '';
      if (isAi) {
        if (switches.deepthink) {
          miniTagsHtml += '<span class="ai-mini-tag" title="DeepThink R1 reasoning active">🧠 R1</span>';
        }
        if (switches.search) {
          miniTagsHtml += '<span class="ai-mini-tag" title="Web Search browsing active">🌐 Web</span>';
        }
      }

      li.innerHTML = `
        <div class="user-avatar role-${u.role}">${u.username[0].toUpperCase()}</div>
        <div class="ai-item-content">
          <span class="user-name">${escapeHtml(u.username)}</span>
          ${roleBadge(u.role)}
          <div class="ai-switches-mini-tags">${miniTagsHtml}</div>
          ${isAi ? '<button class="ai-config-btn" title="View & toggle AI public switches">⚙️</button>' : ''}
        </div>
      `;

      if (isAi) {
        li.title = `Click to configure public switches for @${u.username}`;
        li.addEventListener('click', () => {
          openAiModal(u.username);
        });
      }

      onlineUsersList.appendChild(li);
    });
  }

  // ─── AI Controls Modal ───────────────────────────────────────────────────

  function openAiModal(username) {
    state.activeAiModalUser = username;
    aiModalName.textContent = '@' + username;
    aiModalAvatar.textContent = username[0].toUpperCase();
    aiModalAvatar.className = 'user-avatar role-ai';
    renderAiModalSwitches(username);
    aiModalOverlay.hidden = false;
  }

  function closeAiModal() {
    aiModalOverlay.hidden = true;
    state.activeAiModalUser = null;
  }

  aiModalClose.addEventListener('click', closeAiModal);
  aiModalOverlay.addEventListener('click', (e) => {
    if (e.target === aiModalOverlay) closeAiModal();
  });

  function renderAiModalSwitches(username) {
    const switches = state.aiSwitches[username] || { deepthink: false, search: false, tag_only: false };

    // Capability definitions (can be extended for any AI provider)
    const switchDefs = [
      {
        id: 'deepthink',
        title: 'DeepThink (R1 Reasoning)',
        icon: '🧠',
        desc: 'Forces DeepSeek R1 reasoning chain-of-thought before formulating its answer.',
        enabled: Boolean(switches.deepthink),
      },
      {
        id: 'search',
        title: 'Web Search (Live Browse)',
        icon: '🌐',
        desc: 'Enables real-time internet search for up-to-date facts and web verification.',
        enabled: Boolean(switches.search),
      },
      {
        id: 'tag_only',
        title: 'Tag-Only Privacy Mode',
        icon: '🔒',
        desc: 'When enabled, this AI only receives and responds to messages when directly tagged (@' + escapeHtml(username) + ') or replied to.',
        enabled: Boolean(switches.tag_only),
      },
    ];

    aiSwitchesContainer.innerHTML = '';
    switchDefs.forEach((s) => {
      const card = document.createElement('div');
      card.className = `ai-switch-card ${s.enabled ? 'active' : ''}`;
      card.innerHTML = `
        <div class="ai-switch-left">
          <div class="ai-switch-icon">${s.icon}</div>
          <div class="ai-switch-meta">
            <h4>${s.title}</h4>
            <p>${s.desc}</p>
          </div>
        </div>
        <div class="ai-switch-right">
          <span class="switch-state-label ${s.enabled ? 'is-on' : ''}">${s.enabled ? 'ON' : 'OFF'}</span>
          <label class="ai-toggle">
            <input type="checkbox" data-switch="${s.id}" ${s.enabled ? 'checked' : ''}>
            <span class="ai-toggle-slider"></span>
          </label>
        </div>
      `;

      const checkbox = card.querySelector('input');
      checkbox.addEventListener('change', (e) => {
        const newChecked = e.target.checked;
        toggleAiSwitch(username, s.id, newChecked);
      });

      aiSwitchesContainer.appendChild(card);
    });
  }

  function toggleAiSwitch(aiUsername, switchId, enabled) {
    // Optimistic local update
    if (!state.aiSwitches[aiUsername]) state.aiSwitches[aiUsername] = {};
    state.aiSwitches[aiUsername][switchId] = enabled;
    renderAiModalSwitches(aiUsername);
    updateOnlineUsers();

    // Broadcast change to server via WebSocket
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'SET_AI_SWITCH',
        ai_username: aiUsername,
        switch_id: switchId,
        enabled: enabled,
      }));
    }
  }

  function renderSelfInfo() {
    if (!state.self) return;
    selfInfo.innerHTML = `
      <div class="user-avatar role-${state.self.role}">${state.self.username[0]}</div>
      <div>
        <div style="font-weight:600">${escapeHtml(state.self.username)}</div>
        <div>${roleBadge(state.self.role)}</div>
      </div>
    `;
  }

  // ─── Message Rendering ──────────────────────────────────────────────────

  function renderAllMessages() {
    messagesContainer.innerHTML = '';
    state.messages.forEach((msg, idx) => {
      appendMessage(msg, idx > 0 ? state.messages[idx - 1] : null);
    });
  }

  function appendMessage(msg, prevMsg) {
    if (!prevMsg && state.messages.length > 1) {
      const idx = state.messages.indexOf(msg);
      prevMsg = idx > 0 ? state.messages[idx - 1] : null;
    }

    const isSelf = Boolean(
      state.self?.tag &&
      msg.sender_tag &&
      msg.sender_tag.toLowerCase() === state.self.tag.toLowerCase()
    );
    const isContinuation = Boolean(
      prevMsg &&
      prevMsg.sender_tag &&
      msg.sender_tag &&
      prevMsg.sender_tag.toLowerCase() === msg.sender_tag.toLowerCase() &&
      (msg.ts - prevMsg.ts) < 120000 &&
      !msg.reply_to_seq
    );

    const el = document.createElement('div');

    if (isContinuation) {
      el.className = `message-continuation ${isSelf ? 'self' : 'other'}`;
      el.innerHTML = `<div class="msg-bubble ${msg.sender_role === 'ai' && !isSelf ? 'role-ai' : ''} ${msg.is_important ? 'is-important' : ''}" data-seq="${msg.seq}"></div>`;
    } else {
      el.className = `message-group ${isSelf ? 'self' : 'other'}`;
      el.innerHTML = `
        <div class="msg-avatar role-${msg.sender_role}">${msg.sender_tag.replace('@', '')[0]}</div>
        <div class="msg-content">
          <div class="msg-header">
            <span class="msg-sender role-${msg.sender_role}">${escapeHtml(msg.sender_tag)}</span>
            ${roleBadge(msg.sender_role)}
            ${msg.is_important ? '<span class="msg-important-badge" title="Marked as Important (synced during offline catch-up)">⭐ Important</span>' : ''}
            <span class="msg-time">${formatTime(msg.ts)}</span>
            <span class="msg-seq">#${msg.seq}</span>
          </div>
          <div class="msg-bubble ${msg.sender_role === 'ai' && !isSelf ? 'role-ai' : ''} ${msg.is_important ? 'is-important' : ''}" data-seq="${msg.seq}"></div>
        </div>
      `;
    }

    const bubble = el.querySelector('.msg-bubble');

    // Reply preview
    if (msg.reply_to_seq) {
      const replyDiv = document.createElement('div');
      replyDiv.className = 'msg-reply-preview';
      let thumbHtml = '';
      if (msg.reply_image_id) {
        thumbHtml = `<img src="/api/image/${msg.reply_image_id}" class="reply-preview-thumb" alt="Thumbnail">`;
      }
      replyDiv.innerHTML = `
        ${thumbHtml}
        <div class="reply-preview-body">
          <span class="reply-preview-tag">${escapeHtml(msg.reply_sender_tag || ('#' + msg.reply_to_seq))}</span>
          <span class="reply-preview-text">${escapeHtml(msg.reply_body_preview || (msg.reply_image_id ? '📎 [Image]' : '...'))}</span>
        </div>
      `;
      replyDiv.addEventListener('click', () => scrollToMessage(msg.reply_to_seq));
      bubble.appendChild(replyDiv);
    }

    // Message body
    if (msg.body) {
      const bodyContainer = document.createElement('div');
      renderMessageBody(msg.body, bodyContainer);
      bubble.appendChild(bodyContainer);
    }

    // Image
    if (msg.image_id) {
      const img = document.createElement('img');
      img.className = 'msg-image';
      img.src = `/api/image/${msg.image_id}`;
      img.alt = 'Shared image';
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(img.src));
      bubble.appendChild(img);
    }

    // Action buttons (Star Important, Reply)
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'msg-actions';
    actionsDiv.innerHTML = `
      <button class="msg-action-btn msg-star-btn ${msg.is_important ? 'is-important' : ''}" title="${msg.is_important ? 'Unmark Important' : 'Mark as Important'}" data-star-seq="${msg.seq}">⭐</button>
      <button class="msg-action-btn msg-reply-btn" title="Reply" data-reply-seq="${msg.seq}">↩</button>
    `;
    bubble.appendChild(actionsDiv);

    // PC Chrome / Desktop Hover Quick Reply Button
    const hoverReplyBtn = document.createElement('button');
    hoverReplyBtn.className = 'msg-hover-reply-btn';
    hoverReplyBtn.title = `Reply to #${msg.seq} (${msg.sender_tag})`;
    hoverReplyBtn.setAttribute('aria-label', 'Reply to message');
    hoverReplyBtn.type = 'button';
    hoverReplyBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 17 4 12 9 7"></polyline>
        <path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>
      </svg>
      <span class="hover-reply-label">Reply</span>
    `;
    hoverReplyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      setReplyTo(msg);
    });
    bubble.appendChild(hoverReplyBtn);

    // Star button handler
    actionsDiv.querySelector('.msg-star-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: 'TOGGLE_MESSAGE_IMPORTANT',
          seq: msg.seq,
        }));
      }
    });

    // Reply button handler
    actionsDiv.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      setReplyTo(msg);
    });

    // Swipe-to-reply hint icon
    const swipeHint = document.createElement('div');
    swipeHint.className = 'swipe-reply-hint';
    swipeHint.textContent = '↩';
    el.appendChild(swipeHint);

    // Swipe-to-reply and double-tap touch gestures
    let touchStartX = 0;
    let touchStartY = 0;
    let isSwiping = false;
    let lastTapTime = 0;

    el.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      isSwiping = false;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;

      if (!isSwiping) {
        if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.3) {
          isSwiping = true;
          el.classList.add('swiping');
        }
      }

      if (isSwiping && dx > 0) {
        if (e.cancelable) e.preventDefault();
        const moveX = Math.min(dx, 80);
        el.style.transform = `translateX(${moveX}px)`;
        const progress = Math.min(moveX / 50, 1);
        swipeHint.style.opacity = progress;
        swipeHint.style.transform = `translateY(-50%) scale(${0.7 + progress * 0.45})`;
        if (moveX >= 50) {
          swipeHint.classList.add('active');
        } else {
          swipeHint.classList.remove('active');
        }
      }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
      if (isSwiping) {
        el.classList.remove('swiping');
        el.style.transform = '';
        swipeHint.style.opacity = '';
        swipeHint.style.transform = '';
        swipeHint.classList.remove('active');
        const finalDx = e.changedTouches[0].clientX - touchStartX;
        if (finalDx >= 50) {
          setReplyTo(msg);
          if (navigator.vibrate) try { navigator.vibrate(20); } catch {}
        }
        isSwiping = false;
      } else {
        // Double-tap on mobile touch across the whole row
        const now = Date.now();
        if (now - lastTapTime < 380) {
          e.preventDefault();
          openMessageInfoModal(msg);
          lastTapTime = 0;
        } else {
          lastTapTime = now;
        }
      }
    });

    el.addEventListener('touchcancel', () => {
      if (isSwiping) {
        el.classList.remove('swiping');
        el.style.transform = '';
        swipeHint.style.opacity = '';
        swipeHint.style.transform = '';
        swipeHint.classList.remove('active');
        isSwiping = false;
      }
    });

    // Double-click on desktop across the whole message row (bubble or free space)
    el.addEventListener('dblclick', (e) => {
      if (e.target.tagName === 'A' || e.target.tagName === 'IMG' || e.target.classList.contains('mention-tag')) return;
      if (e.target.closest('.msg-hover-reply-btn')) return;
      // Clear any text selection caused by double-click
      window.getSelection()?.removeAllRanges();
      openMessageInfoModal(msg);
    });

    el.setAttribute('data-msg-seq', msg.seq);
    messagesContainer.appendChild(el);
  }

  function addSystemMessage(text) {
    const el = document.createElement('div');
    el.className = 'system-message';
    el.innerHTML = `<span>${escapeHtml(text)}</span>`;
    messagesContainer.appendChild(el);
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    });
  }

  function isNearBottom() {
    const threshold = 150;
    return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < threshold;
  }

  function scrollToMessage(seq) {
    const el = messagesContainer.querySelector(`[data-msg-seq="${seq}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Highlight briefly
      const bubble = el.querySelector('.msg-bubble') || el;
      bubble.style.transition = 'box-shadow 0.3s';
      bubble.style.boxShadow = '0 0 0 2px var(--primary), 0 0 16px rgba(108,92,231,0.3)';
      setTimeout(() => { bubble.style.boxShadow = ''; }, 2000);
    }
  }

  // ─── Reply Handling ──────────────────────────────────────────────────────

  function setReplyTo(msg) {
    state.replyTo = msg;
    replyBarTag.textContent = msg.sender_tag;
    replyBarText.textContent = msg.body ? msg.body.slice(0, 100) : '[image]';
    replyBar.hidden = false;
    messageInput.focus();
  }

  function clearReply() {
    state.replyTo = null;
    replyBar.hidden = true;
  }

  replyCancel.addEventListener('click', clearReply);

  // ─── Image Upload, Paste & Drag-and-Drop ────────────────────────────────

  function stageImageFile(file) {
    if (!file || !file.type.startsWith('image/')) return;

    if (file.size > 10 * 1024 * 1024) {
      alert('Image too large. Maximum size is 10 MB.');
      imageFileInput.value = '';
      return;
    }

    state.pendingImageFile = file;

    // Show preview
    const reader = new FileReader();
    reader.onload = () => {
      imagePreviewThumb.src = reader.result;
      imagePreviewName.textContent = file.name || 'Pasted Image';
      imagePreviewSize.textContent = formatBytes(file.size);
      imagePreviewBar.hidden = false;
    };
    reader.readAsDataURL(file);
  }

  imageUploadBtn.addEventListener('click', () => imageFileInput.click());

  imageFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) stageImageFile(file);
  });

  imagePreviewCancel.addEventListener('click', () => {
    state.pendingImageFile = null;
    state.pendingImageId = null;
    imagePreviewBar.hidden = true;
    imageFileInput.value = '';
  });

  // Clipboard Paste support (Ctrl+V / Cmd+V)
  window.addEventListener('paste', (e) => {
    if (loginView && !loginView.hidden) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          stageImageFile(file);
          e.preventDefault();
          break;
        }
      }
    }
  });

  // Drag and Drop support
  const messagesAreaEl = $('messages-area');
  if (messagesAreaEl) {
    ['dragenter', 'dragover'].forEach(name => {
      messagesAreaEl.addEventListener(name, (e) => {
        e.preventDefault();
        messagesAreaEl.classList.add('drag-over');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      messagesAreaEl.addEventListener(name, (e) => {
        e.preventDefault();
        messagesAreaEl.classList.remove('drag-over');
      });
    });
    messagesAreaEl.addEventListener('drop', (e) => {
      const files = e.dataTransfer?.files;
      if (files && files.length > 0 && files[0].type.startsWith('image/')) {
        stageImageFile(files[0]);
      }
    });
  }

  async function uploadImage(file) {
    const res = await fetch('/api/image', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + state.token },
      body: file,
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Upload failed');
    }
    const data = await res.json();
    return data.image_id;
  }

  // ─── Send Message ────────────────────────────────────────────────────────

  let isSending = false;

  async function sendMessage() {
    if (isSending) return;

    const body = messageInput.value.trim();
    const hasImage = !!state.pendingImageFile;

    if (!body && !hasImage) return;
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    isSending = true;
    sendBtn.classList.add('sending');

    try {
      let imageId = null;

      // Upload image first if present
      if (state.pendingImageFile) {
        imageId = await uploadImage(state.pendingImageFile);
        state.pendingImageFile = null;
        state.pendingImageId = null;
        imagePreviewBar.hidden = true;
        imageFileInput.value = '';
      }

      const isImportant = Boolean(state.isImportantActive);

      const payload = {
        type: 'SEND_MESSAGE',
        body: body || '',
        image_id: imageId,
        reply_to_seq: state.replyTo ? state.replyTo.seq : null,
        is_important: isImportant,
      };

      state.ws.send(JSON.stringify(payload));
      messageInput.value = '';
      messageInput.style.height = 'auto';
      clearReply();

      // Reset important toggle
      state.isImportantActive = false;
      if (importantToggleBtn) importantToggleBtn.classList.remove('active');
    } catch (err) {
      alert('Failed to send: ' + err.message);
    } finally {
      isSending = false;
      sendBtn.classList.remove('sending');
      // Crucial for mobile / Android: preserve soft keyboard focus after sending
      try {
        messageInput.focus({ preventScroll: true });
      } catch {
        messageInput.focus();
      }
      scrollToBottom();
    }
  }

  // Prevent send button from stealing focus away from textarea on mobile touch & desktop click
  ['pointerdown', 'mousedown'].forEach((evtName) => {
    sendBtn.addEventListener(evtName, (e) => {
      e.preventDefault();
    });
  });

  sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sendMessage();
  });

  if (importantToggleBtn) {
    importantToggleBtn.addEventListener('click', () => {
      state.isImportantActive = !state.isImportantActive;
      importantToggleBtn.classList.toggle('active', state.isImportantActive);
    });
  }

  // ─── Mention Autocomplete Popup ───────────────────────────────────────────
  let mentionStartIndex = -1;
  let mentionMatches = [];
  let mentionSelectedIndex = 0;

  function updateMentionAutocomplete() {
    const val = messageInput.value;
    const selStart = messageInput.selectionStart;
    const textBeforeCursor = val.slice(0, selStart);

    // Look backward for '@' token
    const match = textBeforeCursor.match(/@([a-zA-Z0-9_]*)$/);
    if (!match) {
      closeMentionAutocomplete();
      return;
    }

    const query = match[1].toLowerCase();
    mentionStartIndex = match.index; // start of '@'

    const allUsers = getAllKnownUsers();
    const selfName = state.self?.tag?.replace(/^@/, '').toLowerCase();

    mentionMatches = allUsers.filter((u) => {
      if (selfName && u.name === selfName) return false;
      if (!query) return true;
      return u.name.includes(query) || (u.displayName && u.displayName.toLowerCase().includes(query));
    });

    if (mentionMatches.length === 0) {
      mentionAutocomplete.innerHTML = '<div class="mention-empty">No matching users or AI</div>';
      mentionAutocomplete.hidden = false;
      return;
    }

    mentionSelectedIndex = Math.min(mentionSelectedIndex, mentionMatches.length - 1);
    if (mentionSelectedIndex < 0) mentionSelectedIndex = 0;
    renderMentionList();
    mentionAutocomplete.hidden = false;
  }

  function renderMentionList() {
    mentionAutocomplete.innerHTML = '';
    mentionMatches.forEach((u, idx) => {
      const item = document.createElement('div');
      item.className = `mention-item ${idx === mentionSelectedIndex ? 'selected' : ''}`;
      item.innerHTML = `
        <div class="mention-avatar role-${u.role}">${(u.name[0] || '?').toUpperCase()}</div>
        <div class="mention-info">
          <div class="mention-name-row">
            <span class="mention-name">@${escapeHtml(u.name)}</span>
            ${roleBadge(u.role)}
          </div>
        </div>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        selectMention(u);
      });
      mentionAutocomplete.appendChild(item);
    });
  }

  function selectMention(u) {
    if (!u) return;
    const val = messageInput.value;
    const selStart = messageInput.selectionStart;
    const beforeAt = val.slice(0, mentionStartIndex);
    const afterCursor = val.slice(selStart);
    const inserted = `@${u.name} `;
    messageInput.value = beforeAt + inserted + afterCursor;
    const newPos = beforeAt.length + inserted.length;
    messageInput.setSelectionRange(newPos, newPos);
    messageInput.focus();
    autoResizeTextarea();
    closeMentionAutocomplete();
  }

  function closeMentionAutocomplete() {
    mentionAutocomplete.hidden = true;
    mentionMatches = [];
    mentionStartIndex = -1;
    mentionSelectedIndex = 0;
  }

  // ─── Emoji Picker Panel ───────────────────────────────────────────────────
  const EMOJI_CATEGORIES = [
    {
      id: 'smileys',
      icon: '😀',
      emojis: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵','🥶','🥴','😵','🤯','🤠','🥳','😎','🤓','🧐']
    },
    {
      id: 'gestures',
      icon: '👍',
      emojis: ['👍','👎','👌','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','✋','🤚','🖐️','🖖','👋','🤝','👏','🙌','👐','🤲','🙏','💪','🦾','👂','👀','🧠']
    },
    {
      id: 'hearts',
      icon: '❤️',
      emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','🔥','✨','🎉','🚀','⭐','🌟','💯','⚡','💥']
    },
    {
      id: 'objects',
      icon: '💡',
      emojis: ['🤖','👾','💻','📱','⌨️','💡','🔍','📦','☕','🍕','🍔','🐶','🐱','🦊','🐼','🦁','🐯','🐵','🚀','🌈','☀️','🌙']
    }
  ];

  let currentEmojiCategory = 'smileys';

  function initEmojiPicker() {
    if (!emojiPickerPanel) return;
    emojiPickerPanel.innerHTML = '';

    const catBar = document.createElement('div');
    catBar.className = 'emoji-categories';

    EMOJI_CATEGORIES.forEach((cat) => {
      const btn = document.createElement('button');
      btn.className = `emoji-cat-btn ${cat.id === currentEmojiCategory ? 'active' : ''}`;
      btn.textContent = cat.icon;
      btn.title = cat.id;
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentEmojiCategory = cat.id;
        initEmojiPicker();
      });
      catBar.appendChild(btn);
    });

    const grid = document.createElement('div');
    grid.className = 'emoji-grid';

    const activeCat = EMOJI_CATEGORIES.find((c) => c.id === currentEmojiCategory) || EMOJI_CATEGORIES[0];
    activeCat.emojis.forEach((em) => {
      const emBtn = document.createElement('button');
      emBtn.className = 'emoji-item';
      emBtn.textContent = em;
      emBtn.type = 'button';
      emBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertEmoji(em);
      });
      grid.appendChild(emBtn);
    });

    emojiPickerPanel.appendChild(catBar);
    emojiPickerPanel.appendChild(grid);
  }

  function insertEmoji(em) {
    const val = messageInput.value;
    const start = messageInput.selectionStart || val.length;
    const end = messageInput.selectionEnd || val.length;
    messageInput.value = val.substring(0, start) + em + val.substring(end);
    const newPos = start + em.length;
    messageInput.setSelectionRange(newPos, newPos);
    messageInput.focus();
    autoResizeTextarea();
  }

  if (emojiPickerBtn) {
    emojiPickerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willShow = emojiPickerPanel.hidden;
      closeMentionAutocomplete();
      if (willShow) {
        initEmojiPicker();
        emojiPickerPanel.hidden = false;
      } else {
        emojiPickerPanel.hidden = true;
      }
    });
  }

  // ─── Message Info Modal (Double Tap & Detailed Inspection) ────────────────
  function openMessageInfoModal(msg) {
    if (!msg) return;
    currentInfoMsg = msg;

    msgInfoSeqPill.textContent = `#${msg.seq}`;
    msgInfoAvatar.textContent = (msg.sender_tag?.replace(/^@/, '')[0] || '?').toUpperCase();
    msgInfoAvatar.className = `user-avatar role-${msg.sender_role || 'user'}`;
    msgInfoSender.textContent = msg.sender_tag || '@unknown';
    msgInfoSender.className = `msg-info-sender-name role-${msg.sender_role || 'user'}`;

    msgInfoRoleBadge.innerHTML = roleBadge(msg.sender_role);

    msgInfoImportantBadge.hidden = !msg.is_important;
    updateInfoStarBtnState(msg.is_important);

    const fullDate = new Date(msg.ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium'
    });
    const relativeTime = getRelativeTimeString(msg.ts);
    msgInfoFullTime.textContent = `${fullDate} (${relativeTime}) • Epoch: ${msg.epoch || state.epoch}`;

    if (msg.reply_to_seq) {
      msgInfoReplyBox.hidden = false;
      msgInfoReplyTarget.textContent = `${msg.reply_sender_tag || ('#' + msg.reply_to_seq)}: ${msg.reply_body_preview || ''}`;
    } else {
      msgInfoReplyBox.hidden = true;
    }

    msgInfoTextPreview.textContent = msg.body || (msg.image_id ? '[Image Attachment]' : '');

    if (msg.image_id) {
      msgInfoImage.src = `/api/image/${msg.image_id}`;
      msgInfoImageContainer.hidden = false;
      msgInfoImage.onclick = () => openLightbox(msgInfoImage.src);
    } else {
      msgInfoImageContainer.hidden = true;
      msgInfoImage.src = '';
    }

    const isSelf = Boolean(
      state.self?.tag &&
      msg.sender_tag &&
      msg.sender_tag.toLowerCase() === state.self.tag.toLowerCase()
    );
    const isAdmin = state.self?.role === 'admin';
    msgInfoDeleteBtn.hidden = !(isSelf || isAdmin);

    msgInfoModalOverlay.hidden = false;
  }

  function closeMessageInfoModal() {
    msgInfoModalOverlay.hidden = true;
    currentInfoMsg = null;
  }

  function updateInfoStarBtnState(isImportant) {
    if (!msgInfoStarBtn) return;
    if (isImportant) {
      msgInfoStarBtn.classList.add('btn-primary');
      msgInfoStarBtn.classList.remove('btn-secondary');
      msgInfoStarBtn.innerHTML = '<span>⭐ Starred (Important)</span>';
    } else {
      msgInfoStarBtn.classList.remove('btn-primary');
      msgInfoStarBtn.classList.add('btn-secondary');
      msgInfoStarBtn.innerHTML = '<span>⭐ Mark as Important</span>';
    }
  }

  if (msgInfoClose) msgInfoClose.addEventListener('click', closeMessageInfoModal);
  if (msgInfoModalOverlay) {
    msgInfoModalOverlay.addEventListener('click', (e) => {
      if (e.target === msgInfoModalOverlay) closeMessageInfoModal();
    });
  }

  if (msgInfoReplyBtn) {
    msgInfoReplyBtn.addEventListener('click', () => {
      if (currentInfoMsg) setReplyTo(currentInfoMsg);
      closeMessageInfoModal();
    });
  }

  if (msgInfoCopyBtn) {
    msgInfoCopyBtn.addEventListener('click', async () => {
      if (!currentInfoMsg) return;
      const textToCopy = currentInfoMsg.body || '';
      try {
        await navigator.clipboard.writeText(textToCopy);
        msgInfoCopyBtn.innerHTML = '<span>✓ Copied!</span>';
        setTimeout(() => {
          msgInfoCopyBtn.innerHTML = '<span>📋 Copy Text</span>';
        }, 1500);
      } catch {
        alert('Could not copy to clipboard');
      }
    });
  }

  if (msgInfoStarBtn) {
    msgInfoStarBtn.addEventListener('click', () => {
      if (!currentInfoMsg) return;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({
          type: 'TOGGLE_MESSAGE_IMPORTANT',
          seq: currentInfoMsg.seq,
        }));
      }
    });
  }

  if (msgInfoDeleteBtn) {
    msgInfoDeleteBtn.addEventListener('click', async () => {
      if (!currentInfoMsg) return;
      const confirmed = await showConfirm('Delete Message', `Delete message #${currentInfoMsg.seq}?`);
      if (confirmed) {
        try {
          await apiFetch(`/api/admin/messages/${currentInfoMsg.seq}`, { method: 'DELETE' });
          closeMessageInfoModal();
        } catch (err) {
          alert('Failed to delete: ' + err.message);
        }
      }
    });
  }

  messageInput.addEventListener('keydown', (e) => {
    if (!mentionAutocomplete.hidden && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex + 1) % mentionMatches.length;
        renderMentionList();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionSelectedIndex = (mentionSelectedIndex - 1 + mentionMatches.length) % mentionMatches.length;
        renderMentionList();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        selectMention(mentionMatches[mentionSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionAutocomplete();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      closeMentionAutocomplete();
      sendMessage();
      messageInput.focus({ preventScroll: true });
    }
  });

  // Auto-resize textarea & mention check
  messageInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateMentionAutocomplete();
  });

  // Dynamic visual viewport handling for Android / Mobile keyboard
  if (window.visualViewport) {
    const handleViewportChange = () => {
      const vh = window.visualViewport.height;
      document.documentElement.style.setProperty('--visual-vh', `${vh}px`);
      if (document.activeElement === messageInput || isNearBottom()) {
        scrollToBottom();
      }
    };
    window.visualViewport.addEventListener('resize', handleViewportChange);
    window.visualViewport.addEventListener('scroll', handleViewportChange);
    handleViewportChange();
  }

  // Smoothly scroll down when message input is focused (e.g. keyboard pops up on mobile)
  messageInput.addEventListener('focus', () => {
    setTimeout(scrollToBottom, 60);
    setTimeout(scrollToBottom, 200);
    setTimeout(scrollToBottom, 450);
  });

  // Global dismiss for click outside
  document.addEventListener('click', (e) => {
    if (!mentionAutocomplete.hidden && !mentionAutocomplete.contains(e.target) && e.target !== messageInput) {
      closeMentionAutocomplete();
    }
    if (!emojiPickerPanel.hidden && !emojiPickerPanel.contains(e.target) && e.target !== emojiPickerBtn && (!emojiPickerBtn || !emojiPickerBtn.contains(e.target))) {
      emojiPickerPanel.hidden = true;
    }
  });

  // ─── Lightbox ────────────────────────────────────────────────────────────

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.hidden = false;
  }

  lightboxClose.addEventListener('click', () => { lightbox.hidden = true; });
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) lightbox.hidden = true;
  });

  // ─── Sidebar Toggle (Mobile) ────────────────────────────────────────────

  sidebarToggle.addEventListener('click', () => {
    state.sidebarOpen = !state.sidebarOpen;
    sidebar.classList.toggle('open', state.sidebarOpen);
    if (sidebarBackdrop) {
      sidebarBackdrop.classList.toggle('active', state.sidebarOpen);
      sidebarBackdrop.hidden = !state.sidebarOpen;
    }
  });

  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', () => {
      state.sidebarOpen = false;
      sidebar.classList.remove('open');
      sidebarBackdrop.classList.remove('active');
      sidebarBackdrop.hidden = true;
    });
  }

  // ─── Admin Panel ─────────────────────────────────────────────────────────

  adminPanelBtn.addEventListener('click', () => {
    adminOverlay.hidden = false;
    loadAdminDashboard();
    loadAdminMessages();
  });

  adminClose.addEventListener('click', () => {
    adminOverlay.hidden = true;
  });

  adminOverlay.addEventListener('click', (e) => {
    if (e.target === adminOverlay) adminOverlay.hidden = true;
  });

  // Admin Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.dataset.tab;
      document.getElementById(targetId)?.classList.add('active');

      if (targetId === 'users-tab') loadAdminDashboard();
      if (targetId === 'messages-tab') loadAdminMessages();
      if (targetId === 'media-tab') loadAdminMedia();
      if (targetId === 'system-tab') loadAdminSystem();
    });
  });

  // ─── Admin: Dashboard Stats ──────────────────────────────────────────────

  async function loadAdminDashboard() {
    try {
      const data = await apiFetch('/api/admin/dashboard');
      $('stat-total-users').textContent = data.totalUsers;
      $('stat-online-users').textContent = data.onlineUsers.length;
      $('stat-total-messages').textContent = data.totalMessages;
      $('stat-total-media').textContent = data.totalMedia;
      $('stat-total-replies').textContent = data.totalReplies;
      $('stat-epoch').textContent = data.epoch;

      // Populate users table
      const tbody = $('admin-users-tbody');
      tbody.innerHTML = '';
      const allUsers = await apiFetch('/api/admin/users');
      allUsers.users.forEach((u) => {
        const tr = document.createElement('tr');
        const modeBadge = u.role === 'ai'
          ? `<button class="btn-sm admin-toggle-tag-btn" data-username="${escapeHtml(u.username)}" data-tagonly="${u.tag_only ? '1' : '0'}" title="Click to toggle Tag-Only mode" style="cursor:pointer;background:${u.tag_only ? 'rgba(239,68,68,0.15)' : 'rgba(59,130,246,0.15)'};color:${u.tag_only ? '#f87171' : '#60a5fa'};border:1px solid ${u.tag_only ? 'rgba(239,68,68,0.3)' : 'rgba(59,130,246,0.3)'};font-size:10px;padding:3px 8px;border-radius:4px;font-weight:600;">
              ${u.tag_only ? '🔒 Tag-Only' : '🌐 Full Room'}
            </button>`
          : `<span style="color:var(--text-muted);font-size:11px;">—</span>`;

        tr.innerHTML = `
          <td><strong>${escapeHtml(u.username)}</strong></td>
          <td>${roleBadge(u.role)}</td>
          <td>${modeBadge}</td>
          <td><span class="online-dot ${u.online ? 'on' : 'off'}"></span>${u.online ? 'Online' : 'Offline'}</td>
          <td>${new Date(u.created_at).toLocaleDateString()}</td>
          <td>${u.role !== 'admin' ? `<button class="btn-sm admin-delete-user-btn" data-username="${escapeHtml(u.username)}">Delete</button>` : '<span style="color:var(--text-muted)">—</span>'}</td>
        `;
        tbody.appendChild(tr);
      });

      // Attach tag-only toggle handlers
      tbody.querySelectorAll('.admin-toggle-tag-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const username = btn.dataset.username;
          const currentTagOnly = btn.dataset.tagonly === '1';
          const newTagOnly = !currentTagOnly;
          try {
            await apiFetch('/api/admin/users', {
              method: 'POST',
              body: JSON.stringify({
                action: 'toggle_tag_only',
                username,
                tag_only: newTagOnly,
              }),
            });
            loadAdminDashboard();
          } catch (err) {
            alert('Failed to update Tag-Only: ' + err.message);
          }
        });
      });

      // Attach delete handlers
      tbody.querySelectorAll('.admin-delete-user-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const username = btn.dataset.username;
          const confirmed = await showConfirm('Delete User', `Are you sure you want to delete user "${username}"? Their active connections will be terminated.`);
          if (!confirmed) return;
          try {
            await apiFetch(`/api/admin/users?username=${encodeURIComponent(username)}`, { method: 'DELETE' });
            loadAdminDashboard(); // Refresh
          } catch (err) { alert('Error: ' + err.message); }
        });
      });
    } catch (err) {
      console.error('Admin dashboard error:', err);
    }
  }

  // ─── Admin: AI Account Form ──────────────────────────────────────────────

  $('ai-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const result = $('ai-form-result');
    try {
      await apiFetch('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          action: 'upsert_ai',
          username: $('ai-username').value.trim(),
          password: $('ai-password').value,
          tag_only: $('ai-tag-only').checked,
        }),
      });
      result.textContent = '✓ AI account created/updated successfully.';
      result.className = 'result-text success';
      result.hidden = false;
      loadAdminDashboard(); // Refresh users
    } catch (err) {
      result.textContent = '✗ ' + err.message;
      result.className = 'result-text error';
      result.hidden = false;
    }
  });

  $('ai-gen-key').addEventListener('click', () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let key = '';
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    for (const b of arr) key += chars[b % chars.length];
    $('ai-password').value = key;
  });

  // ─── Admin: Messages List (with filters, thumbnail preview & deletion) ──

  async function loadAdminMessages() {
    try {
      const search = $('admin-msg-search').value;
      const role = $('admin-msg-role-filter').value;
      const hasImage = $('admin-filter-has-image')?.checked ? '1' : '';
      const hasReply = $('admin-filter-has-reply')?.checked ? '1' : '';

      let query = `/api/admin/messages?page=${state.adminPage}&limit=50&search=${encodeURIComponent(search)}&role=${encodeURIComponent(role)}`;
      if (hasImage) query += '&hasImage=1';
      if (hasReply) query += '&hasReply=1';

      const data = await apiFetch(query);
      state.adminTotal = data.total;

      const list = $('admin-messages-list');
      list.innerHTML = '';

      data.messages.forEach((msg) => {
        const item = document.createElement('div');
        item.className = 'admin-msg-item';
        let mediaHtml = '';
        if (msg.image_id) {
          mediaHtml = `<img src="/api/image/${msg.image_id}" class="admin-msg-thumb" alt="Attached Media" title="Click to enlarge">`;
        }

        let replyHtml = '';
        if (msg.reply_to_seq) {
          replyHtml = `<div class="admin-msg-reply-info">↩ In reply to #${msg.reply_to_seq} (${escapeHtml(msg.reply_sender_tag || '?')}: ${escapeHtml(msg.reply_body_preview || '')})</div>`;
        }

        item.innerHTML = `
          <div class="admin-msg-left">
            <span class="admin-msg-seq">#${msg.seq}</span>
            <span class="admin-msg-tag role-${msg.sender_role}">${escapeHtml(msg.sender_tag)}</span>
            ${roleBadge(msg.sender_role)}
          </div>
          <div class="admin-msg-center">
            ${replyHtml}
            <div class="admin-msg-body">${escapeHtml(msg.body || (msg.image_id ? '[Image Attachment]' : '[empty]'))}</div>
            ${mediaHtml}
          </div>
          <div class="admin-msg-meta">
            <span class="admin-msg-time">${formatTime(msg.ts)}</span>
            <div class="admin-msg-actions">
              <button class="btn-sm btn-icon admin-jump-msg-btn" data-seq="${msg.seq}" title="View in Chat">↗</button>
              <button class="btn-sm btn-danger-sm admin-del-msg-btn" data-seq="${msg.seq}" title="Delete Message">🗑️</button>
            </div>
          </div>
        `;

        if (msg.image_id) {
          item.querySelector('.admin-msg-thumb')?.addEventListener('click', () => openLightbox(`/api/image/${msg.image_id}`));
        }

        item.querySelector('.admin-jump-msg-btn')?.addEventListener('click', () => {
          adminOverlay.hidden = true;
          scrollToMessage(msg.seq);
        });

        item.querySelector('.admin-del-msg-btn')?.addEventListener('click', async () => {
          const ok = await showConfirm('Delete Message', `Delete message #${msg.seq} by ${msg.sender_tag}? This cannot be undone.`);
          if (!ok) return;
          try {
            await apiFetch(`/api/admin/messages/${msg.seq}`, { method: 'DELETE' });
            loadAdminMessages();
          } catch (err) { alert('Error: ' + err.message); }
        });

        list.appendChild(item);
      });

      if (data.messages.length === 0) {
        list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No messages found.</div>';
      }

      // Pagination
      const totalPages = Math.max(1, Math.ceil(data.total / 50));
      $('admin-msg-page-info').textContent = `Page ${state.adminPage} of ${totalPages} (${data.total} total)`;
      $('admin-msg-prev').disabled = state.adminPage <= 1;
      $('admin-msg-next').disabled = state.adminPage >= totalPages;
    } catch (err) {
      console.error('Admin messages error:', err);
    }
  }

  $('admin-msg-refresh').addEventListener('click', () => { state.adminPage = 1; loadAdminMessages(); });
  $('admin-msg-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') { state.adminPage = 1; loadAdminMessages(); } });
  $('admin-msg-role-filter').addEventListener('change', () => { state.adminPage = 1; loadAdminMessages(); });
  $('admin-filter-has-image')?.addEventListener('change', () => { state.adminPage = 1; loadAdminMessages(); });
  $('admin-filter-has-reply')?.addEventListener('change', () => { state.adminPage = 1; loadAdminMessages(); });
  $('admin-msg-prev').addEventListener('click', () => { if (state.adminPage > 1) { state.adminPage--; loadAdminMessages(); } });
  $('admin-msg-next').addEventListener('click', () => { state.adminPage++; loadAdminMessages(); });

  // ─── Admin: Media Gallery ────────────────────────────────────────────────

  async function loadAdminMedia() {
    const grid = $('admin-media-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">Loading media files...</div>';

    try {
      const data = await apiFetch('/api/admin/media');
      grid.innerHTML = '';

      if (!data.media || data.media.length === 0) {
        grid.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);grid-column:1/-1;">No media uploaded yet.</div>';
        return;
      }

      data.media.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'admin-media-card';
        card.innerHTML = `
          <div class="media-card-img-wrap">
            <img src="/api/image/${item.image_id}" alt="Media" loading="lazy" class="media-card-img">
          </div>
          <div class="media-card-details">
            <div class="media-card-header">
              <span class="media-card-mime">${escapeHtml(item.mime_type)}</span>
              <span class="media-card-size">${formatBytes(item.total_size)}</span>
            </div>
            <div class="media-card-id" title="${item.image_id}">${item.image_id.slice(0, 14)}...</div>
            <div class="media-card-footer">
              <span class="media-card-sender">${escapeHtml(item.sender_tag || '—')}</span>
              ${item.msg_seq ? `<button class="btn-sm media-jump-btn" data-seq="${item.msg_seq}" title="Go to message">#${item.msg_seq}</button>` : ''}
              <button class="btn-sm btn-danger-sm media-del-btn" data-id="${item.image_id}" title="Delete media">🗑️</button>
            </div>
          </div>
        `;

        card.querySelector('.media-card-img')?.addEventListener('click', () => openLightbox(`/api/image/${item.image_id}`));

        card.querySelector('.media-jump-btn')?.addEventListener('click', () => {
          adminOverlay.hidden = true;
          scrollToMessage(item.msg_seq);
        });

        card.querySelector('.media-del-btn')?.addEventListener('click', async () => {
          const ok = await showConfirm('Delete Media', 'Permanently delete this media file from SQLite?');
          if (!ok) return;
          try {
            await apiFetch(`/api/admin/media/${item.image_id}`, { method: 'DELETE' });
            loadAdminMedia();
          } catch (err) { alert('Error: ' + err.message); }
        });

        grid.appendChild(card);
      });
    } catch (err) {
      grid.innerHTML = `<div style="color:var(--error);padding:16px;">Error loading media: ${escapeHtml(err.message)}</div>`;
    }
  }

  $('admin-media-refresh')?.addEventListener('click', loadAdminMedia);

  // ─── Admin: System Health & Moderation ───────────────────────────────────

  async function loadAdminSystem() {
    const summary = $('system-stats-summary');
    const tbody = $('admin-blocked-tbody');
    if (!summary || !tbody) return;

    summary.innerHTML = '<div style="color:var(--text-muted)">Loading diagnostics...</div>';
    tbody.innerHTML = '';

    try {
      const data = await apiFetch('/api/admin/moderation');

      summary.innerHTML = `
        <div class="diag-card">
          <div class="diag-val">${formatBytes(data.totalMediaBytes)}</div>
          <div class="diag-label">SQLite Media Storage</div>
        </div>
        <div class="diag-card">
          <div class="diag-val">${data.activeSockets}</div>
          <div class="diag-label">Active WebSockets</div>
        </div>
        <div class="diag-card">
          <div class="diag-val">${data.onlineUsers.length}</div>
          <div class="diag-label">Online Registered</div>
        </div>
        <div class="diag-card">
          <div class="diag-val">Epoch ${data.epoch}</div>
          <div class="diag-label">Room Epoch</div>
        </div>
      `;

      if (!data.blockedUsers || data.blockedUsers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:16px;color:var(--text-muted)">No users currently blocked or on rate-limit cooldown.</td></tr>';
      } else {
        data.blockedUsers.forEach((b) => {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td><strong>@${escapeHtml(b.username)}</strong></td>
            <td><span class="cooldown-tag">${b.remainingSeconds}s remaining</span></td>
            <td><button class="btn-sm btn-primary-sm admin-unblock-btn" data-username="${escapeHtml(b.username)}">Unblock Now</button></td>
          `;

          tr.querySelector('.admin-unblock-btn')?.addEventListener('click', async () => {
            try {
              await apiFetch('/api/admin/unblock', {
                method: 'POST',
                body: JSON.stringify({ username: b.username }),
              });
              loadAdminSystem();
            } catch (err) { alert('Error: ' + err.message); }
          });

          tbody.appendChild(tr);
        });
      }
    } catch (err) {
      summary.innerHTML = `<div style="color:var(--error)">Error loading system health: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ─── Admin: Clear Chat ───────────────────────────────────────────────────

  $('admin-clear-chat-btn').addEventListener('click', async () => {
    const confirmed = await showConfirm(
      '⚠️ Clear All Chat',
      'This will permanently delete ALL messages and ALL uploaded media. The chat epoch will increment. Active connections will NOT be disconnected. This cannot be undone!'
    );
    if (!confirmed) return;

    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'ADMIN_CLEAR_CHAT' }));
      adminOverlay.hidden = true;
    }
  });

  // ─── Keep-Alive Ping ────────────────────────────────────────────────────

  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'PING' }));
    }
  }, 25000);

  // ─── Boot ────────────────────────────────────────────────────────────────

  if (state.token) {
    // We have a stored token, try to go straight to chat
    // The self info will be populated from INIT_STATE
    state.self = { username: '...', tag: '@...', role: 'user' }; // Placeholder until INIT_STATE
    showChat();
  }

})();
