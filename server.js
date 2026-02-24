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

// Peso: fuerza 1000 g para TODAS las variantes
const DEFAULT_WEIGHT_VALUE = 1000;
const DEFAULT_WEIGHT_UNIT = "g";

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

async function translateText(text) {
  if (!text || !text.trim()) return text;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Traduce al español de México." },
          { role: "user", content: text }
        ],
        temperature: 0
      },
      {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
      }
    );

    return response.data.choices?.[0]?.message?.content ?? text;
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

async function getToken(shop) {
  const result = await pool.query(
    "SELECT access_token FROM shop_tokens WHERE shop = $1",
    [shop]
  );
  if (!result.rows.length) throw new Error(`Token not found for shop: ${shop}`);
  return result.rows[0].access_token;
}

function pickTrackingNumberFromPayload(payload) {
  // Cobertura amplia: fulfillment webhooks / fulfillment orders / apps externas
  const tinfo = payload?.tracking_info;

  // 1) tracking_info.number (REST 2026-01 estilo)
  if (tinfo?.number && String(tinfo.number).trim()) return String(tinfo.number).trim();

  // 2) tracking_number (tu caso actual)
  if (payload?.tracking_number && String(payload.tracking_number).trim())
    return String(payload.tracking_number).trim();

  // 3) tracking_numbers array
  if (Array.isArray(payload?.tracking_numbers) && payload.tracking_numbers.length) {
    const n = payload.tracking_numbers[0];
    if (n && String(n).trim()) return String(n).trim();
  }

  // 4) trackingInfo o tracking_info dentro de otras llaves comunes
  if (payload?.trackingInfo?.number && String(payload.trackingInfo.number).trim())
    return String(payload.trackingInfo.number).trim();

  return null;
}

function buildAftershipUrl(companySlug, trackingNumber) {
  return `https://www.aftership.com/track/${companySlug}/${trackingNumber}`;
}

async function getFulfillmentIdsFromFulfillmentOrder(shop, accessToken, fulfillmentOrderId) {
  // REST: listar fulfillments asociados a fulfillment_order
  // Doc: get /fulfillment_orders/{fulfillment_order_id}/fulfillments.json
  const resp = await axios.get(
    `https://${shop}/admin/api/2026-01/fulfillment_orders/${fulfillmentOrderId}/fulfillments.json`,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );

  // Resp típica: { fulfillments: [ { id, ... } ] }
  const fulfillments = resp.data?.fulfillments || [];
  return fulfillments.map(f => f.id).filter(Boolean);
}

async function updateTrackingOnFulfillment(shop, accessToken, fulfillmentId, trackingNumber, trackingUrl, trackingCompany) {
  // REST 2026-01: update_tracking.json (oficial para setear tracking posterior)
  const payload = {
    fulfillment: {
      notify_customer: false,
      tracking_info: {
        company: trackingCompany,
        number: trackingNumber,
        url: trackingUrl
      }
    }
  };

  const resp = await axios.post(
    `https://${shop}/admin/api/2026-01/fulfillments/${fulfillmentId}/update_tracking.json`,
    payload,
    { headers: { "X-Shopify-Access-Token": accessToken } }
  );

  return resp.data;
}

/* ==========================
   WEBHOOK PRODUCTS CREATE
========================== */

app.post("/webhook/products-create", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  const topic = req.headers["x-shopify-topic"];
  if (!shop) return;

  log("products-create webhook received", {
    shop,
    topic,
    product_id: req.body?.id
  });

  try {
    const accessToken = await getToken(shop);
    const product = req.body;

    // Espera a que Shopify termine de materializar variantes
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
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    // Update de variantes: precio + SKU + peso 1000g
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
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
    }

    const locations = await axios.get(
      `https://${shop}/admin/api/2024-01/locations.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );

    const locationId = locations.data?.locations?.[0]?.id;
    if (!locationId) throw new Error("No locations found to set inventory");

    for (const variant of realVariants) {
      await axios.post(
        `https://${shop}/admin/api/2024-01/inventory_levels/set.json`,
        {
          location_id: locationId,
          inventory_item_id: variant.inventory_item_id,
          available: FIXED_STOCK
        },
        { headers: { "X-Shopify-Access-Token": accessToken } }
      );
    }

    log("Producto transformado correctamente", {
      product_id: product.id,
      variants: realVariants.length,
      weight: `${DEFAULT_WEIGHT_VALUE}${DEFAULT_WEIGHT_UNIT}`
    });
  } catch (err) {
    console.error("Error webhook products-create full:", err.response?.data || err.message);
  }
});

