const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");

const app = express();

// IMPORTANTE: para verificación de webhooks con HMAC real se requiere RAW body.
// Por ahora dejamos JSON normal (sin romper), y la verificación queda "opcional".
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

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
let SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g. eawi7g-hj.myshopify.com (se setea luego en OAuth)
let SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;   // Admin API access token (se setea luego en OAuth)
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

// OAuth (OBLIGATORIO para instalar app)
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL || "https://fridker-usadrop-transformer.onrender.com";
const SHOPIFY_SCOPES =
  process.env.SHOPIFY_SCOPES ||
  "write_products,read_products,write_inventory,read_inventory,read_locations";

// (opcional) verificar webhooks
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ===============================
// PRICE LOGIC
// ===============================
function calculatePrice(usd) {
  let mxn = usd * USD_TO_MXN;
  mxn += BASE_FEE;
  mxn *= MARGIN_1;
  mxn *= MARGIN_2;
  return Math.ceil(mxn);
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

  for (const node of textNodes) {
    const original = node.data;
    const translated = await translateText(original);
    node.data = translated;
  }

  return $.root().html();
}

// ===============================
// SHOPIFY HELPERS (Admin REST)
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
  return shopifyPost("inventory_levels/set.json", {
    location_id,
    inventory_item_id,
    available,
  });
}

// ===============================
// OAUTH INSTALL FLOW (LO QUE TE FALTA)
// ===============================
function safeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function verifyQueryHmac(query) {
  // Shopify manda ?hmac=...&...  Se verifica con API_SECRET
  const { hmac, signature, ...rest } = query;

  // 1) construir message ordenado alfabéticamente: key=value&key2=value2
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");

  // 2) hmac sha256 hex
  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  return safeCompare(digest, hmac || "");
}

function buildAuthUrl(shop, state) {
  const redirectUri = `${APP_URL}/oauth/callback`;
  const installUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_API_KEY)}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;
  return installUrl;
}

// 1) Inicia instalación
app.get("/oauth/install", (req, res) => {
  try {
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res
        .status(500)
        .send("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in env vars");
    }

    const shop = (req.query.shop || "").toString();
    if (!shop || !shop.endsWith(".myshopify.com")) {
      return res.status(400).send("Missing/invalid shop param");
    }

    const state = crypto.randomBytes(16).toString("hex");
    res.cookie("shopify_oauth_state", state, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    });

    const authUrl = buildAuthUrl(shop, state);
    return res.redirect(authUrl);
  } catch (e) {
    return res.status(500).send(`OAuth install error: ${e?.message || e}`);
  }
});

// 2) Callback de Shopify (obtiene access_token)
app.get("/oauth/callback", async (req, res) => {
  try {
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res
        .status(500)
        .send("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in env vars");
    }

    const shop = (req.query.shop || "").toString();
    const code = (req.query.code || "").toString();
    const state = (req.query.state || "").toString();

    const stateCookie = req.cookies?.shopify_oauth_state;
    if (!stateCookie || stateCookie !== state) {
      return res.status(403).send("Invalid OAuth state");
    }

    // Verifica HMAC de query
    if (!verifyQueryHmac(req.query)) {
      return res.status(403).send("Invalid HMAC");
    }

    if (!shop || !code) {
      return res.status(400).send("Missing shop or code");
    }

    // Exchange code -> access_token
    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenRes = await axios.post(tokenUrl, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    const accessToken = tokenRes?.data?.access_token;
    if (!accessToken) {
      return res.status(500).send("No access_token received from Shopify");
    }

    // Guardamos en memoria (MVP). Para prod: DB / KV.
    SHOPIFY_STORE_DOMAIN = shop;
    SHOPIFY_ADMIN_TOKEN = accessToken;

    // Limpia cookie state
    res.clearCookie("shopify_oauth_state");

    // Opcional: crea webhook de products/create apuntando a tu endpoint
    // (Puedes descomentarlo después de confirmar que tu endpoint está OK)
    /*
    await shopifyPost("webhooks.json", {
      webhook: {
        topic: "products/create",
        address: `${APP_URL}/webhook/products-create`,
        format: "json",
      },
    });
    */

    return res.send(
      `✅ App instalada y token guardado en servidor (MVP). Shop: ${shop}. Ya puedes probar webhooks/transform.`
    );
  } catch (e) {
    return res.status(500).send(`OAuth callback error: ${e?.message || e}`);
  }
});

// ===============================
// WEBHOOK VERIFICATION (opcional)
// NOTA: con express.json() el body cambia y puede fallar HMAC.
// Aquí lo dejamos "permisivo" para no bloquear.
// ===============================
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;

  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  const body = JSON.stringify(req.body);
  const digest = crypto
    .createHmac("sha256", SHOPIFY_WEBHOOK_SECRET)
    .update(body, "utf8")
    .digest("base64");

  return safeCompare(digest, hmacHeader);
}

// ===============================
// ENDPOINT: manual transform
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
