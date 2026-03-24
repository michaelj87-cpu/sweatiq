// ============================================================
// SweatIQ AI Fitness Coach — Backend Server
// ============================================================
// Stack: Node.js + Express
//
// What this does:
//   1. Proxies requests to Anthropic API (keeps your key secret)
//   2. Handles Stripe checkout + webhooks for subscriptions
//   3. Enforces message limits for free-tier users
//
// Setup:
//   1. npm install express cors stripe dotenv express-rate-limit
//   2. Copy .env.example to .env and fill in your keys
//   3. node server.js
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── In-memory session store (replace with Redis/DB in production) ───────────
const sessions = {}; // { sessionId: { plan: 'free'|'pro'|'elite', messageCount: N, resetAt: timestamp } }

function getSession(sessionId) {
  if (!sessions[sessionId]) {
    sessions[sessionId] = {
      plan: 'free',
      messageCount: 0,
      resetAt: Date.now() + 24 * 60 * 60 * 1000 // reset daily
    };
  }
  // Reset daily counter
  if (Date.now() > sessions[sessionId].resetAt) {
    sessions[sessionId].messageCount = 0;
    sessions[sessionId].resetAt = Date.now() + 24 * 60 * 60 * 1000;
  }
  return sessions[sessionId];
}

const FREE_DAILY_LIMIT = 10;

// ─── Rate limiter ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,             // 30 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});
app.use('/api/', limiter);

// ─── SweatIQ System Prompt ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are SweatIQ, an elite AI fitness coach. You are knowledgeable, motivating, and highly practical.

Personality:
- Energetic and direct, like a world-class personal trainer
- Use **bold** for key terms, exercise names, numbers, and important points
- Use ### headings to organize multi-section responses
- Use bullet points for exercises, meal plans, and tips
- Be specific: always give sets, reps, rest times, macros, and timings
- Occasionally use brief motivational phrases — keep them punchy, not cheesy
- Be concise and actionable

Format workouts like:
- **Exercise Name** — 3x10 @ 60s rest

Ask clarifying questions when needed (fitness level, equipment, goals, dietary restrictions).
You are SweatIQ. Never mention Claude or Anthropic.`;

// ─── CHAT ENDPOINT ────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, sessionId } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const session = getSession(sessionId || 'anonymous');

  // Enforce free tier limit
  if (session.plan === 'free' && session.messageCount >= FREE_DAILY_LIMIT) {
    return res.status(402).json({
      error: 'free_limit_reached',
      message: `You've used your ${FREE_DAILY_LIMIT} free messages for today. Upgrade to Pro for unlimited access.`,
      upgradeUrl: '/pricing.html'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data);
      return res.status(500).json({ error: 'AI service error. Please try again.' });
    }

    session.messageCount++;

    const reply = data.content?.map(b => b.text || '').join('') || '';
    res.json({
      reply,
      usage: {
        plan: session.plan,
        messagesUsedToday: session.messageCount,
        dailyLimit: session.plan === 'free' ? FREE_DAILY_LIMIT : null
      }
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─── STRIPE: CREATE CHECKOUT SESSION ─────────────────────────────────────────
app.post('/api/create-checkout', async (req, res) => {
  const { plan, sessionId, billingCycle } = req.body; // plan: 'pro' | 'elite', billingCycle: 'monthly' | 'annual'

  // Map your Stripe Price IDs here — create these in your Stripe Dashboard
  const PRICE_IDS = {
    pro_monthly:    process.env.STRIPE_PRICE_PRO_MONTHLY,
    pro_annual:     process.env.STRIPE_PRICE_PRO_ANNUAL,
    elite_monthly:  process.env.STRIPE_PRICE_ELITE_MONTHLY,
    elite_annual:   process.env.STRIPE_PRICE_ELITE_ANNUAL,
  };

  const priceKey = `${plan}_${billingCycle || 'monthly'}`;
  const priceId = PRICE_IDS[priceKey];

  if (!priceId) {
    return res.status(400).json({ error: 'Invalid plan or billing cycle' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/fitness-ai.html?session_id={CHECKOUT_SESSION_ID}&upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing.html`,
      metadata: { sessionId: sessionId || 'unknown', plan },
      subscription_data: {
        trial_period_days: 7 // 7-day free trial
      }
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ─── STRIPE: WEBHOOK ─────────────────────────────────────────────────────────
// In production, point your Stripe webhook to POST /webhook
// Events to subscribe to: checkout.session.completed, customer.subscription.deleted
app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      const { sessionId, plan } = session.metadata || {};
      if (sessionId && sessions[sessionId]) {
        sessions[sessionId].plan = plan || 'pro';
        console.log(`✅ Upgraded session ${sessionId} to ${plan}`);
      }
      break;
    }
    case 'customer.subscription.deleted': {
      // Downgrade user back to free
      const sub = event.data.object;
      console.log(`⬇️ Subscription cancelled: ${sub.id}`);
      // In production, look up user by customer ID in your DB and downgrade
      break;
    }
    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   SweatIQ Server running on :${PORT}   ║
  ╚═══════════════════════════════════╝
  
  Endpoints:
    POST /api/chat             → AI chat proxy
    POST /api/create-checkout  → Stripe checkout
    POST /webhook              → Stripe webhook
    GET  /health               → Health check
  `);
});
