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

// Tipo de cambio operativo
const USD_TO_MXN = 20;

// Stock fijo
const FIXED_STOCK = 11;

// Peso estable
const DEFAULT_WEIGHT_VALUE = 1;
const DEFAULT_WEIGHT_UNIT = "kg";

// Shopify API versions
const PRODUCT_API_VERSION = "2024-01";
const FULFILLMENT_API_VERSION = "2026-01";

// Rate limit control (Shopify 2rps aprox por app/tienda; 650ms es seguro)
const SHOPIFY_MIN_INTERVAL_MS = 650;

// Retry control
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 800;

// Espera post-create para que Shopify termine de materializar variantes/inventory_item_id
const PRODUCT_CREATE_WARMUP_MS = 1800;

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
   COLA EN MEMORIA (por shop)
========================== */

const shopQueues = new Map(); // shop -> {queue:[], processing:false, lastReqAt:0}

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
      log("QUEUE: start", { shop, jobName: item.jobName, jobId: item.jobId, remaining: q.queue.length });

      try {
        await item.fn();
        log("QUEUE: done", { shop, jobName: item.jobName, jobId: item.jobId });
      } catch (err) {
        console.error("QUEUE: job failed", {
          shop,
          jobName: item.jobName,
          jobId: item.jobId,
          error: err.response?.data || err.message
        });
      }
    }
  } finally {
    q.processing = false;
  }
}

/* ==========================
   THROTTLE + RETRY SHOPIFY
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
  return Math.max(0, seconds * 1000);
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
    log("Shopify retry", { shop, status, attempt: attempt + 1, wait_ms: backoff });

    await sleep(backoff);
    return shopifyRequest(shop, config, attempt + 1);
  }
}

/* ==========================
   PRICING - BLINDAJE MEDIO (equilibrado)
========================== */

function calculatePrice(usdRaw) {
  const usd = Number(usdRaw);
  let adjustedUsd = Number.isFinite(usd) ? usd : 0;

  // Ajuste proveedor equilibrado (promedio del rango observado)
  if (adjustedUsd <= 20) {
    adjustedUsd += 25;
  } else if (adjustedUsd <= 30) {
    adjustedUsd += 30;
  } else {
    adjustedUsd += 42;
  }

  // Conversión
  let mxn = adjustedUsd * USD_TO_MXN;

  // Fee operativo equilibrado
  mxn += 350;

  // Margen comercial equilibrado
  mxn *= 1.22;

  return Math.ceil(mxn);
}

/* ==========================
   CATEGORÍA SIMPLE
========================== */

function detectCategory(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("bag") || t.includes("bolsa")) return "BOLSOS";
  if (t.includes("massage") || t.includes("masaje")) return "TERAPIA";
  if (t.includes("led")) return "ILUMINACION";
  if (t.includes("chair")) return "HOGAR";
  return "GENERAL";
}

/* ==========================
   TRADUCCIÓN + SEO CONTROLADO
========================== */

async function translateText(text) {
  if (!text || !text.trim()) return text;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: `
Traduce al español de México.
Optimiza ligeramente para SEO sin exagerar.
No agregues más de 1 palabra estratégica.
No cambies el significado original.
No uses adjetivos vacíos como "increíble", "mejor", "premium".
Mantén máximo 65 caracteres si es posible.
Devuelve solo el texto final.
`
          },
          { role: "user", content: text }
        ]
      },
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );

    return response.data.choices?.[0]?.message?.content?.trim() ?? text;
  } catch (err) {
    log("Traducción omitida", err.response?.data || err.message);
    return text;
  }
}

async function translateHtmlPreservingTags(html) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const textNodes = [];

  function walk(node) {
    if (!node) return;
    if (node.type === "text") {
      const raw = node.data;
      if (raw && raw.trim()) textNodes.push(node);
    }
    if (node.children) node.children.forEach(walk);
  }

  walk($.root()[0]);

  for (const node of textNodes) {
    node.data = await translateText(node.data);
  }

  return $.root().html();
}

/* ==========================
   TOKENS
========================== */

async function getToken(shop) {
  const result = await pool.query("SELECT access_token FROM shop_tokens WHERE shop = $1", [shop]);
  if (!result.rows.length) throw new Error("Token not found");
  return result.rows[0].access_token;
}

/* ==========================
   TRACKING HELPERS
========================== */

function pickTrackingNumberFromPayload(payload) {
  if (payload?.tracking_info?.number) return String(payload.tracking_info.number).trim();
  if (payload?.tracking_number) return String(payload.tracking_number).trim();
  if (Array.isArray(payload?.tracking_numbers) && payload.tracking_numbers.length)
    return String(payload.tracking_numbers[0]).trim();
  return null;
}

function detectAftershipCarrierSlug(trackingNumber, trackingCompanyRaw) {
  const tn = String(trackingNumber || "").trim();
  const tc = String(trackingCompanyRaw || "").toLowerCase();

  if (tc.includes("360lion")) return "360lion";
  if (tc.includes("ups") || tn.startsWith("1Z")) return "ups";
  if (tc.includes("fedex")) return "fedex";
  if (tc.includes("dhl")) return "dhl";
  if (tn.startsWith("JM")) return "360lion";

  return "other";
}

