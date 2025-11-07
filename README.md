# Freshchat Conversation Viewer

A simple Next.js (App Router, TypeScript) app to look up Freshchat user conversations by phone number, view all user's conversations, and explore messages (BOT vs USER color-coded). Secure, responsive, and easy to use.

## 1. Setup & Requirements

- Node.js 18+
- Freshchat V2 API access (bearer token)
- .env.local file required
- Modern browser

## 2. Installation

```
npm install
```

## 3. Configure Environment

Create `.env.local` in the root with these fields:

```
FRESHCHAT_TOKEN=Bearer xxxxxxxx...your_freshchat_token...
FRESHCHAT_DOMAIN=your-account.freshchat.com
```
- **FRESHCHAT_TOKEN**: The Bearer token for your Freshchat API (can include "Bearer " prefix, as demonstrated)
- **FRESHCHAT_DOMAIN**: Your Freshchat domain (no https:// prefix!)

## 4. Running the App

```
npm run dev
```

Open: [http://localhost:3000](http://localhost:3000)

## 5. Usage

- Enter a phone number for the user (e.g., `174285396`).
- Press **Fetch Conversations**. You will see any conversations for the matched user, otherwise a toast error will be shown if not found.
- Click a conversation to view all its messages, color-coded by actor: **BOT = Blue, USER = Green**.
- Errors and API issues will show as toast notifications (top right).
- Loading spinners are shown as data is fetched.
- Data is always fetched fresh from the API (no DB).

## 6. Endpoints (Backend)
- `/api/get-conversations?phone=PHONE` → `{ conversations: [id, created_time, status, channel_id] }`
- `/api/get-messages?conversation_id=ID` → `{ messages: [id, actor_type, message_parts, created_time] }`

## 7. Security & Error Handling
- Phone number is validated (numeric, 6-15 digits).
- API tokens/secrets are never exposed client-side.
- Graceful error handling and retries are built-in.
- Handles rate limits (429) with exponential backoff.

## 8. Tech Stack
- **Next.js** (App Router, TypeScript)
- **Tailwind CSS** (UI, fully responsive)
- **axios** (backend API calls)
- **react-hot-toast** (toasts/notifications)

---

**Sample Phone Number:** `174285396` _(replace with a real user phone in your Freshchat domain)_
