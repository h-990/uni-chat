// ============================================================================
// UNI-CHAT SERVER — Cloudflare Worker + Durable Object (SQLite)
// Singleton Group Chat Room with reply chains, image support, and admin APIs
// ============================================================================

// ─── Crypto Utilities ────────────────────────────────────────────────────────

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(username, password) {
  const data = new TextEncoder().encode(username + ':' + password);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return toHex(hash);
}

function base64urlEncode(data) {
  const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function getHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signToken(payload, secret) {
  const header = base64urlEncode(JSON.stringify(payload));
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(header));
  const sigStr = base64urlEncode(String.fromCharCode(...new Uint8Array(sig)));
  return header + '.' + sigStr;
}

async function verifyToken(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [header, sig] = parts;
  const key = await getHmacKey(secret);
  const sigBytes = Uint8Array.from(base64urlDecode(sig), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(header));
  if (!valid) return null;
  try {
    const payload = JSON.parse(base64urlDecode(header));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Image Magic Byte Validator ──────────────────────────────────────────────

function detectImageMime(bytes) {
  if (bytes.length < 12) return null;
  // PNG
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }
  // JPEG
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  // GIF
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return 'image/gif';
  }
  // WEBP
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

// ─── Response Helpers ────────────────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_IMAGE_SIZE = 10 * 1024 * 1024;       // 10 MiB
const CHUNK_SIZE = 1_800_000;                    // 1.8 MB per SQLite row
const RATE_LIMIT_WINDOW = 10_000;                // 10 seconds
const RATE_LIMIT_MAX_MSGS = 8;                   // max messages per window (human users)
const RATE_LIMIT_COOLDOWN = 60_000;              // 60 second cooldown on violation
const TOKEN_EXPIRY = 7 * 24 * 60 * 60 * 1000;   // 7 days
const INIT_MESSAGE_COUNT = 200;                  // Messages loaded on connect

// ============================================================================
// DURABLE OBJECT: SingletonChatRoom
// ============================================================================

export class SingletonChatRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.cooldownMap = new Map();
    this.aiSwitches = new Map();
    // Default switches for AI accounts (e.g. DeepSeek has DeepThink, Web Search, and Tag-Only)
    this.aiSwitches.set('deepseek', { deepthink: false, search: false, tag_only: false });
    this.initSchema();
    this.loadAiSwitchesFromDb();
  }

  loadAiSwitchesFromDb() {
    try {
      const aiUsers = [...this.sql.exec("SELECT username, tag_only FROM users WHERE role = 'ai'")];
      for (const u of aiUsers) {
        const cur = this.aiSwitches.get(u.username) || { deepthink: false, search: false };
        cur.tag_only = Boolean(u.tag_only);
        this.aiSwitches.set(u.username, cur);
      }
    } catch {}
  }

  // ─── Schema Initialization ───────────────────────────────────────────────

  initSchema() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        chat_epoch INTEGER NOT NULL DEFAULT 1
      );
    `);
    this.sql.exec(`INSERT OR IGNORE INTO room_meta (id, chat_epoch) VALUES (1, 1);`);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        tag_only INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    try {
      this.sql.exec('ALTER TABLE users ADD COLUMN tag_only INTEGER DEFAULT 0');
    } catch {}

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch INTEGER NOT NULL,
        sender_tag TEXT NOT NULL,
        sender_role TEXT NOT NULL,
        body TEXT NOT NULL,
        image_id TEXT,
        reply_to_seq INTEGER,
        is_important INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
    `);

    try {
      this.sql.exec('ALTER TABLE messages ADD COLUMN is_important INTEGER DEFAULT 0');
    } catch {}

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS media_chunks (
        image_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (image_id, chunk_index)
      );
    `);

    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS offline_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        target_username TEXT NOT NULL,
        sender_tag TEXT NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
    `);

    try {
      this.sql.exec('CREATE INDEX IF NOT EXISTS idx_offline_mentions_target ON offline_mentions(target_username, epoch, delivered);');
    } catch {}
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  getEpoch() {
    const row = [...this.sql.exec('SELECT chat_epoch FROM room_meta WHERE id = 1')][0];
    return row ? row.chat_epoch : 1;
  }

  async verifyAuthHeader(request) {
    const auth = request.headers.get('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return verifyToken(auth.slice(7), this.env.HMAC_SECRET);
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(data); } catch {}
    }
  }

  getOnlineUsers() {
    const users = [];
    const seen = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.username && !seen.has(att.username)) {
          seen.add(att.username);
          users.push({ username: att.username, role: att.role });
        }
      } catch {}
    }
    return users;
  }

  // ─── HTTP Router ─────────────────────────────────────────────────────────

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // Auth
      if (path === '/api/auth' && method === 'POST') return await this.handleAuth(request);

      // Admin routes
      if (path === '/api/admin/users' && method === 'POST') return await this.handleAdminUpsert(request);
      if (path === '/api/admin/users' && method === 'GET') return await this.handleAdminUserList(request);
      if (path === '/api/admin/users' && method === 'DELETE') return await this.handleAdminDeleteUser(request);
      if (path === '/api/admin/dashboard' && method === 'GET') return await this.handleAdminDashboard(request);
      if (path === '/api/admin/messages' && method === 'GET') return await this.handleAdminMessages(request);
      if (path.match(/^\/api\/admin\/messages\/\d+$/) && method === 'DELETE') {
        return await this.handleAdminDeleteMessage(request, path.split('/').pop());
      }
      if (path === '/api/admin/media' && method === 'GET') return await this.handleAdminMediaList(request);
      if (path.match(/^\/api\/admin\/media\/[a-f0-9-]+$/) && method === 'DELETE') {
        return await this.handleAdminDeleteMedia(request, path.split('/').pop());
      }
      if (path === '/api/admin/moderation' && method === 'GET') return await this.handleAdminModeration(request);
      if (path === '/api/admin/unblock' && method === 'POST') return await this.handleAdminUnblock(request);
      if (path === '/api/admin/clear-chat' && method === 'POST') return await this.handleAdminClearChatHttp(request);

      // Image
      if (path === '/api/image' && method === 'POST') return await this.handleImageUpload(request);
      if (path.match(/^\/api\/image\/[a-f0-9-]+$/) && method === 'GET') {
        return this.handleImageRetrieve(path.split('/').pop());
      }

      // Offline Mentions API (for AI catch-up when returning after offline tags)
      if (path === '/api/offline-mentions' && method === 'GET') {
        const username = (url.searchParams.get('username') || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!username) return errorResponse('Missing username', 400);
        const epoch = this.getEpoch();
        const mentions = [...this.sql.exec(
          `SELECT m.seq, m.epoch, m.sender_tag, m.sender_role, m.body, m.image_id, m.reply_to_seq, m.is_important, m.ts,
                  r.sender_tag AS reply_sender_tag,
                  COALESCE(NULLIF(SUBSTR(r.body, 1, 120), ''), CASE WHEN r.image_id IS NOT NULL THEN '[Image]' ELSE '' END) AS reply_body_preview,
                  r.sender_role AS reply_sender_role,
                  r.image_id AS reply_image_id
           FROM offline_mentions om
           JOIN messages m ON om.seq = m.seq AND om.epoch = m.epoch
           LEFT JOIN messages r ON m.reply_to_seq = r.seq
           WHERE om.target_username = ? AND om.epoch = ? AND om.delivered = 0
           ORDER BY m.seq ASC`,
          username, epoch
        )];
        return jsonResponse({ username, epoch, mentions });
      }

      if (path === '/api/offline-mentions/ack' && method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const username = (body.username || '').toLowerCase().replace(/[^a-z0-9_]/g, '');
        const seqs = Array.isArray(body.seqs) ? body.seqs : [];
        if (!username || seqs.length === 0) return jsonResponse({ success: true, count: 0 });
        const placeholders = seqs.map(() => '?').join(',');
        this.sql.exec(
          `UPDATE offline_mentions SET delivered = 1 WHERE target_username = ? AND seq IN (${placeholders})`,
          username, ...seqs
        );
        return jsonResponse({ success: true, count: seqs.length });
      }

      // WebSocket
      if (path === '/ws') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return errorResponse('Expected WebSocket upgrade', 426);
        }
        return await this.handleWebSocketUpgrade(request);
      }

      return errorResponse('Not Found', 404);
    } catch (err) {
      console.error('Request error:', err);
      return errorResponse('Internal Server Error: ' + err.message, 500);
    }
  }

  // ─── Authentication ──────────────────────────────────────────────────────

  async handleAuth(request) {
    const { username, password } = await request.json();
    if (!username || !password) return errorResponse('Missing username or password');

    const cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!cleanUsername || cleanUsername.length < 2 || cleanUsername.length > 24) {
      return errorResponse('Username must be 2-24 characters (a-z, 0-9, _)');
    }

    const hash = await hashPassword(cleanUsername, password);

    // Case 1: Admin login
    const adminUser = (this.env.ADMIN_USERNAME || 'Harsh').toLowerCase();
    if (cleanUsername === adminUser) {
      const expectedHash = this.env.ADMIN_PASSWORD_HASH;
      if (hash !== expectedHash) return errorResponse('Invalid admin credentials', 401);

      // Upsert admin into users table
      this.sql.exec(
        `INSERT INTO users (username, password_hash, role, created_at)
         VALUES (?, ?, 'admin', ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = ?, role = 'admin'`,
        cleanUsername, hash, Date.now(), hash
      );

      const token = await signToken(
        { u: cleanUsername, r: 'admin', exp: Date.now() + TOKEN_EXPIRY },
        this.env.HMAC_SECRET
      );
      return jsonResponse({ token, username: cleanUsername, role: 'admin' });
    }

    // Case 2: Existing user/AI
    const existing = [...this.sql.exec('SELECT * FROM users WHERE username = ?', cleanUsername)];
    if (existing.length > 0) {
      const user = existing[0];
      if (user.password_hash !== hash) return errorResponse('Invalid credentials', 401);

      const token = await signToken(
        { u: user.username, r: user.role, exp: Date.now() + TOKEN_EXPIRY },
        this.env.HMAC_SECRET
      );
      return jsonResponse({ token, username: user.username, role: user.role, tag_only: Boolean(user.tag_only) });
    }

    // Case 3: New human user (auto-register)
    const reserved = ['admin', 'system', 'bot', 'server', 'mod'];
    if (reserved.includes(cleanUsername)) {
      return errorResponse('Username is reserved', 403);
    }

    this.sql.exec(
      'INSERT INTO users (username, password_hash, role, tag_only, created_at) VALUES (?, ?, ?, 0, ?)',
      cleanUsername, hash, 'user', Date.now()
    );

    const token = await signToken(
      { u: cleanUsername, r: 'user', exp: Date.now() + TOKEN_EXPIRY },
      this.env.HMAC_SECRET
    );
    return jsonResponse({ token, username: cleanUsername, role: 'user', tag_only: false });
  }

  // ─── Admin: Upsert AI Account ────────────────────────────────────────────

  async handleAdminUpsert(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const body = await request.json();
    const { action, username, password, tag_only } = body || {};

    if (action === 'toggle_tag_only') {
      if (!username) return errorResponse('Missing username');
      const cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
      const tagOnlyVal = tag_only ? 1 : 0;
      this.sql.exec('UPDATE users SET tag_only = ? WHERE username = ?', tagOnlyVal, cleanUsername);
      const current = this.aiSwitches.get(cleanUsername) || { deepthink: false, search: false, tag_only: false };
      current.tag_only = Boolean(tagOnlyVal);
      this.aiSwitches.set(cleanUsername, current);

      this.broadcast({
        type: 'AI_SWITCH_CHANGED',
        ai_username: cleanUsername,
        switch_id: 'tag_only',
        enabled: Boolean(tagOnlyVal),
        changed_by: user.u,
      });
      return jsonResponse({ success: true, username: cleanUsername, tag_only: Boolean(tagOnlyVal) });
    }

    if (action === 'upsert_ai') {
      if (!username || !password) return errorResponse('Missing username or password');
      const cleanUsername = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!cleanUsername || cleanUsername.length < 2) return errorResponse('Invalid username');

      const hash = await hashPassword(cleanUsername, password);
      const tagOnlyVal = tag_only ? 1 : 0;
      this.sql.exec(
        `INSERT INTO users (username, password_hash, role, tag_only, created_at)
         VALUES (?, ?, 'ai', ?, ?)
         ON CONFLICT(username) DO UPDATE SET password_hash = ?, role = 'ai', tag_only = ?`,
        cleanUsername, hash, tagOnlyVal, Date.now(), hash, tagOnlyVal
      );

      const current = this.aiSwitches.get(cleanUsername) || { deepthink: false, search: false, tag_only: false };
      current.tag_only = Boolean(tagOnlyVal);
      this.aiSwitches.set(cleanUsername, current);

      this.broadcast({
        type: 'AI_SWITCH_CHANGED',
        ai_username: cleanUsername,
        switch_id: 'tag_only',
        enabled: Boolean(tagOnlyVal),
        changed_by: user.u,
      });

      return jsonResponse({ success: true, username: cleanUsername, role: 'ai', tag_only: Boolean(tagOnlyVal) });
    }

    return errorResponse('Invalid action');
  }

  // ─── Admin: Delete User ──────────────────────────────────────────────────

  async handleAdminDeleteUser(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const url = new URL(request.url);
    const target = url.searchParams.get('username');
    if (!target) return errorResponse('Missing username parameter');
    const adminUser = (this.env.ADMIN_USERNAME || 'Harsh').toLowerCase();
    if (target.toLowerCase() === adminUser) return errorResponse('Cannot delete admin', 403);

    this.sql.exec('DELETE FROM users WHERE username = ?', target);

    // Close their WebSocket connections
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const att = ws.deserializeAttachment();
        if (att && att.username === target) {
          ws.close(1008, 'Account deleted by admin');
        }
      } catch {}
    }

    return jsonResponse({ success: true, deleted: target });
  }

  // ─── Admin: List Users ───────────────────────────────────────────────────

  async handleAdminUserList(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const rows = [...this.sql.exec('SELECT username, role, tag_only, created_at FROM users ORDER BY created_at ASC')];
    const onlineSet = new Set(this.getOnlineUsers().map(u => u.username));

    const users = rows.map(r => ({
      username: r.username,
      role: r.role,
      tag_only: Boolean(r.tag_only),
      created_at: r.created_at,
      online: onlineSet.has(r.username),
    }));

    return jsonResponse({ users });
  }

  // ─── Admin: Dashboard ────────────────────────────────────────────────────

  async handleAdminDashboard(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const epoch = this.getEpoch();
    const totalUsers = [...this.sql.exec('SELECT COUNT(*) as c FROM users')][0].c;
    const totalMessages = [...this.sql.exec('SELECT COUNT(*) as c FROM messages')][0].c;
    const totalMedia = [...this.sql.exec('SELECT COUNT(DISTINCT image_id) as c FROM media_chunks')][0].c;
    const totalReplies = [...this.sql.exec('SELECT COUNT(*) as c FROM messages WHERE reply_to_seq IS NOT NULL')][0].c;
    const onlineUsers = this.getOnlineUsers();
    const connectedSockets = this.ctx.getWebSockets().length;

    // Message breakdown by role
    const roleCounts = [...this.sql.exec(
      `SELECT sender_role, COUNT(*) as c FROM messages GROUP BY sender_role`
    )];

    // Recent activity (last 10 messages)
    const recentMessages = [...this.sql.exec(
      `SELECT m.seq, m.sender_tag, m.sender_role, m.body, m.image_id, m.reply_to_seq, m.ts,
              r.sender_tag AS reply_sender_tag, SUBSTR(r.body, 1, 100) AS reply_body_preview
       FROM messages m
       LEFT JOIN messages r ON m.reply_to_seq = r.seq
       ORDER BY m.seq DESC LIMIT 10`
    )];

    return jsonResponse({
      epoch,
      totalUsers,
      totalMessages,
      totalMedia,
      totalReplies,
      connectedSockets,
      onlineUsers,
      messagesByRole: roleCounts.reduce((acc, r) => { acc[r.sender_role] = r.c; return acc; }, {}),
      recentMessages: recentMessages.reverse(),
    });
  }

  // ─── Admin: Messages (Paginated) ────────────────────────────────────────

  async handleAdminMessages(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const url = new URL(request.url);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50')));
    const search = url.searchParams.get('search') || '';
    const roleFilter = url.searchParams.get('role') || '';
    const hasImageFilter = url.searchParams.get('hasImage');
    const hasReplyFilter = url.searchParams.get('hasReply');
    const offset = (page - 1) * limit;

    let countQuery = 'SELECT COUNT(*) as c FROM messages WHERE 1=1';
    let dataQuery = `SELECT m.seq, m.epoch, m.sender_tag, m.sender_role, m.body, m.image_id, m.reply_to_seq, m.ts,
                            r.sender_tag AS reply_sender_tag,
                            COALESCE(NULLIF(SUBSTR(r.body, 1, 120), ''), CASE WHEN r.image_id IS NOT NULL THEN '[Image]' ELSE '' END) AS reply_body_preview,
                            r.image_id AS reply_image_id
                     FROM messages m
                     LEFT JOIN messages r ON m.reply_to_seq = r.seq
                     WHERE 1=1`;
    const params = [];
    const countParams = [];

    if (search) {
      const clause = ' AND m.body LIKE ?';
      dataQuery += clause;
      countQuery += clause.replace('m.body', 'body');
      params.push('%' + search + '%');
      countParams.push('%' + search + '%');
    }
    if (roleFilter) {
      const clause = ' AND m.sender_role = ?';
      dataQuery += clause;
      countQuery += clause.replace('m.sender_role', 'sender_role');
      params.push(roleFilter);
      countParams.push(roleFilter);
    }
    if (hasImageFilter === '1' || hasImageFilter === 'true') {
      const clause = ' AND m.image_id IS NOT NULL';
      dataQuery += clause;
      countQuery += clause;
    }
    if (hasReplyFilter === '1' || hasReplyFilter === 'true') {
      const clause = ' AND m.reply_to_seq IS NOT NULL';
      dataQuery += clause;
      countQuery += clause;
    }

    const total = [...this.sql.exec(countQuery, ...countParams)][0].c;

    dataQuery += ' ORDER BY m.seq DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const messages = [...this.sql.exec(dataQuery, ...params)];

    return jsonResponse({ messages: messages.reverse(), total, page, limit });
  }

  // ─── Admin: Delete Single Message ────────────────────────────────────────

  async handleAdminDeleteMessage(request, seqStr) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const seq = parseInt(seqStr, 10);
    if (!seq) return errorResponse('Invalid message sequence');

    const msg = [...this.sql.exec('SELECT image_id FROM messages WHERE seq = ?', seq)][0];
    if (msg && msg.image_id) {
      // Clean up media chunks associated with this image
      this.sql.exec('DELETE FROM media_chunks WHERE image_id = ?', msg.image_id);
    }

    this.sql.exec('DELETE FROM messages WHERE seq = ?', seq);
    this.sql.exec('DELETE FROM offline_mentions WHERE seq = ?', seq);

    // Notify connected clients that message was deleted
    this.broadcast({ type: 'MESSAGE_DELETED', seq });
    return jsonResponse({ success: true, deleted: seq });
  }

  // ─── Admin: Media List ───────────────────────────────────────────────────

  async handleAdminMediaList(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const mediaList = [...this.sql.exec(`
      SELECT m.image_id, m.mime_type,
             SUM(LENGTH(m.data)) as total_size,
             COUNT(m.chunk_index) as chunk_count,
             msg.seq as msg_seq,
             msg.sender_tag,
             msg.ts
      FROM media_chunks m
      LEFT JOIN messages msg ON m.image_id = msg.image_id
      GROUP BY m.image_id, m.mime_type
      ORDER BY COALESCE(msg.ts, 0) DESC
    `)];

    return jsonResponse({ media: mediaList });
  }

  // ─── Admin: Delete Single Media ──────────────────────────────────────────

  async handleAdminDeleteMedia(request, imageId) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM media_chunks WHERE image_id = ?', imageId);
      this.sql.exec('UPDATE messages SET image_id = NULL WHERE image_id = ?', imageId);
    });

    this.broadcast({ type: 'MEDIA_DELETED', image_id: imageId });
    return jsonResponse({ success: true, deleted: imageId });
  }

  // ─── Admin: Moderation & System Diagnostics ──────────────────────────────

  async handleAdminModeration(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const now = Date.now();
    const blockedUsers = [];
    for (const [username, unblockAt] of this.cooldownMap.entries()) {
      if (unblockAt > now) {
        blockedUsers.push({
          username,
          remainingSeconds: Math.ceil((unblockAt - now) / 1000),
          unblockAt,
        });
      } else {
        this.cooldownMap.delete(username);
      }
    }

    const totalMediaBytes = [...this.sql.exec(
      'SELECT COALESCE(SUM(LENGTH(data)), 0) as total FROM media_chunks'
    )][0].total;

    return jsonResponse({
      blockedUsers,
      activeSockets: this.ctx.getWebSockets().length,
      onlineUsers: this.getOnlineUsers(),
      totalMediaBytes,
      epoch: this.getEpoch(),
    });
  }

  // ─── Admin: Unblock User ─────────────────────────────────────────────────

  async handleAdminUnblock(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    const { username } = await request.json();
    if (!username) return errorResponse('Missing username');

    this.cooldownMap.delete(username.toLowerCase());
    return jsonResponse({ success: true, unblocked: username });
  }

  // ─── Admin: Clear Chat (HTTP) ─────────────────────────────────────────────
  async handleAdminClearChatHttp(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user || user.r !== 'admin') return errorResponse('Unauthorized', 401);

    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM messages');
      this.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'messages'");
      this.sql.exec('DELETE FROM media_chunks');
      this.sql.exec('DELETE FROM offline_mentions');
      this.sql.exec('UPDATE room_meta SET chat_epoch = chat_epoch + 1 WHERE id = 1');
    });

    const newEpoch = this.getEpoch();
    this.broadcast({ type: 'CHAT_CLEARED', epoch: newEpoch });
    return jsonResponse({ success: true, epoch: newEpoch });
  }

  // ─── Image Upload ────────────────────────────────────────────────────────

  async handleImageUpload(request) {
    const user = await this.verifyAuthHeader(request);
    if (!user) return errorResponse('Unauthorized', 401);

    const contentLength = parseInt(request.headers.get('Content-Length') || '0');
    if (contentLength > MAX_IMAGE_SIZE) {
      return errorResponse('Payload too large (max 10 MB)', 413);
    }

    // Check rate limit / cooldown
    const cooldownUntil = this.cooldownMap.get(user.u);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return errorResponse('Rate limited. Try again later.', 429);
    }

    const buffer = new Uint8Array(await request.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_SIZE) {
      return errorResponse('Payload too large (max 10 MB)', 413);
    }

    const mimeType = detectImageMime(buffer);
    if (!mimeType) {
      return errorResponse('Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP', 415);
    }

    const imageId = crypto.randomUUID();

    // Chunk and store
    this.ctx.storage.transactionSync(() => {
      for (let i = 0; i * CHUNK_SIZE < buffer.byteLength; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, buffer.byteLength);
        const chunk = buffer.slice(start, end);
        this.sql.exec(
          'INSERT INTO media_chunks (image_id, chunk_index, mime_type, data) VALUES (?, ?, ?, ?)',
          imageId, i, mimeType, chunk
        );
      }
    });

    return jsonResponse({ image_id: imageId });
  }

  // ─── Image Retrieve ──────────────────────────────────────────────────────

  handleImageRetrieve(imageId) {
    const chunks = [...this.sql.exec(
      'SELECT mime_type, data FROM media_chunks WHERE image_id = ? ORDER BY chunk_index ASC',
      imageId
    )];

    if (chunks.length === 0) return errorResponse('Image not found', 404);

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.data.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(new Uint8Array(chunk.data), offset);
      offset += chunk.data.byteLength;
    }

    return new Response(combined, {
      headers: {
        'Content-Type': chunks[0].mime_type,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...CORS_HEADERS,
      },
    });
  }

  // ─── WebSocket Upgrade ───────────────────────────────────────────────────

  async handleWebSocketUpgrade(request) {
    const url = new URL(request.url);
    const tokenStr = url.searchParams.get('token');
    if (!tokenStr) return errorResponse('Missing token', 401);

    const user = await verifyToken(tokenStr, this.env.HMAC_SECRET);
    if (!user) return errorResponse('Invalid or expired token', 401);

    // Check cooldown
    const cooldownUntil = this.cooldownMap.get(user.u);
    if (cooldownUntil && Date.now() < cooldownUntil) {
      return errorResponse('Rate limited. Try again later.', 429);
    }

    const dbUser = [...this.sql.exec('SELECT role FROM users WHERE username = ?', user.u)][0];
    const actualRole = dbUser ? dbUser.role : user.r;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      username: user.u,
      role: actualRole,
      immutableTag: '@' + user.u,
      windowStart: Date.now(),
      msgCount: 0,
    });

    // Send INIT_STATE
    const epoch = this.getEpoch();
    const messages = [...this.sql.exec(
      `SELECT m.seq, m.epoch, m.sender_tag, m.sender_role, m.body, m.image_id, m.reply_to_seq, m.is_important, m.ts,
              r.sender_tag AS reply_sender_tag,
              COALESCE(NULLIF(SUBSTR(r.body, 1, 120), ''), CASE WHEN r.image_id IS NOT NULL THEN '[Image]' ELSE '' END) AS reply_body_preview,
              r.sender_role AS reply_sender_role,
              r.image_id AS reply_image_id
       FROM messages m
       LEFT JOIN messages r ON m.reply_to_seq = r.seq
       ORDER BY m.seq DESC LIMIT ?`,
      INIT_MESSAGE_COUNT
    )].reverse();

    const onlineUsers = this.getOnlineUsers();
    // Add self if not already in list
    if (!onlineUsers.find(u => u.username === user.u)) {
      onlineUsers.push({ username: user.u, role: actualRole });
    }

    // Refresh and prepare public AI capability switches for room
    this.loadAiSwitchesFromDb();
    const aiSwitchesObj = {};
    for (const [aiUser, switches] of this.aiSwitches.entries()) {
      aiSwitchesObj[aiUser] = { ...switches };
    }

    let isUserTagOnly = false;
    try {
      const uRow = [...this.sql.exec('SELECT tag_only FROM users WHERE username = ?', user.u)];
      if (uRow.length > 0) isUserTagOnly = Boolean(uRow[0].tag_only);
    } catch {}

    // Query undelivered offline mentions where this user was tagged while offline
    let offlineMentions = [];
    try {
      offlineMentions = [...this.sql.exec(
        `SELECT m.seq, m.epoch, m.sender_tag, m.sender_role, m.body, m.image_id, m.reply_to_seq, m.is_important, m.ts,
                r.sender_tag AS reply_sender_tag,
                COALESCE(NULLIF(SUBSTR(r.body, 1, 120), ''), CASE WHEN r.image_id IS NOT NULL THEN '[Image]' ELSE '' END) AS reply_body_preview,
                r.sender_role AS reply_sender_role,
                r.image_id AS reply_image_id
         FROM offline_mentions om
         JOIN messages m ON om.seq = m.seq AND om.epoch = m.epoch
         LEFT JOIN messages r ON m.reply_to_seq = r.seq
         WHERE om.target_username = ? AND om.epoch = ? AND om.delivered = 0
         ORDER BY m.seq ASC`,
        user.u.toLowerCase(),
        epoch
      )];
    } catch (e) {
      console.error('Failed to query offline mentions:', e);
    }

    server.send(JSON.stringify({
      type: 'INIT_STATE',
      epoch,
      self: { username: user.u, tag: '@' + user.u, role: actualRole, tag_only: isUserTagOnly },
      messages,
      offline_mentions: offlineMentions,
      onlineUsers,
      aiSwitches: aiSwitchesObj,
    }));

    // Broadcast user joined
    this.broadcast({
      type: 'USER_JOINED',
      username: user.u,
      role: actualRole,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WebSocket Message Handler ───────────────────────────────────────────

  async webSocketMessage(ws, rawData) {
    let data;
    try {
      data = JSON.parse(rawData);
    } catch {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid JSON' }));
      return;
    }

    const attachment = ws.deserializeAttachment();
    if (!attachment) {
      ws.close(1008, 'No attachment');
      return;
    }

    const { username, role, immutableTag } = attachment;

    // Handle PING (keep-alive for extension)
    if (data.type === 'PING') {
      ws.send(JSON.stringify({ type: 'PONG' }));
      return;
    }

    // Handle SEND_MESSAGE
    if (data.type === 'SEND_MESSAGE') {
      // Rate limit check for human users
      if (role === 'user') {
        const now = Date.now();

        // Check cooldown
        const cooldownUntil = this.cooldownMap.get(username);
        if (cooldownUntil && now < cooldownUntil) {
          ws.close(1008, 'Rate limit exceeded (60s cooldown)');
          return;
        }

        // Token bucket
        let { windowStart, msgCount } = attachment;
        if (now - windowStart > RATE_LIMIT_WINDOW) {
          windowStart = now;
          msgCount = 0;
        }
        msgCount++;

        if (msgCount > RATE_LIMIT_MAX_MSGS) {
          this.cooldownMap.set(username, now + RATE_LIMIT_COOLDOWN);
          ws.close(1008, 'Rate limit exceeded (60s cooldown)');
          return;
        }

        ws.serializeAttachment({ ...attachment, windowStart, msgCount });
      }

      const body = (data.body || '').trim();
      if (!body && !data.image_id) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Empty message' }));
        return;
      }

      const epoch = this.getEpoch();
      const ts = Date.now();
      const imageId = data.image_id || null;
      const replyToSeq = data.reply_to_seq || null;

      // Validate reply_to_seq exists if provided
      if (replyToSeq !== null) {
        const replyTarget = [...this.sql.exec(
          'SELECT seq FROM messages WHERE seq = ? AND epoch = ?', replyToSeq, epoch
        )];
        if (replyTarget.length === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Reply target not found' }));
          return;
        }
      }

      // Validate image_id exists if provided
      if (imageId !== null) {
        const imageCheck = [...this.sql.exec(
          'SELECT COUNT(*) as c FROM media_chunks WHERE image_id = ?', imageId
        )];
        if (imageCheck[0].c === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Image not found' }));
          return;
        }
      }

      const isImportant = data.is_important ? 1 : 0;

      // Insert message
      this.sql.exec(
        `INSERT INTO messages (epoch, sender_tag, sender_role, body, image_id, reply_to_seq, is_important, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        epoch, immutableTag, role, body || '', imageId, replyToSeq, isImportant, ts
      );

      // Get the inserted seq
      const inserted = [...this.sql.exec('SELECT last_insert_rowid() as seq')][0];
      const seq = inserted.seq;

      // Build reply preview if needed
      let replyPreview = null;
      if (replyToSeq !== null) {
        const rp = [...this.sql.exec(
          'SELECT sender_tag, sender_role, SUBSTR(body, 1, 120) as body, image_id FROM messages WHERE seq = ?',
          replyToSeq
        )];
        if (rp.length > 0) {
          replyPreview = {
            reply_sender_tag: rp[0].sender_tag,
            reply_sender_role: rp[0].sender_role,
            reply_body_preview: rp[0].body || (rp[0].image_id ? '[Image]' : ''),
            reply_image_id: rp[0].image_id || null,
          };
        }
      }

      // Record offline mentions if any user/AI tagged in this message was not online
      try {
        const mentionMatches = (body || '').match(/@([a-zA-Z0-9_]+)/g) || [];
        const mentionedUsernames = new Set(
          mentionMatches.map(m => m.slice(1).toLowerCase())
        );

        // If replying to another message, also check reply target author
        if (replyToSeq !== null && replyPreview && replyPreview.reply_sender_tag) {
          const targetUser = replyPreview.reply_sender_tag.replace(/^@/, '').toLowerCase();
          mentionedUsernames.add(targetUser);
        }

        if (mentionedUsernames.size > 0) {
          const onlineUsernames = new Set(
            this.getOnlineUsers().map(u => u.username.toLowerCase())
          );

          for (const targetUser of mentionedUsernames) {
            // If the mentioned user or AI is NOT currently online in the room, flag it as an offline mention!
            if (!onlineUsernames.has(targetUser)) {
              this.sql.exec(
                `INSERT INTO offline_mentions (epoch, seq, target_username, sender_tag, delivered, created_at)
                 VALUES (?, ?, ?, ?, 0, ?)`,
                epoch, seq, targetUser, immutableTag, ts
              );
            }
          }
        }
      } catch (err) {
        console.error('Failed to record offline mentions:', err);
      }

      // Broadcast to ALL
      this.broadcast({
        type: 'MESSAGE_CREATED',
        epoch,
        message: {
          seq,
          sender_tag: immutableTag,
          sender_role: role,
          body: body || '',
          image_id: imageId,
          reply_to_seq: replyToSeq,
          is_important: Boolean(isImportant),
          ts,
          ...(replyPreview || {}),
        },
      });
      return;
    }

    // Handle ADMIN_CLEAR_CHAT
    if (data.type === 'ADMIN_CLEAR_CHAT') {
      if (role !== 'admin') {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Admin only' }));
        return;
      }

      this.ctx.storage.transactionSync(() => {
        this.sql.exec('DELETE FROM messages');
        this.sql.exec("DELETE FROM sqlite_sequence WHERE name = 'messages'");
        this.sql.exec('DELETE FROM media_chunks');
        this.sql.exec('DELETE FROM offline_mentions');
        this.sql.exec('UPDATE room_meta SET chat_epoch = chat_epoch + 1 WHERE id = 1');
      });

      const newEpoch = this.getEpoch();
      this.broadcast({ type: 'CHAT_CLEARED', epoch: newEpoch });
      return;
    }

    // Handle ACK_OFFLINE_MENTIONS
    if (data.type === 'ACK_OFFLINE_MENTIONS') {
      const seqs = Array.isArray(data.seqs) ? data.seqs : [];
      if (seqs.length > 0) {
        const placeholders = seqs.map(() => '?').join(',');
        try {
          this.sql.exec(
            `UPDATE offline_mentions SET delivered = 1 WHERE target_username = ? AND seq IN (${placeholders})`,
            username.toLowerCase(), ...seqs
          );
        } catch (e) {
          console.error('Failed to ack offline mentions:', e);
        }
      }
      return;
    }

    // Handle SET_AI_SWITCH (Public toggle switch controllable by any participant)
    if (data.type === 'SET_AI_SWITCH') {
      const { ai_username, switch_id, enabled } = data;
      if (!ai_username || !switch_id || typeof enabled !== 'boolean') {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid SET_AI_SWITCH parameters' }));
        return;
      }

      const cleanAiName = ai_username.toLowerCase().replace(/[^a-z0-9_]/g, '');
      const current = this.aiSwitches.get(cleanAiName) || { deepthink: false, search: false, tag_only: false };
      current[switch_id] = enabled;
      this.aiSwitches.set(cleanAiName, current);

      // Persist tag_only change to users table
      if (switch_id === 'tag_only') {
        try {
          this.sql.exec('UPDATE users SET tag_only = ? WHERE username = ?', enabled ? 1 : 0, cleanAiName);
        } catch {}
      }

      // Broadcast public change to ALL connected users and extension instances
      this.broadcast({
        type: 'AI_SWITCH_CHANGED',
        ai_username: cleanAiName,
        switch_id,
        enabled,
        changed_by: username,
      });
      return;
    }

    // Handle REGISTER_AI_SWITCHES (AI extension declares available features on mount)
    if (data.type === 'REGISTER_AI_SWITCHES') {
      const { switches } = data;
      if (switches && typeof switches === 'object') {
        const cleanAiName = username.toLowerCase().replace(/[^a-z0-9_]/g, '');
        const current = this.aiSwitches.get(cleanAiName) || {};
        this.aiSwitches.set(cleanAiName, { ...current, ...switches });

        this.broadcast({
          type: 'AI_SWITCHES_REGISTERED',
          ai_username: cleanAiName,
          switches: this.aiSwitches.get(cleanAiName),
        });
      }
      return;
    }

    // Handle TOGGLE_MESSAGE_IMPORTANT (Mark / unmark message as Important for offline sync)
    if (data.type === 'TOGGLE_MESSAGE_IMPORTANT') {
      const seq = parseInt(data.seq, 10);
      if (!seq) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Missing sequence ID' }));
        return;
      }

      this.sql.exec(
        'UPDATE messages SET is_important = CASE WHEN is_important = 1 THEN 0 ELSE 1 END WHERE seq = ?',
        seq
      );

      const row = [...this.sql.exec('SELECT is_important FROM messages WHERE seq = ?', seq)][0];
      if (row) {
        this.broadcast({
          type: 'MESSAGE_IMPORTANT_CHANGED',
          seq,
          is_important: Boolean(row.is_important),
          toggled_by: username,
        });
      }
      return;
    }

    ws.send(JSON.stringify({ type: 'ERROR', message: 'Unknown message type: ' + data.type }));
  }

  // ─── WebSocket Close Handler ─────────────────────────────────────────────

  async webSocketClose(ws, code, reason, wasClean) {
    try {
      const attachment = ws.deserializeAttachment();
      if (attachment) {
        this.broadcast({
          type: 'USER_LEFT',
          username: attachment.username,
        });
      }
    } catch {}
  }
}

// ============================================================================
// WORKER ENTRY POINT
// ============================================================================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Favicon fallback (prevent errors)
    if (url.pathname === '/favicon.ico') {
      return new Response(null, { status: 204 });
    }

    // API and WebSocket routes → Durable Object
    if (url.pathname.startsWith('/api/') || url.pathname === '/ws') {
      const id = env.CHAT_ROOM.idFromName('GLOBAL_SINGLETON_ROOM');
      const stub = env.CHAT_ROOM.get(id);
      return stub.fetch(request);
    }

    // Everything else → static assets (index.html, app.js, style.css)
    try {
      return await env.ASSETS.fetch(request);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  },
};
