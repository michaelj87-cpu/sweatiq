// ============================================================
// SweatIQ AI Fitness Coach — Backend Server (Hardened)
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

// ─── STARTUP CHECKS ──────────────────────────────────────────
const REQUIRED_ENV = [
  'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_PRO_MONTHLY', 'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ELITE_MONTHLY', 'STRIPE_PRICE_ELITE_ANNUAL',
];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error('❌ Missing required environment variables:', missing.join(', '));
  process.exit(1);
}

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.set('trust proxy', 1);

// ─── CORS ────────────────────────────────────────────────────
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  }
}));

// ─── BODY PARSING ────────────────────────────────────────────
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' })); // Reject oversized payloads

// ─── SECURITY HEADERS ────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── RATE LIMITERS ───────────────────────────────────────────

// General: 30 req/min per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
});

// Chat: 20 messages/min per IP
const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Message limit reached. Please wait a moment.' }
});

// Checkout: max 5 attempts per 15 min per IP
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many checkout attempts. Please try again in 15 minutes.' }
});

app.use('/api/', apiLimiter);

// ─── INPUT SANITIZATION ──────────────────────────────────────
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  if (messages.length > 50) return null; // cap conversation length

  return messages.map(m => {
    if (!m || typeof m !== 'object') return null;
    const role = sanitizeString(m.role, 20);
    const content = sanitizeString(m.content, 4000);
    if (!['user', 'assistant'].includes(role)) return null;
    if (!content) return null;
    return { role, content };
  }).filter(Boolean);
}

// ─── SESSION STORE ───────────────────────────────────────────
const sessions = {};

function getSession(sessionId) {
  const id = sanitizeString(sessionId, 100) || 'anonymous';
  if (!sessions[id]) {
    sessions[id] = { plan: 'free', messageCount: 0, resetAt: Date.now() + 86400000 };
  }
  if (Date.now() > sessions[id].resetAt) {
    sessions[id].messageCount = 0;
    sessions[id].resetAt = Date.now() + 86400000;
  }
  return sessions[id];
}

// Prevent memory leaks — clean old sessions every hour
setInterval(() => {
  const now = Date.now();
  for (const id in sessions) {
    if (now > sessions[id].resetAt + 86400000) delete sessions[id];
  }
}, 3600000);

const FREE_DAILY_LIMIT = 10;

// ─── SYSTEM PROMPT ───────────────────────────────────────────
const SYSTEM_PROMPT = `You are SweatIQ, an elite AI fitness coach. You are knowledgeable, motivating, and highly practical.

- Use **bold** for key terms, exercise names, numbers, and important points
- Use ### headings to organize multi-section responses
- Use bullet points for exercises, meal plans, and tips
- Be specific: always give sets, reps, rest times, macros, and timings
- Be concise and actionable
- Workout format: **Exercise Name** — 3x10 @ 60s rest
- Ask clarifying questions when needed

You are SweatIQ. Never mention Claude or Anthropic.`;

// ─── CHAT ENDPOINT ───────────────────────────────────────────
app.post('/api/chat', chatLimiter, async (req, res) => {
  const { messages, sessionId } = req.body;

  const cleanMessages = sanitizeMessages(messages);
  if (!cleanMessages || cleanMessages.length === 0) {
    return res.status(400).json({ error: 'Invalid or missing messages.' });
  }

  if (cleanMessages[cleanMessages.length - 1].role !== 'user') {
    return res.status(400).json({ error: 'Last message must be from user.' });
  }

  const session = getSession(sessionId);

  if (session.plan === 'free' && session.messageCount >= FREE_DAILY_LIMIT) {
    return res.status(402).json({
      error: 'free_limit_reached',
      message: `You've used your ${FREE_DAILY_LIMIT} free messages today. Upgrade to Pro for unlimited access.`,
      upgradeUrl: '/sweatiq-pricing.html'
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
        messages: cleanMessages
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Anthropic error:', data?.error?.message || 'Unknown');
      return res.status(500).json({ error: 'AI service unavailable. Please try again.' });
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
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ─── STRIPE: CREATE CHECKOUT SESSION ─────────────────────────
app.post('/api/create-checkout', checkoutLimiter, async (req, res) => {
  const { plan, sessionId, billingCycle } = req.body;

  const cleanPlan = sanitizeString(plan, 20).toLowerCase();
  const cleanCycle = sanitizeString(billingCycle, 20).toLowerCase() || 'monthly';

  if (!['pro', 'elite'].includes(cleanPlan)) {
    return res.status(400).json({ error: 'Invalid plan.' });
  }
  if (!['monthly', 'annual'].includes(cleanCycle)) {
    return res.status(400).json({ error: 'Invalid billing cycle.' });
  }

  const PRICE_IDS = {
    pro_monthly:   process.env.STRIPE_PRICE_PRO_MONTHLY,
    pro_annual:    process.env.STRIPE_PRICE_PRO_ANNUAL,
    elite_monthly: process.env.STRIPE_PRICE_ELITE_MONTHLY,
    elite_annual:  process.env.STRIPE_PRICE_ELITE_ANNUAL,
  };

  const priceId = PRICE_IDS[`${cleanPlan}_${cleanCycle}`];
  if (!priceId) return res.status(400).json({ error: 'Plan configuration error.' });

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/sweatiq-chat.html?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/sweatiq-pricing.html`,
      metadata: { sessionId: sanitizeString(sessionId, 100) || 'unknown', plan: cleanPlan },
      subscription_data: { trial_period_days: 7 }
    });

    res.json({ url: checkoutSession.url });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ─── STRIPE: WEBHOOK ─────────────────────────────────────────
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
      console.log(`⬇️ Subscription cancelled: ${event.data.object.id}`);
      break;
    }
    default:
      break;
  }

  res.json({ received: true });
});

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ─── 404 & ERROR HANDLERS ────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════╗
  ║   SweatIQ Server running on :${PORT}   ║
  ╚═══════════════════════════════════╝

  Security:
    ✅ Rate limiting (30 req/min general)
    ✅ Chat limiter (20 msg/min)
    ✅ Checkout limiter (5 attempts/15min)
    ✅ Input sanitization & validation
    ✅ 50kb payload size limit
    ✅ Security headers on all responses
    ✅ Env variable validation on startup
    ✅ Session memory leak prevention
    ✅ No secrets in frontend or git

  Endpoints:
    POST /api/chat             → AI chat proxy
    POST /api/create-checkout  → Stripe checkout
    POST /webhook              → Stripe webhook
    GET  /health               → Health check
  `);
});
