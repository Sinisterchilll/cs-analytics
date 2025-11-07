import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';

const FRESHCHAT_TOKEN = process.env.FRESHCHAT_TOKEN;
const FRESHCHAT_DOMAIN = process.env.FRESHCHAT_DOMAIN;

// Basic input validation
const PHONE_REGEX = /^[0-9]{6,15}$/;

const MAX_ATTEMPTS = 3;
const RETRY_BASE = 250; // ms

async function fetchWithRetry(url: string, config: any) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (err: any) {
      // 429: Too Many Requests
      if (err.response?.status === 429 && attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, RETRY_BASE * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
}

export async function GET(req: NextRequest) {
  const phone = req.nextUrl.searchParams.get('phone');
  if (!phone || !PHONE_REGEX.test(phone)) {
    return NextResponse.json({ error: 'Invalid or missing phone number.' }, { status: 400 });
  }
  if (!FRESHCHAT_TOKEN || !FRESHCHAT_DOMAIN)
    return NextResponse.json({ error: 'Server misconfiguration.' }, { status: 500 });
  try {
    // Step 1: Fetch user by phone
    const userRes = await fetchWithRetry(
      `https://${FRESHCHAT_DOMAIN}/v2/users?phone_no=${phone}`,
      { headers: { Authorization: `Bearer ${FRESHCHAT_TOKEN}` } }
    );
    const users = userRes?.data?.users || [];
    if (!users.length) {
      return NextResponse.json({ error: 'User not found.' }, { status: 404 });
    }
    const user_id = users[0].id;

    // Step 2: Fetch conversations
    const convRes = await fetchWithRetry(
      `https://${FRESHCHAT_DOMAIN}/v2/users/${user_id}/conversations?items_per_page=100`,
      { headers: { Authorization: `Bearer ${FRESHCHAT_TOKEN}` } }
    );
    const conversations = (convRes?.data?.conversations || []).map(
      (c: any) => ({ id: c.id, created_time: c.created_time, status: c.status, channel_id: c.channel_id })
    );
    return NextResponse.json({ conversations }, { status: 200 });
  } catch (err: any) {
    if (err.response) {
      return NextResponse.json({ error: err.response.data?.error || 'API error' }, { status: err.response.status });
    }
    return NextResponse.json({ error: 'Internal server error.' }, { status: 500 });
  }
}
