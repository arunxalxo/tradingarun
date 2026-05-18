// upstox_orb_vstop_bridge_dryrun.js
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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

const DEFAULT_PRODUCT = "I";
const DEFAULT_VARIETY = "regular";
const FIXED_QTY = Number(process.env.FIXED_QTY || 260);
const MAX_TRADES = Number(process.env.MAX_TRADES || 3);
const DRY_RUN = String(process.env.DRY_RUN || "false").toLowerCase() === "true";

// ---------------- STARTUP CHECK ----------------
const missing = [];
if (!UPSTOX_ACCESS_TOKEN && !DRY_RUN) missing.push("UPSTOX_ACCESS_TOKEN");
if (!TELEGRAM_BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) missing.push("TELEGRAM_CHAT_ID");
if (missing.length) {
  console.warn("Missing environment variables (some may be optional in dry-run):", missing.join(", "));
}

// ---------------- STATE ----------------
let openPosition = null;
let tradesToday = 0;
let lastDay = (new Date()).getDate();

// ---------------- NOTIFIER ----------------
async function notify(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[NOTIFY]", msg);
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: "Markdown" }
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
  const { action, signalId, timestamp, trend, symbol, volatility } = body;
  if (!["BUY", "SELL", "SQUAREOFF"].includes(action)) throw new Error("Invalid action");
  if (!signalId) throw new Error("Missing signalId");
  if (!timestamp) throw new Error("Missing timestamp");
  if (!symbol) throw new Error("Missing symbol");
  return { action, signalId, timestamp, trend, symbol, volatility };
}

function applyBusinessRules(p) {
  const now = new Date();
  if (now.getDate() !== lastDay) {
    tradesToday = 0;
    lastDay = now.getDate();
  }
  const ts = Date.parse(p.timestamp);
  if (Number.isFinite(ts) && Date.now() - ts > 60000) throw new Error("Stale signal");
  const m = now.getHours() * 60 + now.getMinutes();
  if (m < 555 || m > 925) throw new Error("Outside trading window");
  return p;
}

// ---------------- UPSTOX HELPERS ----------------
async function getNiftyLTP() {
  if (DRY_RUN) return 22350;
  const url = `${UPSTOX_BASE_URL}/market-quote/ltp?instrument_key=NSE_INDEX|Nifty 50`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
  return res.data.data["NSE_INDEX|Nifty 50"].last_price;
}

