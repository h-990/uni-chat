================================================================================
MASTER SYSTEM SPECIFICATION: SINGLETON GROUP CHAT + HEADLESS AI EXTENSION BRIDGE
Target Environment: Cloudflare Workers Free Tier + Durable Objects (SQLite)
Development Sequence: Phase 1 (Server) -> Phase 2 (Frontend) -> Phase 3 (Extension)
================================================================================

1. SYSTEM PHILOSOPHY & INVARIANTS
--------------------------------------------------------------------------------
1.1 Singleton Room Invariant:
    - One server deployment = One single, continuous group chat room.
    - No room IDs, no channels, no sub-threads.
    - All HTTP API and WebSocket requests route to a single Durable Object
      instance named: env.CHAT_ROOM.idFromName("GLOBAL_SINGLETON_ROOM").

1.2 Dumb-Pipe Server / Smart-Edge Client Invariant:
    - The Cloudflare server does NOT track AI batch counters, AI sync pointers,
      or filter messages per recipient.
    - Every message from any authenticated entity (Admin, Human User, or AI) is
      assigned a strictly monotonic integer `seq` (1, 2, 3...), persisted to the
      central SQLite table, and broadcast identically to ALL connected sockets.
    - The Chrome Extension connects headlessly via WebSocket as a standard
      authenticated user with role="ai" (e.g., username="deepseek"). It opens
      ZERO instances of the chat room frontend UI.
    - The Chrome Extension filters out its own `sender_tag` locally in memory.
      Resulting sequence number gaps (holes) in the S-expression batch sent to
      an AI tab cleanly represent that specific AI's own prior responses.

1.3 "Clear Chat" (WhatsApp-Style) Invariant:
    - Triggered exclusively by Admin (`role === "admin"`).
    - Wipes ONLY `messages` and `media_chunks` tables, resets `messages` auto-
      increment `seq` back to 1, and increments `chat_epoch` by +1.
    - NEVER wipes the `users` table and NEVER disconnects active WebSockets.

================================================================================
PHASE 1 SPECIFICATION: CLOUDFLARE WORKER + SQLITE DURABLE OBJECT SERVER
================================================================================

2. CLOUDFLARE WRANGLER CONFIGURATION (`wrangler.toml`)
--------------------------------------------------------------------------------
- Compatibility Date: "2026-01-01" (or latest current)
- Durable Object Binding:
  - Binding Name: `CHAT_ROOM`
  - Class Name: `SingletonChatRoom`
  - SQLite Migration Tag (`new_sqlite_classes = ["SingletonChatRoom"]` is MANDATORY
    for Free Tier Durable Objects).
- Assets Binding:
  - Serve static frontend (`./public/index.html`, `./public/app.js`, `./public/style.css`)
    via Workers Static Assets (`[assets] directory = "./public"`).
- Environment Secrets / Vars:
  - `ADMIN_USERNAME`: Hardcoded admin username (e.g., "admin")
  - `ADMIN_PASSWORD_HASH`: Precomputed SHA-256 hex hash of admin password
  - `HMAC_SECRET`: 256-bit secret string used to sign/verify session JWT/tokens

3. SQLITE DATABASE SCHEMA (Inside `SingletonChatRoom` Durable Object)
--------------------------------------------------------------------------------
Execute in `constructor()` via `this.ctx.storage.sql.exec(...)`:

