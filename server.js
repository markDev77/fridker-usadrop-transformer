const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();

/**
 * Si quieres HMAC real de webhooks, necesitas RAW body.
 * Aquí dejamos JSON para no romper, pero te dejo hook RAW opcional abajo.
 */
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
// SHOPIFY CONFIG
// ===============================
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL || "https://fridker-usadrop-transformer.onrender.com";
const SHOPIFY_SCOPES =
  process.env.SHOPIFY_SCOPES ||
  "write_products,read_products,write_inventory,read_inventory,read_locations";

const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ===============================
// DB (Postgres)
// ===============================
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.warn("⚠️ Missing DATABASE_URL. Tokens no se persistirán (solo MVP).");
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Render Postgres suele requerir SSL
    })
  : null;

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function saveShopToken(shop, token) {
  if (!pool) return;
  await ensureSchema();
  await pool.query(
    `
    INSERT INTO shop_tokens (shop, access_token, created_at, updated_at)
    VALUES ($1, $2, NOW(), NOW())
    ON CONFLICT (shop)
    DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW();
  `,
    [shop, token]
  );
}

async function getShopToken(shop) {
  if (!pool) return null;
  await ensureSchema();
  const r = await pool.query(`SELECT access_token FROM shop_tokens WHERE shop = $1 LIMIT 1`, [shop]);
  return r.rows?.[0]?.access_token || null;
}

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
// TRANSLATION (placeholder)
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
    if (node.children && node.children.length) node.children.forEach(walk);
  }
  walk($.root()[0]);

  for (const node of textNodes) {
    node.data = await translateText(node.data);
  }

  return $.root().html();
}

// ===============================
// SECURITY HELPERS
// ===============================
function safeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function verifyQueryHmac(query) {
  const { hmac, signature, ...rest } = query;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(",") : rest[k]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  return safeCompare(digest, hmac || "");
}

function buildAuthUrl(shop, state) {
  const redirectUri = `${APP_URL}/oauth/callback`;
  return (
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${encodeURIComponent(SHOPIFY_API_KEY)}` +
    `&scope=${encodeURIComponent(SHOPIFY_SCOPES)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`
  );
}

// ===============================
// SHOPIFY HELPERS (Admin REST)
// ===============================
function shopifyHeaders(accessToken) {
  return {
    "X-Shopify-Access-Token": accessToken,
    "Content-Type": "application/json",
  };
}

async function shopifyGet(shop, accessToken, path) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.get(url, { headers: shopifyHeaders(accessToken) });
  return res.data;
}

async function shopifyPut(shop, accessToken, path, payload) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.put(url, payload, { headers: shopifyHeaders(accessToken) });
  return res.data;
}

async function shopifyPost(shop, accessToken, path, payload) {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/${path}`;
  const res = await axios.post(url, payload, { headers: shopifyHeaders(accessToken) });
  return res.data;
}

async function getFirstLocationId(shop, accessToken) {
  const data = await shopifyGet(shop, accessToken, "locations.json");
  const loc = data?.locations?.[0];
  if (!loc?.id) throw new Error("No Shopify locations found");
  return loc.id;
}

async function setInventory(shop, accessToken, inventory_item_id, location_id, available) {
  return shopifyPost(shop, accessToken, "inventory_levels/set.json", {
    location_id,
    inventory_item_id,
    available,
  });
}

// ===============================
// OAUTH INSTALL FLOW
// ===============================
app.get("/oauth/install", (req, res) => {
  try {
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in env vars");
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

    return res.redirect(buildAuthUrl(shop, state));
  } catch (e) {
    return res.status(500).send(`OAuth install error: ${e?.message || e}`);
  }
});

app.get("/oauth/callback", async (req, res) => {
  try {
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET) {
      return res.status(500).send("Missing SHOPIFY_API_KEY or SHOPIFY_API_SECRET in env vars");
    }

    const shop = (req.query.shop || "").toString();
    const code = (req.query.code || "").toString();
    const state = (req.query.state || "").toString();

    const stateCookie = req.cookies?.shopify_oauth_state;
    if (!stateCookie || stateCookie !== state) return res.status(403).send("Invalid OAuth state");
    if (!verifyQueryHmac(req.query)) return res.status(403).send("Invalid HMAC");
    if (!shop || !code) return res.status(400).send("Missing shop or code");

    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const tokenRes = await axios.post(tokenUrl, {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code,
    });

    const accessToken = tokenRes?.data?.access_token;
    if (!accessToken) return res.status(500).send("No access_token received from Shopify");

    // ✅ Persistimos por shop (PROD)
    await saveShopToken(shop, accessToken);

    res.clearCookie("shopify_oauth_state");

    return res.send(
      `✅ App instalada y token guardado en DB. Shop: ${shop}. Ya puedes probar webhooks/transform.`
    );
  } catch (e) {
    return res.status(500).send(`OAuth callback error: ${e?.message || e}`);
  }
});

// ===============================
// WEBHOOK VERIFICATION (opcional)
// ===============================
function verifyShopifyWebhook(req) {
  if (!SHOPIFY_WEBHOOK_SECRET) return true;

  const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
  if (!hmacHeader) return false;

  // ⚠️ con express.json() esto NO es perfecto. Para HMAC real necesitas raw body.
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
// WEBHOOK: products/create
// ===============================
app.post("/webhook/products-create", async (req, res) => {
  try {
    // 1) responder rápido a Shopify
    res.status(200).send("ok");

    // 2) firma (si usas secret)
    if (!verifyShopifyWebhook(req)) {
      console.log("Webhook signature invalid");
      return;
    }

    // 3) obtener shop desde header oficial
    const shop = (req.get("X-Shopify-Shop-Domain") || "").toString();
    if (!shop || !shop.endsWith(".myshopify.com")) {
      console.log("Webhook missing/invalid X-Shopify-Shop-Domain");
      return;
    }

    const accessToken = await getShopToken(shop);
    if (!accessToken) {
      console.log(`No token found in DB for shop ${shop}. Reinstala /oauth/install?shop=${shop}`);
      return;
    }

    const productId = req.body?.id;
    if (!productId) {
      console.log("Webhook without product id");
      return;
    }

    const productData = await shopifyGet(shop, accessToken, `products/${productId}.json`);
    const product = productData?.product;
    if (!product) {
      console.log("Product not found via API");
      return;
    }

    const newTitle = await translateText(product.title || "");
    const newBodyHtml = await translateHtmlTextNodes(product.body_html || "");

    const updatedVariants = (product.variants || []).map((v) => ({
      id: v.id,
      price: String(calculatePrice(parseFloat(v.price || 0))),
    }));

    await shopifyPut(shop, accessToken, `products/${productId}.json`, {
      product: {
        id: productId,
        title: newTitle,
        body_html: newBodyHtml,
        status: "active",
        variants: updatedVariants,
      },
    });

    const locationId = await getFirstLocationId(shop, accessToken);
    for (const v of product.variants || []) {
      if (v.inventory_item_id) {
        await setInventory(shop, accessToken, v.inventory_item_id, locationId, FIXED_STOCK);
      }
    }

    console.log(`Updated product ${productId} @ ${shop}: title/body/prices + inventory=11`);
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