/* ==========================
   WEBHOOK FULFILLMENT / FULFILLMENT ORDER (TRACKING)
========================== */

app.post("/webhook/fulfillment", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  const topic = req.headers["x-shopify-topic"];
  const webhookId = req.headers["x-shopify-webhook-id"]; // a veces viene

  if (!shop) return;

  const payload = req.body || {};

  // Logs estratégicos (diagnóstico profundo)
  log("fulfillment webhook received", {
    shop,
    topic,
    webhookId,
    payload_keys: Object.keys(payload || {}),
    payload_id: payload?.id,
    fulfillment_id: payload?.fulfillment_id,
    fulfillment_order_id: payload?.fulfillment_order_id
  });

  try {
    const accessToken = await getToken(shop);

    const trackingNumber = pickTrackingNumberFromPayload(payload);

    log("tracking detect", {
      trackingNumber,
      tracking_info: payload?.tracking_info,
      tracking_number: payload?.tracking_number,
      tracking_numbers: payload?.tracking_numbers
    });

    if (!trackingNumber) {
      log("skip: no tracking number found in payload", null);
      return;
    }

    // Tu regla: si no empieza con JM no se toca
    // (Tu ejemplo es JMX... así que esto PASA)
    if (!trackingNumber.startsWith("JM")) {
      log("skip: tracking does not start with JM", trackingNumber);
      return;
    }

    const trackingCompany = "360lion";
    const trackingUrl = buildAftershipUrl(trackingCompany, trackingNumber);

    // Determinar el fulfillmentId correcto
    let fulfillmentIds = [];

    // Caso A: el webhook ya es de fulfillments y trae id real
    if (payload?.id && typeof payload.id === "number" && String(topic || "").startsWith("fulfillments/")) {
      fulfillmentIds = [payload.id];
      log("mode A: topic fulfillments/* using payload.id", fulfillmentIds);
    }
    // Caso B: apps mandan fulfillment_id explícito
    else if (payload?.fulfillment_id) {
      fulfillmentIds = [payload.fulfillment_id];
      log("mode B: using payload.fulfillment_id", fulfillmentIds);
    }
    // Caso C: topic fulfillment_orders/* => necesitamos resolver fulfillments por fulfillment_order_id
    else if (
      (payload?.fulfillment_order_id || payload?.id) &&
      String(topic || "").startsWith("fulfillment_orders/")
    ) {
      const fulfillmentOrderId = payload.fulfillment_order_id || payload.id;
      log("mode C: topic fulfillment_orders/* resolve fulfillments for FO", { fulfillmentOrderId });

      fulfillmentIds = await getFulfillmentIdsFromFulfillmentOrder(shop, accessToken, fulfillmentOrderId);

      log("resolved fulfillmentIds from fulfillment_order", fulfillmentIds);
    }
    // Caso D: desconocido, intentamos heurística por topic y campos
    else {
      log("mode D: cannot reliably determine fulfillment id", { topic, payload_id: payload?.id });
      return;
    }

    if (!fulfillmentIds.length) {
      log("skip: no fulfillment ids resolved", null);
      return;
    }

    // Actualiza tracking en todos los fulfillments resueltos (normalmente será 1)
    for (const fid of fulfillmentIds) {
      try {
        const result = await updateTrackingOnFulfillment(
          shop,
          accessToken,
          fid,
          trackingNumber,
          trackingUrl,
          trackingCompany
        );

        log("Tracking actualizado (update_tracking.json)", {
          fulfillmentId: fid,
          trackingNumber,
          trackingUrl,
          result_keys: Object.keys(result || {})
        });
      } catch (e) {
        console.error("Error updating tracking for fulfillment:", {
          fulfillmentId: fid,
          error: e.response?.data || e.message
        });
      }
    }
  } catch (err) {
    console.error("Error fulfillment handler:", err.response?.data || err.message);
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
