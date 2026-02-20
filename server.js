const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cheerio = require("cheerio");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===============================
// CONFIG (tu regla de negocio)
// ===============================
const USD_TO_MXN = 20;
const BASE_FEE = 200;
const MARGIN_1 = 1.15; // 15% fee marketplace
const MARGIN_2 = 1.20; // 20% margen fridker
const FIXED_STOCK = 11;

// ===============================
// SHOPIFY CONFIG (Render env vars)
// ===============================
const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. eawi7g-hj.myshopify.com
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API access token
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

// (opcional pero recomendado) verificar webhooks
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ===============================
// PRICE LOGIC
// ===============================
function calculatePrice(usd) {
  let mxn = usd * USD_TO_MXN;
  mxn += BASE_FEE;
  mxn *= MARGIN_1;
  mxn *= MARGIN_2;
  return Math.ceil(mxn); // redondear hacia arriba
}

// ===============================
// TRANSLATION (placeholder actual)
// Cambiaremos luego a GPT sin romper flujo.
// ===============================
async function translateText(text) {
  if (!text || !text.trim()) return text;

  try {
    const response = await axios.post(
      "https://api.mymemory.translated.net/get",
      null,
      { params: { q: text, langpair: "en|es" } }
    );
    const t = response?.data?.responseData?.translatedText;
    return t || text;
  } catch {
    return text;
  }
}

// Traduce SOLO texto dentro de HTML, preserva tags.
async function translateHtmlTextNodes(html) {
  if (!html || !html.trim()) return html;

  const $ = cheerio.load(html, { decodeEntities: false });

  // Recorremos nodos de texto (excluye script/style)
  const textNodes = [];
  function walk(node) {
    if (!node) return;
    if (node.type === "text") {
      const raw = node.data;
      if (raw && raw.trim()) textNodes.push(node);
    }
    if (node.children && node.children.length) {
      node.children.forEach(walk);
    }
  }
  walk($.root()[0]);

  // Traducir en serie (simple y estable para MVP)
  for (const node of textNodes) {
    const original = node.data;
    const translated = await translateText(original);
    node.data = translated;
  }

  return $.root().html();
}

// ===============================
// SHOPIFY HELPERS
// ===============================
function shopifyHeaders() {
  return {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json",
  };
}

async function shopifyGet(path) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.get(url, { headers: shopifyHeaders() });
  return res.data;
}

async function shopifyPut(path, payload) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.put(url, payload, { headers: shopifyHeaders() });
  return res.data;
}

async function shopifyPost(path, payload) {
  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.post(url, payload, { headers: shopifyHeaders() });
  return res.data;
}

async function getFirstLocationId() {
  const data = await shopifyGet("locations.json");
  const loc = data?.locations?.[0];
  if (!loc?.id) throw new Error("No Shopify locations found");
  return loc.id;
}

async function setInventory(inventory_item_id, location_id, available) {
  // inventory_levels/set.json (Admin REST)
  return shopifyPost("inventory_levels/set.json", {
    location_id,
    inventory_item_id,
    available,
  });
}

// ===============================
// WEBHOOK VERIFICATION (opcional)
// ===============================
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true; // si no lo configuras, no bloqueamos

  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  const body = JSON.stringify(req.body);
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(body, "utf8")
    .digest("base64");

  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

// ===============================
// ENDPOINT: manual transform (lo que ya tenías)
// ===============================
app.post("/transform", async (req, res) => {
  try {
    const product = req.body;

    const transformed = {
      title: await translateText(product.title || ""),
      body_html: await translateHtmlTextNodes(product.body_html || ""),
      variants: (product.variants || []).map((v) => ({
        price: calculatePrice(parseFloat(v.price || 0)),
        inventory_quantity: FIXED_STOCK,
        sku: v.sku || "",
      })),
    };

    res.json(transformed);
  } catch {
    res.status(500).json({ error: "Transformation error" });
  }
});

// ===============================
// ENDPOINT: Shopify webhook when product created
// UsaDrop crea producto -> Shopify manda webhook aquí -> actualizamos Shopify
// ===============================
app.post("/webhook/products-create", async (req, res) => {
  try {
    // 1) responder rápido a Shopify
    res.status(200).send("ok");

    // 2) verificar firma (si configuraste secret)
    if (!verifyShopifyWebhook(req)) {
      console.log("Webhook signature invalid");
      return;
    }

    if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
      console.log("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN");
      return;
    }

    const productId = req.body?.id;
    if (!productId) {
      console.log("Webhook without product id");
      return;
    }

    // 3) Obtener producto completo desde Shopify
    const productData = await shopifyGet(`products/${productId}.json`);
    const product = productData?.product;
    if (!product) {
      console.log("Product not found via API");
      return;
    }

    // 4) Transformaciones: título + HTML (solo texto) + precios por variante
    const newTitle = await translateText(product.title || "");
    const newBodyHtml = await translateHtmlTextNodes(product.body_html || "");

    const updatedVariants = (product.variants || []).map((v) => ({
      id: v.id,
      price: String(calculatePrice(parseFloat(v.price || 0))),
    }));

    // 5) Update product (título, descripción, precios, status activo)
    await shopifyPut(`products/${productId}.json`, {
      product: {
        id: productId,
        title: newTitle,
        body_html: newBodyHtml,
        status: "active",
        variants: updatedVariants,
      },
    });

    // 6) Inventario 11 por variante (por location)
    const locationId = await getFirstLocationId();
    for (const v of product.variants || []) {
      // inventory_item_id viene en la variante
      if (v.inventory_item_id) {
        await setInventory(v.inventory_item_id, locationId, FIXED_STOCK);
      }
    }

    console.log(`Updated product ${productId}: title/body/prices + inventory=11`);
  } catch (e) {
    console.log("Webhook processing error:", e?.message || e);
  }
});

// ===============================
app.get("/", (req, res) => {
  res.send("fridker-usadrop-transformer running");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