function buildAftershipUrl(carrierSlug, trackingNumber) {
  return `https://www.aftership.com/track/${carrierSlug}/${trackingNumber}`;
}

async function updateTrackingOnFulfillment(shop, accessToken, fulfillmentId, carrierSlug, trackingNumber, trackingUrl) {
  const payload = {
    fulfillment: {
      notify_customer: false,
      tracking_info: {
        company: carrierSlug,
        number: trackingNumber,
        url: trackingUrl
      }
    }
  };

  await shopifyRequest(shop, {
    method: "POST",
    url: `https://${shop}/admin/api/${FULFILLMENT_API_VERSION}/fulfillments/${fulfillmentId}/update_tracking.json`,
    headers: { "X-Shopify-Access-Token": accessToken },
    data: payload
  });
}

/* ==========================
   CORE: TRANSFORM PRODUCT
========================== */

async function transformProductById(shop, accessToken, productId) {
  await sleep(PRODUCT_CREATE_WARMUP_MS);

  const freshProduct = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const realProduct = freshProduct.data.product;
  const realVariants = realProduct.variants || [];

  const translatedTitle = await translateText(realProduct.title);
  const translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);
  const detectedCat = detectCategory(realProduct.title);

  // Update producto
  await shopifyRequest(shop, {
    method: "PUT",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken },
    data: {
      product: {
        id: productId,
        title: translatedTitle,
        body_html: translatedHtml,
        vendor: "friDker Internacional",
        product_type: detectedCat,
        tags: detectedCat,
        status: "active"
      }
    }
  });

  // Update variantes (precio + peso)
  for (const variant of realVariants) {
    const usd = parseFloat(variant.price);
    const mxnPrice = calculatePrice(Number.isFinite(usd) ? usd : 0);

    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/variants/${variant.id}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: {
        variant: {
          id: variant.id,
          price: String(mxnPrice),
          sku: variant.sku,
          weight: DEFAULT_WEIGHT_VALUE,
          weight_unit: DEFAULT_WEIGHT_UNIT
        }
      }
    });
  }

  // Location
  const locations = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/locations.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const locationId = locations.data?.locations?.[0]?.id;
  if (!locationId) throw new Error("No locations found to set inventory");

  // Inventory set
  for (const variant of realVariants) {
    await shopifyRequest(shop, {
      method: "POST",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/inventory_levels/set.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: {
        location_id: locationId,
        inventory_item_id: variant.inventory_item_id,
        available: FIXED_STOCK
      }
    });
  }

  log("Producto transformado correctamente (SEO leve + pricing)", {
    shop,
    productId,
    variants: realVariants.length
  });
}

/* ==========================
   WEBHOOK: PRODUCTS CREATE
========================== */

app.post("/webhook/products-create", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  if (!shop) return;

  const productId = req.body?.id;
  if (!productId) return;

  enqueueShopJob(shop, "products-create", async () => {
    const accessToken = await getToken(shop);
    await transformProductById(shop, accessToken, productId);
  });
});

/* ==========================
   WEBHOOK: FULFILLMENT TRACKING
========================== */

app.post("/webhook/fulfillment", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  const topic = req.headers["x-shopify-topic"];
  if (!shop) return;

  const payload = req.body || {};
  const trackingNumber = pickTrackingNumberFromPayload(payload);
  if (!trackingNumber) return;

  enqueueShopJob(shop, "fulfillment-tracking", async () => {
    const accessToken = await getToken(shop);

    const carrierSlug = detectAftershipCarrierSlug(trackingNumber, payload?.tracking_company);
    const trackingUrl = buildAftershipUrl(carrierSlug, trackingNumber);

    if (payload?.id && String(topic).startsWith("fulfillments/")) {
      await updateTrackingOnFulfillment(shop, accessToken, payload.id, carrierSlug, trackingNumber, trackingUrl);
      log("Tracking actualizado", { shop, fulfillmentId: payload.id, trackingUrl });
    }
  });
});

/* ==========================
   RECONCILIACIÓN (manual)
========================== */

app.post("/reconcile", async (req, res) => {
  try {
    const { shop, product_ids } = req.body || {};
    if (!shop || !Array.isArray(product_ids) || product_ids.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop: 'xxx.myshopify.com', product_ids: [123,456] }"
      });
    }

    product_ids.forEach(pid => {
      enqueueShopJob(shop, "reconcile-product", async () => {
        const accessToken = await getToken(shop);
        await transformProductById(shop, accessToken, pid);
      });
    });

    return res.json({ ok: true, queued: product_ids.length });
  } catch (err) {
    console.error("reconcile error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   HEALTH
========================== */

app.get("/", (req, res) => {
  res.send("Transformer running 🚀");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: nowIso(), shopsInMemory: shopQueues.size });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
