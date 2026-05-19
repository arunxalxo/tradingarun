// tv_alert_forwarder.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '200kb' })); // TradingView payloads are small

// ---------- CONFIG (from .env) ----------
const PORT = Number(process.env.FORWARDER_PORT || 4000);
const BRIDGE_URL = process.env.BRIDGE_URL; // e.g. https://your-server/tv-webhook
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // secret used to HMAC the forwarded body
const BRIDGE_BASIC_AUTH = process.env.BRIDGE_BASIC_AUTH || ''; // optional "user:pass" base64 or empty
const FORWARDER_LOG = (process.env.FORWARDER_LOG || 'true') === 'true';
const MAX_RETRIES = Number(process.env.FORWARDER_MAX_RETRIES || 2);
const RETRY_DELAY_MS = Number(process.env.FORWARDER_RETRY_DELAY_MS || 1000);

// ---------- STARTUP CHECK ----------
if (!BRIDGE_URL) {
  console.error('Missing BRIDGE_URL in .env. Set BRIDGE_URL to your bridge webhook (e.g. https://host/tv-webhook)');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.warn('Warning: WEBHOOK_SECRET is empty. Forwarder will send empty signature header.');
}

// ---------- HELPERS ----------
function computeHmac(bodyString, secret) {
  return crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
}

async function forwardToBridge(bodyString, headers = {}) {
  const signature = computeHmac(bodyString, WEBHOOK_SECRET);
  const forwardHeaders = {
    'Content-Type': 'application/json',
    'x-webhook-signature': signature,
    ...headers
  };
  if (BRIDGE_BASIC_AUTH) forwardHeaders['Authorization'] = `Basic ${BRIDGE_BASIC_AUTH}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axios.post(BRIDGE_URL, bodyString, { headers: forwardHeaders, timeout: 10000 });
      return { ok: true, status: res.status, data: res.data };
    } catch (err) {
      const code = err.response ? err.response.status : err.code || 'ERR';
      const msg = err.response ? JSON.stringify(err.response.data) : err.message;
      if (FORWARDER_LOG) console.warn(`Forward attempt ${attempt + 1} failed: ${code} ${msg}`);
      if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      else return { ok: false, error: msg, code };
    }
  }
}

// ---------- ROUTES ----------
app.get('/', (req, res) => res.send('TradingView Alert Forwarder is running'));

app.post('/forward', async (req, res) => {
  try {
    // Accept raw JSON body; preserve exact string for HMAC
    const bodyObj = req.body;
    const bodyString = JSON.stringify(bodyObj);

    // Basic validation (non-blocking)
    if (!bodyObj || !bodyObj.action) {
      if (FORWARDER_LOG) console.log('Received webhook without action field; forwarding anyway.');
    }

    if (FORWARDER_LOG) console.log(`[${new Date().toISOString()}] Received alert: ${bodyString}`);

    // Optional: add metadata header (source, received timestamp)
    const extraHeaders = {
      'x-forwarder-received-at': new Date().toISOString(),
      'x-forwarder-source': 'tradingview'
    };

    const result = await forwardToBridge(bodyString, extraHeaders);

    if (!result.ok) {
      if (FORWARDER_LOG) console.error('Final forward failed:', result);
      return res.status(502).json({ status: 'error', detail: result });
    }

    if (FORWARDER_LOG) console.log('Forward successful:', result.status);
    return res.json({ status: 'forwarded', bridgeStatus: result.status, bridgeResponse: result.data });
  } catch (err) {
    console.error('Forwarder error:', err.message);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ---------- SIMPLE HEALTHCHECK ----------
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ---------- START SERVER ----------
app.listen(PORT, () => console.log(`Alert forwarder listening on port ${PORT}, forwarding to ${BRIDGE_URL}`));
