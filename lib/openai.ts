import OpenAI from 'openai';

// Lazy initialization - will be called after dotenv loads
let openaiInstance: OpenAI | null = null;

export const openai = new Proxy({} as OpenAI, {
  get(target, prop) {
    if (!openaiInstance) {
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      if (!OPENAI_API_KEY) {
        throw new Error('Missing OPENAI_API_KEY in environment. Make sure dotenv is loaded before using openai client.');
      }
      openaiInstance = new OpenAI({ apiKey: OPENAI_API_KEY });
    }
    return (openaiInstance as any)[prop];
  }
});

export const MODEL = 'gpt-4o-mini-2024-07-18';

/**
 * System prompt for message classification
 * Defines categories and tags for EV bike customer support
 */
export const SYSTEM_PROMPT = `You are an expert customer support message classifier for an EV bike company. Analyze customer messages and extract:

1. **Language**: Detect the primary language
   - "en" for English
   - "hi" for Hindi
   - "hi-en" for Hinglish (mixed Hindi-English)
   - "ta" for Tamil ( words can be in English script)
   - "te" for Telugu ( words can be in English script)
   - "kn" for Kannada ( words can be in English script)
   - "ml" for Malayalam ( words can be in English script)
   - "bn" for Bengali ( words can be in English script)
   - "mr" for Marathi ( words can be in English script)
   - "gu" for Gujarati ( words can be in English script)
   - "pa" for Punjabi ( words can be in English script)

2. **Category**: Choose ONE most relevant category:
   - "kyc": KYC verification, document submission, identity verification
   - "bike_not_moving": Bike won't start, not moving, stuck, immobile
   - "battery_problem": Battery issues, charging problems, battery not working, range issues
   - "price_inquiry": Questions about bike price, cost, EMI, financing
   - "offer_inquiry": Discount questions, offers, promotions, deals
   - "app_related": Mobile app issues, login problems, app not working
   - "hub_inquiry": Hub location questions, service center queries, showroom location
   - "payment": Payment issues, transaction problems, payment method questions
   - "others": General queries, greetings, or anything not fitting above categories
   - "bike_inquiry": Bike related questions, bike features, bike specifications, bike comparison

3. **Tag**: Assign EXACTLY ONE tag based on category:
   - "cs" for categories: kyc, app_related, payment, others
   - "bot" for categories: price_inquiry, hub_inquiry, offer_inquiry, bike_inquiry
   - "escalated" for categories: bike_not_moving, battery_problem

4. **Confidence**: Your confidence in the classification (0.0 to 1.0)

**Important Classification Rules**:
- KYC: Documents, Aadhaar, PAN, verification, identity proof
- Bike not moving: Vehicle stuck, won't start, not working, immobile, breakdown
- Battery problem: Charging, battery dead, range reduced, battery not working
- Price inquiry: Cost questions, price, how much, kitna, EMI
- Offer inquiry: Discount, offer, deal, promotion, sale
- App related: App crash, login issue, app not working, mobile application
- Hub inquiry: Service center, showroom, location, address, hub
- Payment: Payment failed, transaction, payment method, UPI, card
- bike_inquiry: Bike related questions, bike features, How to rent Bike, How to upgrade Bike
- Others: Greetings, thanks, general questions not matching above

**Tag Assignment Logic** (STRICTLY follow):
- If category is "kyc", "app_related", "payment", or "others" → tag = "cs"
- If category is "price_inquiry", "hub_inquiry", or "offer_inquiry" or "Bike Inquiry" → tag = "bot"
- If category is "bike_not_moving" or "battery_problem" → tag = "escalated"

**Language Detection**:
- Look for Hindi/Indic script characters for language detection
- Hinglish (hi-en) is very common - mixed English and Hindi words
- Even if English script is used, check for Hindi words transliterated

Output ONLY valid JSON in this exact format:
{
  "messages": [
    {
      "language": "en",
      "category": "category_name",
      "tag": "cs",
      "confidence": 0.95
    }
  ]
}`;

/**
 * Rate limiter for OpenAI API calls
 * Implements token bucket algorithm to stay within rate limits
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second

  constructor(maxRequestsPerMinute = 500) {
    this.maxTokens = maxRequestsPerMinute;
    this.tokens = maxRequestsPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = maxRequestsPerMinute / 60; // per second
  }

  private refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000; // seconds
    const tokensToAdd = timePassed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async waitForToken() {
    this.refill();
    
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    // Wait until we have a token
    const waitTime = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise(resolve => setTimeout(resolve, waitTime));
    this.tokens = 0;
  }
}

export const rateLimiter = new RateLimiter(500); // 500 RPM default

/**
 * Analyze messages with OpenAI with retry logic
 */
export async function analyzeMessagesWithRetry(
  messages: Array<{ actor_type: string; message_parts: string }>,
  maxRetries = 3
): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await rateLimiter.waitForToken();

      const userPrompt = buildUserPrompt(messages);
      
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent classification
        response_format: { type: 'json_object' },
        max_tokens: 500,
      });

      const content = completion.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No content in OpenAI response');
      }

      const parsed = JSON.parse(content);
      return parsed;

    } catch (error: any) {
      lastError = error;
      
      // Handle rate limiting
      if (error?.status === 429) {
        const backoff = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
        console.warn(`[OpenAI] Rate limited, backing off ${backoff}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      // Handle server errors
      if (error?.status >= 500) {
        const backoff = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.warn(`[OpenAI] Server error, retrying in ${backoff}ms (attempt ${attempt}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        continue;
      }

      // Don't retry on client errors (400, 401, etc.)
      throw error;
    }
  }

  throw lastError || new Error('Analysis failed after retries');
}

function buildUserPrompt(messages: Array<{ actor_type: string; message_parts: string }>): string {
  const formatted = messages
    .map((m, i) => `${i + 1}. [${m.actor_type}]: ${m.message_parts}`)
    .join('\n');

  return `Analyze these messages from a customer support conversation:\n\n${formatted}\n\nProvide analysis for each message as a JSON object with a "messages" array.`;
}

