import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

const FRESHCHAT_TOKEN = process.env.FRESHCHAT_TOKEN;
const FRESHCHAT_DOMAIN = process.env.FRESHCHAT_DOMAIN;

const MAX_ATTEMPTS = 3;
const RETRY_BASE = 250; // ms

function isValidId(id?: string | null) {
  return !!id && /^[a-zA-Z0-9_-]{6,}$/.test(id);
}

async function fetchWithRetry(url: string, config: any) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (err: any) {
      if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_BASE * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

function extractTextFromParts(parts: any[]): string[] {
  if (!Array.isArray(parts)) return [];
  const extractedTexts: string[] = [];
  for (const part of parts) {
    // Standard text message part: { "text": { "content": "..." } }
    if (part.text && typeof part.text.content === 'string') {
      extractedTexts.push(part.text.content);
      continue;
    }
    // Fallback for other potential structures
    if (typeof part.content === 'string') {
      extractedTexts.push(part.content);
      continue;
    }
    if (typeof part.text === 'string') {
      extractedTexts.push(part.text);
      continue;
    }
  }
  return extractedTexts.filter(text => text.trim() !== '');
}

export async function GET(req: NextRequest) {
  const conversation_id = req.nextUrl.searchParams.get('conversation_id');
  if (!isValidId(conversation_id)) {
    return NextResponse.json({ error: 'Invalid or missing conversation id.' }, { status: 400 });
  }
  if (!FRESHCHAT_TOKEN || !FRESHCHAT_DOMAIN)
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 });
  const headers = { Authorization: `Bearer ${FRESHCHAT_TOKEN}` };
  const items_per_page = 50;
  let messages: any[] = [];
  let page = 1;
  let hasMore = true;
  try {
    while (hasMore) {
      const url = `https://${FRESHCHAT_DOMAIN}/v2/conversations/${conversation_id}/messages?items_per_page=${items_per_page}&page=${page}`;
      const res = await fetchWithRetry(url, { headers });
      const batch = res?.data?.messages || [];
      messages = messages.concat(
        batch.map((m: any) => ({
          id: m.id,
          actor_type: m.actor_type,
          message_parts: extractTextFromParts(m.message_parts),
          created_time: m.created_time,
        }))
      );
      hasMore = batch.length === items_per_page;
      page++;
    }
    return NextResponse.json({ messages }, { status: 200 });
  } catch (err: any) {
    if (err.response) {
      return NextResponse.json({ error: err.response.data?.error || 'API error' }, { status: err.response.status });
    }
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