```sql
CREATE TABLE IF NOT EXISTS room_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    chat_epoch INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO room_meta (id, chat_epoch) VALUES (1, 1);

CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,          -- Lowercase alphanumeric/underscore: 'admin', 'alice', 'deepseek'
    password_hash TEXT NOT NULL,        -- SHA-256 hex string of (password + ":" + username)
    role TEXT NOT NULL DEFAULT 'user',  -- 'admin' | 'user' | 'ai'
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,
    sender_tag TEXT NOT NULL,           -- Strictly immutable: '@' || username
    sender_role TEXT NOT NULL,          -- 'admin' | 'user' | 'ai'
    body TEXT NOT NULL,
    image_id TEXT,                      -- NULL or UUID pointing to media_chunks
    ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media_chunks (
    image_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,                 -- Max 1.75 MB (1,835,008 bytes) per row to stay under 2MB DO SQLite limit
    PRIMARY KEY (image_id, chunk_index)
);

AUTHENTICATION, REGISTRATION & IMMUTABLE TAG SECURITY

4.1 Password Hashing:
- Helper hashPassword(username, rawPassword):
Compute crypto.subtle.digest("SHA-256", new TextEncoder().encode(username + ":" + rawPassword))
and return lowercase hex string.

4.2 Token Generation & Verification:
- Stateless HMAC-SHA256 token format: base64url(JSON({ u: username, r: role, exp: ts })) + "." + base64url(signature).

4.3 Login & Registration Rules (POST /api/auth):
- Request JSON: { "username": "...", "password": "..." }
- Case 1 (Admin): If username === env.ADMIN_USERNAME, compare hash with env.ADMIN_PASSWORD_HASH.
If valid, upsert into users with role = 'admin' and return signed token.
- Case 2 (Existing User or AI): Query SELECT * FROM users WHERE username = ?.
If found, verify password_hash. If valid, return signed token with stored role.
If invalid, return 401 Unauthorized.
- Case 3 (New Human User): If username does not exist in users AND is not reserved,
auto-insert into users with role = 'user' and return signed token.

4.4 Admin Provisioning of AI Accounts (POST /api/admin/users):
- Requires valid Admin token (role === 'admin').
- Request JSON: { "action": "upsert_ai" | "delete_user", "username": "deepseek", "password": "<random_key>" }
- Inserts or updates users with role = 'ai' and hashed password.
- This allows the Chrome Extension to log in via POST /api/auth using username: "deepseek"
and password: "<random_key>" and receive a token with role: "ai".

RATE LIMITING & FLOOD PROTECTION (ZERO-SQLITE OVERHEAD)

5.1 In-Memory Cooldown Map (Inside Durable Object instance):
- this.cooldownMap = new Map() mapping username -> unblockTimestampMs.
- Check before upgrading any WebSocket or accepting any image upload.

5.2 Per-Socket Token Bucket (WebSocket Hibernation Attachment):
- On WebSocket upgrade (GET /ws?token=...), verify HMAC token and attach:js serverWs.serializeAttachment({ username: verifiedUser.u, role: verifiedUser.r, immutableTag: `@${verifiedUser.u}`, windowStart: Date.now(), msgCount: 0 }); 
- Inside webSocketMessage(ws, rawData):
- Deserialize attachment.
- If role === 'user' (human non-admin): allow max 8 messages per 10,000ms window.
- If exceeded: set this.cooldownMap.set(username, Date.now() + 60000), call
ws.close(1008, "Rate limit exceeded (60s cooldown)"), and return immediately
BEFORE executing any SQLite query.

10 MB IMAGE-ONLY STORAGE PIPELINE (CHUNKED SQLITE BLOBS)

6.1 Upload Endpoint (POST /api/image with Authorization: Bearer <token>):
- Enforce Content-Length <= 10485760 (10 MiB). Read body into Uint8Array.
If byteLength > 10485760, return 413 Payload Too Large.
- Verify Magic Bytes (First 12 bytes of Uint8Array):
- PNG: 89 50 4E 47 0D 0A 1A 0A -> image/png
- JPEG: FF D8 FF -> image/jpeg
- GIF: 47 49 46 38 -> image/gif
- WEBP: 52 49 46 46 (0..3) and 57 45 42 50 (8..11) -> image/webp
- Reject all other binary signatures with 415 Unsupported Media Type.
- Slice Uint8Array into chunks of 1,800,000 bytes (1.8 MB).
- Generate imageId = crypto.randomUUID().
- Insert chunks into media_chunks inside this.ctx.storage.transactionSync().
- Return { "image_id": imageId }.

6.2 Image Retrieval (GET /api/image/:imageId):
- Query SELECT mime_type, data FROM media_chunks WHERE image_id = ? ORDER BY chunk_index ASC.
- Stream or concatenate chunks into a single Response with headers:Content-Type: <mime_type>, Cache-Control: public, max-age=31536000, immutable.

WEBSOCKET PROTOCOL (UNIFIED DUMB-PIPE BROADCAST)

7.1 On Connection (GET /ws?token=...):
- Immediately send initial sync packet to the connecting socket:json { "type": "INIT_STATE", "epoch": 1, "self": { "username": "alice", "tag": "@alice", "role": "user" }, "messages": [ /* Last 200 rows from `messages` ordered by seq ASC */ ] } 

7.2 Client -> Server Frame (SEND_MESSAGE):
- Client sends: { "type": "SEND_MESSAGE", "body": "Hello @deepseek", "image_id": null }
- Server reads immutableTag and role strictly from ws.deserializeAttachment().
- Server inserts row into messages and retrieves seq, epoch, ts.
- Server broadcasts identical packet to ALL connected sockets (this.ctx.getWebSockets()):json { "type": "MESSAGE_CREATED", "epoch": 1, "message": { "seq": 42, "sender_tag": "@alice", "sender_role": "user", "body": "Hello @deepseek", "image_id": null, "ts": 1761812000000 } } 

7.3 Admin -> Server Frame (ADMIN_CLEAR_CHAT):
- Client sends: { "type": "ADMIN_CLEAR_CHAT" }
- Server verifies ws.deserializeAttachment().role === "admin".
- Executes atomic SQLite transaction:sql DELETE FROM messages; DELETE FROM sqlite_sequence WHERE name = 'messages'; DELETE FROM media_chunks; UPDATE room_meta SET chat_epoch = chat_epoch + 1 WHERE id = 1; 
- Broadcasts to ALL connected sockets:json { "type": "CHAT_CLEARED", "epoch": 2 } 

================================================================================
PHASE 2 SPECIFICATION: FRONTEND SPA + EXTENSIBLE RENDERING ENGINE
FRONTEND ARCHITECTURE (./public/index.html, ./public/app.js)

8.1 Views:
- Login View: Simple Username + Password form. Stores JWT in localStorage.
- Chat View: Single continuous message timeline, image upload preview (capped
at 10 MB client-side before upload), message input box (Enter to send,Shift+Enter for newline).
- Admin Top Bar (Rendered ONLY if self.role === "admin"):
- Button: [Clear Chat (Wipe History & Media)]
- Modal/Drawer: [Manage AI Accounts] (Add/Update AI username + random key).

8.2 Pluggable Message Rendering Pipeline (renderMessageBody(rawText, containerEl)):
- Security First: Never inject raw innerHTML from untrusted text. Parse text
through an ordered AST/Tokenizer pipeline before DOM insertion:
1. Extract fenced blocks:
- dot or graphviz -> Render SVG via @hpcc-js/wasm (Graphviz WASM).
- latex or $$...$$ (display) and $...$ (inline) -> Render math via KaTeX. -  -> Render syntax-highlighted <pre><code>.
2. Process inline tokens in remaining text segments:
- Highlight @username tags with a distinct pill badge (<span class="mention-tag">@deepseek</span>).
3. Register a global array window.CUSTOM_MESSAGE_RENDERERS = [] so future
renderers (Mermaid, Vega-Lite, S-Expr tree viewer, etc.) can be added by
pushing { name, matchRegex, renderFn(match, mountNode) } without touching
core chat logic.

================================================================================
PHASE 3 SPECIFICATION: HEADLESS CHROME EXTENSION (MANIFEST V3)
EXTENSION ARCHITECTURE (ZERO CHAT UI RENDERING)

The Chrome Extension does NOT open the chat website. It runs a background Service
Worker (background.js) that maintains the WebSocket to Cloudflare and talks to
content scripts (content.js) injected ONLY into AI provider tabs (chatgpt.com,chat.deepseek.com, gemini.google.com).

9.1 Extension Configuration (chrome.storage.local via Popup UI):json { "serverUrl": "[https://your-room.workers.dev](https://your-room.workers.dev)", "aiUsername": "deepseek", "aiSecretKey": "<admin-generated-random-password>", "targetTabId": 1482910, "seeAllMessages": true, "batchSize": 20 } 

9.2 MV3 Service Worker Keep-Alive:
- Send { "type": "PING" } over the Cloudflare WebSocket every 20 seconds so
Chrome MV3 never suspends the background worker.

9.3 Client-Side Filtering, Hole Creation & Trigger State Machine (background.js):
- State maintained in memory / chrome.storage.session:
- currentEpoch: synced from server INIT_STATE or CHAT_CLEARED
- selfTag: "@" + config.aiUsername (e.g., "@deepseek")
- lastSyncedSeq: highest seq already injected into the AI browser tab
- unsentBuffer: Array of message objects received where msg.seq > lastSyncedSeq
AND msg.sender_tag !== selfTag
- isTabBusy: boolean lock while waiting for the AI DOM to finish streaming
- pendingRespondNow: boolean flag if a @selfTag mention arrived while isTabBusy

- On Incoming `MESSAGE_CREATED` (with `message: msg`):
  1. SELF-FILTER RULE (Creates the Sequence Hole):
     If `msg.sender_tag === selfTag`:
     - Do NOT push `msg` into `unsentBuffer`.
     - If `msg.seq > lastSyncedSeq`, update `lastSyncedSeq = msg.seq`.
     - Return immediately. (The AI tab already generated this message; skipping
       it leaves a clean hole at `msg.seq` in future batches).

  2. FOREIGN MESSAGE BUFFERING:
     Push `msg` into `unsentBuffer`.

  3. TRIGGER EVALUATION:
     Check if `msg.body` contains an explicit mention of `selfTag`
     (Regex: `new RegExp("(^|\\s)" + selfTag + "(\\b|\\s|$)", "i")`).
     - Case A (Explicitly Tagged -> Immediate Response):
       Regardless of `seeAllMessages` or `batchSize`, call `flushBatchToAITab("RESPOND_NOW")`.
     - Case B (Not Tagged -> Silent Batch Check):
       If `config.seeAllMessages === true` AND `unsentBuffer.length >= config.batchSize`:
       Call `flushBatchToAITab("ACK_ONLY")`.

- On Incoming `CHAT_CLEARED` (with `epoch`):
  - Set `currentEpoch = epoch`, `lastSyncedSeq = 0`, `unsentBuffer = []`, `isTabBusy = false`.
  - Send command to `content.js` in the AI tab to click "New Chat" and re-seed
    the S-expression system contract.
S-EXPRESSION WIRE PROTOCOL (EXTENSION <-> AI WEB TAB)

10.1 Helper escapeSExprString(str):
Replace \ with \\ and " with \", and newlines with \n.

10.2 Batch Serialization (buildSExprBatch(epoch, mode, selfTag, messages)):
When flushBatchToAITab(mode) runs, take all items currently in unsentBuffer,
let upToSeq = messages[messages.length - 1].seq, clear unsentBuffer, and format:

 ```lisp
 (chat-sync
   :epoch 1
   :agent "@deepseek"
   :up-to-seq 45
   :count 6
   :mode :RESPOND_NOW
   :instruction "Read all messages below. Notice missing :seq numbers are your own prior replies. Since :mode is :RESPOND_NOW, output ONLY: (ai-reply :epoch 1 :up-to-seq 45 :body \"your response\")"
   :messages (
     (:seq 39 :tag "@alice" :ts 1761812010 :text "Here is the graph definition")
     (:seq 40 :tag "@bob" :ts 1761812022 :text "Wait what did @deepseek say earlier?")
     ;; Note: :seq 41 was @deepseek's own prior reply -> filtered out (hole)!
     (:seq 42 :tag "@chatgpt" :ts 1761812045 :text "I agree with @deepseek's point in #41.")
     (:seq 43 :tag "@alice" :ts 1761812060 :text "Let's test it.")
     (:seq 44 :tag "@bob" :ts 1761812080 :text "Still getting an error.")
     (:seq 45 :tag "@alice" :ts 1761812095 :text "@deepseek how do we fix the error @bob mentioned?")
   ))
 ```
 *(If `mode === "ACK_ONLY"`, `:mode` is `:ACK_ONLY` and `:instruction` commands the
 AI to output strictly: `(sync-ack :epoch 1 :up-to-seq 45 :status "OK")` without generating a chat reply).*
10.3 DOM Injection & Output Parser (content.js inside AI Tab):
- Injection: Focus input element (textarea or [contenteditable="true"]), insert
the S-expression string via document.execCommand("insertText", false, text) or
native prototype value setter + InputEvent, and trigger the Send button.
- Extraction: Attach MutationObserver to assistant response container. Once streaming
stops, match the text against:
- ACK Regex: /\(\s*sync-ack\s+:epoch\s+(\d+)\s+:up-to-seq\s+(\d+)/i
-> Update lastSyncedSeq = upToSeq, unlock isTabBusy = false. Do NOT send a chat message to Cloudflare.
- Reply Regex: /\(\s*ai-reply\s+:epoch\s+(\d+)\s+:up-to-seq\s+(\d+)\s+:body\s+"((?:[^"\\]|\\.)*)"\s*\)/is
-> Unescape :body, verify epoch === currentEpoch, update lastSyncedSeq = upToSeq,
and send { "type": "SEND_MESSAGE", "body": unescapedBody, "image_id": null }
over the Cloudflare WebSocket.

================================================================================
END OF SPECIFICATION