async function getInstrumentToken(symbol) {
  if (DRY_RUN) return `DRY_TOKEN_${symbol}`;
  const url = `${UPSTOX_BASE_URL}/market-quote/ltp?symbol=${encodeURIComponent(symbol)}`;
  const res = await axios.get(url, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
  const key = Object.keys(res.data.data)[0];
  if (!key) throw new Error(`Symbol not found: ${symbol}`);
  return res.data.data[key].instrument_token;
}

async function placeOrder({ action, qty, instrumentToken }) {
  if (DRY_RUN) {
    const simulated = {
      status: "DRY_RUN",
      data: {
        order_id: `DRY_${Date.now()}`,
        instrument_token: instrumentToken,
        transaction_type: action,
        quantity: qty,
        average_price: null
      }
    };
    console.log("[DRY_RUN] Simulated placeOrder:", simulated);
    return simulated;
  }
  const payload = {
    transaction_type: action,
    quantity: qty,
    product: DEFAULT_PRODUCT,
    order_type: "MARKET",
    instrument_token: instrumentToken,
    variety: DEFAULT_VARIETY,
  };
  const res = await axios.post(`${UPSTOX_BASE_URL}/order/place`, payload, {
    headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}`, "Content-Type": "application/json" },
  });
  return res.data;
}

// ---------------- SQUARE-OFF ----------------
async function squareOffAllPositions() {
  try {
    if (DRY_RUN) {
      console.log("[DRY_RUN] squareOffAllPositions called. Would close all NIFTY positions.");
      openPosition = null;
      tradesToday = 0;
      await notify("🔁 [DRY_RUN] Auto Square-off simulated: all NIFTY positions would be closed.");
      return;
    }
    const pos = await axios.get(`${UPSTOX_BASE_URL}/portfolio/positions`, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
    const positions = pos.data.data || [];
    for (const p of positions) {
      if (!p.trading_symbol || !p.trading_symbol.includes("NIFTY")) continue;
      if (!p.net_qty || p.net_qty === 0) continue;
      const exitAction = p.net_qty > 0 ? "SELL" : "BUY";
      await placeOrder({ action: exitAction, qty: Math.abs(p.net_qty), instrumentToken: p.instrument_token });
    }
    openPosition = null;
    tradesToday = 0;
    await notify("🔁 Auto Square-off executed: all NIFTY positions closed.");
  } catch (err) {
    console.error("Square-off error:", err.message);
    await notify(`❌ Square-off error: ${err.message}`);
  }
}

// ---------------- HMAC VERIFY ----------------
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
    const key = `${base.signalId}:${base.action}:${base.timestamp}:${base.symbol}`;
    if (isDuplicate(key)) return res.status(200).send("Duplicate ignored");
    const payload = applyBusinessRules(base);

    if (payload.action === "SQUAREOFF") {
      await squareOffAllPositions();
      return res.json({ status: "ok", message: DRY_RUN ? "Square-off simulated" : "Square-off completed" });
    }

    if (openPosition) throw new Error("Rejected: Position already open (Re-entry blocked)");
    if (tradesToday >= MAX_TRADES) throw new Error("Rejected: Max trades for the day reached");

    if (payload.action === "BUY" && payload.trend && payload.trend !== "BULL") throw new Error("Rejected: Not in bullish trend");
    if (payload.action === "SELL" && payload.trend && payload.trend !== "BEAR") throw new Error("Rejected: Not in bearish trend");

    if (payload.volatility) {
      if (payload.action === "BUY" && payload.volatility !== "UPTREND") throw new Error("Rejected: Volatility Stop not in uptrend");
      if (payload.action === "SELL" && payload.volatility !== "DOWNTREND") throw new Error("Rejected: Volatility Stop not in downtrend");
    }

    const spot = await getNiftyLTP();
    const atm = Math.round(spot / 50) * 50;
    const expiry = getNearestWeeklyExpiry();
    const optionType = payload.action === "BUY" ? "CE" : "PE";
    const symbol = `NIFTY${expiry}${atm}${optionType}`;

    const token = await getInstrumentToken(symbol);
    const orderRes = await placeOrder({ action: "BUY", qty: FIXED_QTY, instrumentToken: token });

    let entryPrice = 0;
    if (DRY_RUN) {
      try {
        const ltpRes = await axios.get(`${UPSTOX_BASE_URL}/market-quote/ltp?symbol=${encodeURIComponent(symbol)}`, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
        const key2 = Object.keys(ltpRes.data.data)[0];
        entryPrice = ltpRes.data.data[key2].last_price || 0;
      } catch (e) {
        entryPrice = 100;
      }
    } else {
      if (orderRes && orderRes.data && orderRes.data.average_price) entryPrice = orderRes.data.average_price;
      else {
        const ltpRes = await axios.get(`${UPSTOX_BASE_URL}/market-quote/ltp?symbol=${encodeURIComponent(symbol)}`, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
        const key2 = Object.keys(ltpRes.data.data)[0];
        entryPrice = ltpRes.data.data[key2].last_price;
      }
    }

    openPosition = {
      symbol,
      instrumentToken: token,
      qty: FIXED_QTY,
      entryPrice,
      slPrice: entryPrice * 0.90,
      tpPrice: entryPrice * 1.10,
    };

    tradesToday++;
    const msg = `${DRY_RUN ? "✅ [DRY_RUN] Simulated entry" : "✅ Entered"} ${payload.action} → ${symbol} x ${FIXED_QTY}\nEntry: ${entryPrice}\nSL: ${openPosition.slPrice}\nTP: ${openPosition.tpPrice}`;
    console.log(msg);
    await notify(msg);

    res.json({ status: "ok", symbol, entryPrice, sl: openPosition.slPrice, tp: openPosition.tpPrice, dryRun: DRY_RUN });
  } catch (err) {
    console.error("Error:", err.message);
    await notify(`❌ Error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// ---------------- UTILS ----------------
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

// ---------------- SL/TP MONITOR (every second) ----------------
setInterval(async () => {
  if (!openPosition) return;
  try {
    let ltp = null;
    try {
      if (DRY_RUN && !UPSTOX_ACCESS_TOKEN) {
        const drift = (Math.random() - 0.5) * (openPosition.entryPrice * 0.02);
        ltp = openPosition.entryPrice + drift;
      } else {
        const url = `${UPSTOX_BASE_URL}/market-quote/ltp?symbol=${encodeURIComponent(openPosition.symbol)}`;
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${UPSTOX_ACCESS_TOKEN}` } });
        const key = Object.keys(res.data.data)[0];
        ltp = res.data.data[key].last_price;
      }
    } catch (e) {
      console.warn("Could not fetch option LTP for SL/TP monitor:", e.message);
      ltp = openPosition.entryPrice;
    }

    if (ltp <= openPosition.slPrice) {
      if (DRY_RUN) {
        console.log(`[DRY_RUN] SL Hit simulated for ${openPosition.symbol} at ${ltp}`);
        await notify(`[DRY_RUN] SL Hit simulated → Exited ${openPosition.symbol} at ${ltp}`);
      } else {
        await placeOrder({ action: "SELL", qty: openPosition.qty, instrumentToken: openPosition.instrumentToken });
        await notify(`❌ SL Hit → Exited ${openPosition.symbol} at ${ltp}`);
      }
      openPosition = null;
      return;
    }

    if (ltp >= openPosition.tpPrice) {
      if (DRY_RUN) {
        console.log(`[DRY_RUN] TP Hit simulated for ${openPosition.symbol} at ${ltp}`);
        await notify(`[DRY_RUN] TP Hit simulated → Exited ${openPosition.symbol} at ${ltp}`);
      } else {
        await placeOrder({ action: "SELL", qty: openPosition.qty, instrumentToken: openPosition.instrumentToken });
        await notify(`🎯 TP Hit → Exited ${openPosition.symbol} at ${ltp}`);
      }
      openPosition = null;
      return;
    }
  } catch (err) {
    console.error("SL/TP monitor error:", err.message);
  }
}, 1000);

// ---------------- SERVER ----------------
app.listen(PORT, () => console.log(`ORB VStop Bridge running on ${PORT} (DRY_RUN=${DRY_RUN})`));
