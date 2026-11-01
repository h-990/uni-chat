# 🔌 Uni-Chat AI Automator (Manifest V3)

A clean, modern, extensible Chrome extension bridge connecting web-based AI assistants (starting with [chat.deepseek.com](https://chat.deepseek.com)) directly to the **Uni-Chat singleton group room** on Cloudflare Workers.

---

## 🚀 Routing Rules & Architecture

1. **Clean Routing Pipeline**:
   - **Direct @Tag Trigger**: When any user in the chat tags `@deepseek` (or whatever the AI's username is), all messages received since the last synced response are bundled and immediately dispatched to DeepSeek.
   - **Configurable Batch Threshold**: Set a message threshold (e.g. 10, 20, 30). When unrouted human messages reach this threshold, the backlog automatically routes to the AI.
   - **Self-Response Attribution**: Past responses from the AI itself are explicitly marked in the transcript as `[You (DeepSeek)]: your previous response was: "..."`, providing zero-hole context.
   - **Image Attachment**: Images sent with messages are retrieved from `/api/image/:id` and attached directly to the web chat's file input.
2. **Strict Authentication**:
   - The extension authenticates via `/api/auth` using the AI Username and Password/Key created by the Admin.
   - If no key is provided or authentication fails, connection is rejected.
   - Connects with `role: 'ai'`, broadcasting its status as an official AI participant.
3. **Extensible AI Adapters**:
   - Built with an adapter pattern (`adapters/deepseek.js`).
   - Easily extendable to ChatGPT (`chatgpt.com`), Claude (`claude.ai`), or other web interfaces.
4. **Admin Freedom**:
   - No forced switches or complex S-expression wrappers. The Admin can freely toggle DeepThink, Web Search, or temperature directly in the DeepSeek web tab.

---

## 🛠️ Setup Instructions

### Step 1: Create the AI Account in Uni-Chat Admin
1. Open [https://chat.unichat.workers.dev](https://chat.unichat.workers.dev).
2. Log in with your admin credentials (**Username**: `Harsh`, **Password**: `Harsh@9990`).
3. Click the **Admin Panel** icon in the header.
4. Go to **AI Accounts**, enter username `deepseek` and a secure password/key (e.g. `deepseek_secret_key`), and click **Save**.

### Step 2: Load the Extension in Chrome
1. In Google Chrome, go to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top-right.
3. Click **Load unpacked** (or 🔄 **Reload** if already loaded) and select the `/Users/harshkhushi/Desktop/uni-chat/extension` directory.

### Step 3: Connect
1. Open [https://chat.deepseek.com](https://chat.deepseek.com) in Chrome and ensure you are logged in.
2. Click the **Uni-Chat Automator** extension icon.
3. Enter:
   - **Server URL**: `https://chat.unichat.workers.dev`
   - **AI Username**: `deepseek`
   - **AI Password / Key**: The password you set in Step 1.
   - **Batch Threshold**: e.g. `20`
4. Click **Connect as AI**.
5. The status pill will turn green (`CONNECTED`).
