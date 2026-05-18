// upstox_atm_bridge.js
// One-file TradingView → ATM CE/PE → Upstox order bridge

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const UPSTOX_BASE_URL = "https://api.upstox.com/v2";
const UPSTOX_ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN;
const DEFAULT_PRODUCT = "I";
const DEFAULT_VARIETY = "regular";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// ---------------- NOTIFIER ----------------
async function notify(msg) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: "Markdown",
      }
    );
  } catch (e) {
    console.error("Notifier error:", e.message);
  }
}

// ---------------- IDEMPOTENCY ----------------
const seen = new Map();
const TTL = 5 * 60 * 1000;

function isDuplicate(key) {
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev < TTL) return true;
  seen.set(key, now);
  return false;
}

// ---------------- VALIDATION ----------------
function validatePayload(body) {
  if (!body) throw new Error("Empty payload");

  const { action, qty, signalId, timestamp } = body;

  if (!["BUY", "SELL"].includes(action)) throw new Error("Invalid action");
  if (!Number.isInteger(qty) || qty <= 0) throw new Error("Invalid qty");
  if (!signalId) throw new Error("Missing signalId");
  if (!timestamp) throw new Error("Missing timestamp");

  return { action, qty, signalId, timestamp };
}

function applyBusinessRules(p) {
  const now = Date.now();
  const ts = Date.parse(p.timestamp);
  if (Number.isFinite(ts) && now - ts > 60000)
    throw new Error("Stale signal");

  const d = new Date();
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < 555 || m > 925) throw new Error("Outside trading window");

  return p;
}

// ---------------- UPSTOX HELPERS ----------------
async function getNiftyLTP() {
  const url = `${UPSTOX_BASE_URL}/market-quote/ltp?instrument_key=NSE_INDEX|Nifty 50`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` },
  });
  return res.data.data["NSE_INDEX|Nifty 50"].last_price;
}

async function getInstrumentToken(symbol) {
  const url = `${UPSTOX_BASE_URL}/market-quote/ltp?symbol=${encodeURIComponent(symbol)}`;
  const res = await axios.get(url, {
    headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` },
  });
  const key = Object.keys(res.data.data)[0];
  if (!key) throw new Error(`Symbol not found: ${symbol}`);
  return res.data.data[key].instrument_token;
}

async function placeOrder({ action, qty, instrumentToken }) {
  const payload = {
    transaction_type: action,
    quantity: qty,
    product: DEFAULT_PRODUCT,
    order_type: "MARKET",
    instrument_token: instrumentToken,
    variety: DEFAULT_VARIETY,
  };

  const res = await axios.post(
    `${UPSTOX_BASE_URL}/order/place`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data;
}

// ---------------- EXPIRY ----------------
function getNearestWeeklyExpiry() {
  const today = new Date();
  const day = today.getDay();
  const diff = day <= 4 ? 4 - day : 11 - day;

  const expiry = new Date(today);
  expiry.setDate(today.getDate() + diff);

  const dd = String(expiry.getDate()).padStart(2, "0");
  const mon = expiry.toLocaleString("en-US", { month: "short" }).toUpperCase();

  return `${dd}${mon}`;
}

// ---------------- HMAC ----------------
function verifySignature(req) {
  if (!WEBHOOK_SECRET) return true;
  const sig = req.headers["x-webhook-signature"];
  if (!sig) return false;

  const body = JSON.stringify(req.body);
  const hmac = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac));
}

// ---------------- MAIN HANDLER ----------------
app.post("/tv-webhook", async (req, res) => {
  try {
    if (!verifySignature(req)) return res.status(401).send("Invalid signature");

    const base = validatePayload(req.body);

    const key = `${base.signalId}:${base.action}:${base.timestamp}`;
    if (isDuplicate(key)) return res.status(200).send("Duplicate ignored");

    const payload = applyBusinessRules(base);

    const spot = await getNiftyLTP();
    const atm = Math.round(spot / 50) * 50;

    const optionType = payload.action === "BUY" ? "CE" : "PE";
    const expiry = getNearestWeeklyExpiry();
    const symbol = `NIFTY${expiry}${atm}${optionType}`;

    const token = await getInstrumentToken(symbol);

    const result = await placeOrder({
      action: payload.action,
      qty: payload.qty,
      instrumentToken: token,
    });

    notify(`ATM Order → ${symbol}\n${JSON.stringify(result)}`);
    res.json({ status: "ok", symbol, result });

  } catch (err) {
    notify(`Error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---------------- SERVER ----------------
app.listen(PORT, () => console.log(`ATM Bridge running on ${PORT}`));
