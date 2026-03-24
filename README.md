# SweatIQ — AI Fitness Coach
### Complete sellable SaaS product

---

## 📁 Files Included

| File | What it is |
|------|-----------|
| `landing.html` | Marketing landing page |
| `pricing.html` | Pricing page with Stripe checkout UI |
| `fitness-ai.html` | The AI chat app |
| `server.js` | Node.js backend (API proxy + Stripe) |
| `.env.example` | Environment variable template |

---

## 🚀 Quick Start (Local)

### 1. Install dependencies
```bash
npm init -y
npm install express cors stripe dotenv express-rate-limit
```

### 2. Set up environment
```bash
cp .env.example .env
# Edit .env with your Anthropic API key and Stripe keys
```

### 3. Run the server
```bash
node server.js
# Server starts on http://localhost:3000
```

### 4. Open the app
Open `landing.html` in your browser — or serve all files via the same Express server.

---

## 💳 Setting Up Stripe

1. Create a free account at [stripe.com](https://stripe.com)
2. Go to **Products** → **Add Product**
3. Create 4 prices: Pro Monthly ($19), Pro Annual ($12/mo), Elite Monthly ($39), Elite Annual ($25/mo)
4. Copy the Price IDs into your `.env` file
5. Go to **Developers → Webhooks** → Add endpoint: `https://yourdomain.com/webhook`
6. Subscribe to: `checkout.session.completed` and `customer.subscription.deleted`
7. Copy the webhook signing secret into `.env`

---

## ☁️ Deploying to Production

### Option A: Vercel (easiest for frontend)
```bash
npm i -g vercel
vercel deploy
```

### Option B: Railway (for the Node.js server)
```bash
# Push to GitHub, then connect repo at railway.app
# Set environment variables in Railway dashboard
```

### Option C: Render
- Connect GitHub repo at render.com
- Set env vars in dashboard
- Deploy as a Web Service

---

## 🔑 Revenue Model

| Plan | Monthly | Annual (per mo) |
|------|---------|-----------------|
| Starter | Free | Free |
| Pro | $19/mo | $12/mo |
| Elite | $39/mo | $25/mo |

**Break-even math:**
- Anthropic API cost: ~$0.003 per message (claude-sonnet-4)
- At 100 messages/user/month = ~$0.30 cost per user
- Pro plan: $19 revenue − $0.30 cost = **$18.70 margin per user**
- At 100 Pro subscribers: **~$1,870/month profit**

---

## 🛠 Customization Checklist

- [ ] Replace `SweatIQ` branding with your own name
- [ ] Update pricing in `pricing.html` and `server.js`
- [ ] Add real Stripe Price IDs to `.env`
- [ ] Add your Anthropic API key to `.env`
- [ ] Connect a real database (PostgreSQL/Supabase) to persist user sessions
- [ ] Add user auth (Clerk, Supabase Auth, or Auth0)
- [ ] Set up email collection (Mailchimp, ConvertKit)
- [ ] Add Google Analytics / Plausible for tracking

---

## ⚠️ Important Notes

- This is a starter template. For a real business, add proper user authentication and a database.
- The in-memory session store in `server.js` resets when the server restarts. Use Redis or a database in production.
- SweatIQ is not a licensed fitness or medical professional. Add appropriate disclaimers.
- Comply with Stripe's terms of service and Anthropic's usage policies.
