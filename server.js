require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cheerio = require("cheerio");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;

const { DATABASE_URL, OPENAI_API_KEY } = process.env;

/* ==========================
   CONFIG NEGOCIO
========================== */

// Tipo de cambio operativo blindado
const USD_TO_MXN = 20;

// Stock fijo
const FIXED_STOCK = 11;

// Peso estable
const DEFAULT_WEIGHT_VALUE = 1;
const DEFAULT_WEIGHT_UNIT = "kg";

// Shopify API versions
const PRODUCT_API_VERSION = "2024-01";
const FULFILLMENT_API_VERSION = "2026-01";

// Rate limit
const SHOPIFY_MIN_INTERVAL_MS = 650;

// Retry
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 800;

/* ==========================
   PostgreSQL
========================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL
    );
  `);
  console.log("shop_tokens table ready");
}

/* ==========================
   LOGS
========================== */

function nowIso() {
  return new Date().toISOString();
}

function log(tag, obj) {
  console.log(`[${nowIso()}] ${tag}`, obj ?? "");
}

/* ==========================
   COLA EN MEMORIA
========================== */

const shopQueues = new Map();

function getShopQueue(shop) {
  if (!shopQueues.has(shop)) {
    shopQueues.set(shop, { queue: [], processing: false, lastReqAt: 0 });
  }
  return shopQueues.get(shop);
}

function enqueueShopJob(shop, jobName, fn) {
  const q = getShopQueue(shop);
  const jobId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  q.queue.push({ jobId, jobName, fn });
  log("QUEUE: enqueued", { shop, jobName, jobId, depth: q.queue.length });

  processShopQueue(shop).catch(err => {
    console.error("QUEUE processor error:", err.message);
  });

  return jobId;
}

async function processShopQueue(shop) {
  const q = getShopQueue(shop);
  if (q.processing) return;

  q.processing = true;
  try {
    while (q.queue.length > 0) {
      const item = q.queue.shift();
      log("QUEUE: start", { shop, jobName: item.jobName, remaining: q.queue.length });

      try {
        await item.fn();
        log("QUEUE: done", { shop, jobName: item.jobName });
      } catch (err) {
        console.error("QUEUE: job failed", err.response?.data || err.message);
      }
    }
  } finally {
    q.processing = false;
  }
}

/* ==========================
   THROTTLE + RETRY
========================== */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function throttleShopify(shop) {
  const q = getShopQueue(shop);
  const elapsed = Date.now() - q.lastReqAt;
  const wait = Math.max(0, SHOPIFY_MIN_INTERVAL_MS - elapsed);
  if (wait > 0) await sleep(wait);
  q.lastReqAt = Date.now();
}

function getRetryAfterMs(error) {
  const ra = error?.response?.headers?.["retry-after"];
  if (!ra) return null;
  const seconds = Number(ra);
  if (!Number.isFinite(seconds)) return null;
  return seconds * 1000;
}

async function shopifyRequest(shop, config, attempt = 0) {
  await throttleShopify(shop);

  try {
    return await axios(config);
  } catch (err) {
    const status = err?.response?.status;
    const retriable = status === 429 || (status >= 500 && status <= 599);

    if (!retriable || attempt >= MAX_RETRIES) throw err;

    const retryAfter = getRetryAfterMs(err);
    const backoff = retryAfter ?? (BASE_BACKOFF_MS * Math.pow(2, attempt));

    log("Retrying Shopify request", { attempt: attempt + 1, wait: backoff });

    await sleep(backoff);
    return shopifyRequest(shop, config, attempt + 1);
  }
}

/* ==========================
   NUEVO MODELO DE PRICING
========================== */

function calculatePrice(usd) {

  // 🔹 Ajuste proveedor equilibrado (promedio del rango observado)
  let adjustedUsd = usd;

  if (usd <= 20) {
    adjustedUsd += 25;
  } else if (usd <= 30) {
    adjustedUsd += 30;
  } else {
    adjustedUsd += 42;
  }

  // 🔹 Conversión
  let mxn = adjustedUsd * USD_TO_MXN;

  // 🔹 Fee operativo equilibrado
  mxn += 350;

  // 🔹 Margen comercial equilibrado
  mxn *= 1.22;

  return Math.ceil(mxn);
}

/* ==========================
   RESTO DEL CÓDIGO
   (NO MODIFICADO)
========================== */

/* ---- El resto de tu server permanece exactamente igual ---- */
/* No lo repito aquí por brevedad en explicación,
   pero en tu implementación mantén:
   - translateText
   - translateHtmlPreservingTags
   - getToken
   - tracking helpers
   - transformProductById
   - webhooks
   - reconcile
   - health
*/

app.get("/", (req, res) => {
  res.send("Transformer running 🚀");
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
