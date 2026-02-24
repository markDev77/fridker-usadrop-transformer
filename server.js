require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const { DATABASE_URL, OPENAI_API_KEY } = process.env;

/* ==========================
   CONFIG NEGOCIO
========================== */

const USD_TO_MXN = 20;
const BASE_FEE = 200;
const MARGIN_1 = 1.15;
const MARGIN_2 = 1.20;
const FIXED_STOCK = 11;

// Peso estable
const DEFAULT_WEIGHT_VALUE = 1;
const DEFAULT_WEIGHT_UNIT = "kg";

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
   UTILIDADES
========================== */

function nowIso() {
  return new Date().toISOString();
}

function log(tag, obj) {
  console.log(`[${nowIso()}] ${tag}`, obj ?? "");
}

function calculatePrice(usd) {
  let mxn = usd * USD_TO_MXN;
  mxn += BASE_FEE;
  mxn *= MARGIN_1;
  mxn *= MARGIN_2;
  return Math.ceil(mxn);
}

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
Devuelve solo el título final.
`
          },
          { role: "user", content: text }
        ]
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    log("Traducción omitida:", err.response?.data || err.message);
    return text;
  }
}

async function translateHtmlPreservingTags(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
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

async function getToken(shop) {
  const result = await pool.query(
    "SELECT access_token FROM shop_tokens WHERE shop = $1",
    [shop]
  );
  if (!result.rows.length) throw new Error("Token not found");
  return result.rows[0].access_token;
}

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

  return "custom";
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

  await axios.post(
    `https://${shop}/admin/api/2026-01/fulfillments/${fulfillmentId}/update_tracking.json`,
    payload,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );
}

/* ==========================
   WEBHOOK PRODUCTS CREATE
========================== */

app.post("/webhook/products-create", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  if (!shop) return;

  try {
    const accessToken = await getToken(shop);
    const product = req.body;

    await new Promise(resolve => setTimeout(resolve, 1500));

    const freshProduct = await axios.get(
      `https://${shop}/admin/api/2024-01/products/${product.id}.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const realProduct = freshProduct.data.product;
    const realVariants = realProduct.variants || [];

    const translatedTitle = await translateText(realProduct.title);
    const translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);
    const detectedCat = detectCategory(realProduct.title);

    await axios.put(
      `https://${shop}/admin/api/2024-01/products/${product.id}.json`,
      {
        product: {
          id: product.id,
          title: translatedTitle,
          body_html: translatedHtml,
          vendor: "friDker Internacional",
          product_type: detectedCat,
          tags: detectedCat,
          status: "active"
        }
      },
      {
        headers: { "X-Shopify-Access-Token": accessToken }
      }
    );

    for (const variant of realVariants) {
      await axios.put(
        `https://${shop}/admin/api/2024-01/variants/${variant.id}.json`,
        {
          variant: {
            id: variant.id,
            price: calculatePrice(parseFloat(variant.price)),
            sku: variant.sku,
            weight: DEFAULT_WEIGHT_VALUE,
            weight_unit: DEFAULT_WEIGHT_UNIT
          }
        },
        {
          headers: { "X-Shopify-Access-Token": accessToken }
        }
      );
    }

    const locations = await axios.get(
      `https://${shop}/admin/api/2024-01/locations.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const locationId = locations.data.locations[0].id;

    for (const variant of realVariants) {
      await axios.post(
        `https://${shop}/admin/api/2024-01/inventory_levels/set.json`,
        {
          location_id: locationId,
          inventory_item_id: variant.inventory_item_id,
          available: FIXED_STOCK
        },
        {
          headers: { "X-Shopify-Access-Token": accessToken }
        }
      );
    }

    log("Producto transformado correctamente con SEO leve");
  } catch (err) {
    console.error("Error webhook:", err.response?.data || err.message);
  }
});

/* ==========================
   WEBHOOK TRACKING
========================== */

app.post("/webhook/fulfillment", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  const topic = req.headers["x-shopify-topic"];
  if (!shop) return;

  try {
    const accessToken = await getToken(shop);
    const payload = req.body || {};

    const trackingNumber = pickTrackingNumberFromPayload(payload);
    if (!trackingNumber) return;

    const carrierSlug = detectAftershipCarrierSlug(trackingNumber, payload?.tracking_company);
    const trackingUrl = buildAftershipUrl(carrierSlug, trackingNumber);

    if (payload?.id && String(topic).startsWith("fulfillments/")) {
      await updateTrackingOnFulfillment(
        shop,
        accessToken,
        payload.id,
        carrierSlug,
        trackingNumber,
        trackingUrl
      );
    }

    log("Tracking actualizado");
  } catch (err) {
    console.error("Error fulfillment webhook:", err.response?.data || err.message);
  }
});

/* ==========================
   HEALTH
========================== */

app.get("/", (req, res) => {
  res.send("Transformer running 🚀");
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
