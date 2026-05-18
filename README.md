# Upstox ATM Bridge (TradingView → Upstox)

This server receives TradingView webhook alerts, computes ATM CE/PE, resolves the correct Upstox instrument token, and places orders via the Upstox API.

## 🚀 Deployment (Railway)

1. Push this repo to GitHub  
2. Go to https://railway.app  
3. Create New Project → Deploy from GitHub  
4. Add Environment Variables:

5. Railway gives you a public HTTPS URL:
https://your-app.up.railway.app/tv-webhook

6. Use this URL in TradingView alerts.

## 📌 TradingView Alert JSON

{
"action": "{{strategy.order.action}}",
"qty": 150,
"signalId": "ATM-Engine",
"timestamp": "{{timenow}}"
}

## ✔ Done
Your Upstox ATM automation is live.
