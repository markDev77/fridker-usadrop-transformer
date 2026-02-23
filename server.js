const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cheerio = require("cheerio");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());

// ===============================
// CONFIG NEGOCIO
// ===============================
const USD_TO_MXN = 20;
const BASE_FEE = 200;
const MARGIN_1 = 1.15;
const MARGIN_2 = 1.20;
const FIXED_STOCK = 11;

// ===============================
// ENV
// ===============================
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
const APP_URL = process.env.APP_URL;
const SHOPIFY_SCOPES =
  process.env.SHOPIFY_SCOPES ||
  "write_products,read_products,write_inventory,read_inventory,read_locations";

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-01";

let SHOPIFY_STORE_DOMAIN = null;
let SHOPIFY_ADMIN_TOKEN = null;

// ===============================
// POSTGRES
// ===============================
let pool = null;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log("✅ PostgreSQL connected");
} else {
  console.log("⚠️ DATABASE_URL not found");
}

async function initDb() {
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_tokens (
      shop TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("✅ shop_tokens table ready");
}

initDb();

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
// TRANSLATION
// ===============================
async function translateText(text) {
  if (!text || !text.trim()) return text;

  try {
    const response = await axios.get(
      "https://api.mymemory.translated.net/get",
      { params: { q: text, langpair: "en|es" } }
    );
    return response?.data?.responseData?.translatedText || text;
  } catch {
    return text;
  }
}

async function translateHtmlTextNodes(html) {
  if (!html) return html;

  const $ = cheerio.load(html, { decodeEntities: false });
  const textNodes = [];

  function walk(node) {
    if (node.type === "text" && node.data.trim()) {
      textNodes.push(node);
    }
    if (node.children) node.children.forEach(walk);
  }

  walk($.root()[0]);

  for (const node of textNodes) {
    node.data = await translateText(node.data);
  }

  return $.root().html();
}

// ===============================
// SHOPIFY HELPERS
// ===============================
function shopifyHeaders() {
  return {
    "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
    "Content-Type": "application/json"
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

// ===============================
// OAUTH
// ===============================
function verifyQueryHmac(query) {
  const { hmac, ...rest } = query;

  const message = Object.keys(rest)
    .sort()
    .map(k => `${k}=${rest[k]}`)
    .join("&");

  const digest = crypto
    .createHmac("sha256", SHOPIFY_API_SECRET)
    .update(message)
    .digest("hex");

  return digest === hmac;
}

app.get("/oauth/install", (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send("Missing shop");

  const state = crypto.randomBytes(16).toString("hex");

  const authUrl = `https://${shop}/admin/oauth/authorize` +
    `?client_id=${SHOPIFY_API_KEY}` +
    `&scope=${SHOPIFY_SCOPES}` +
    `&redirect_uri=${APP_URL}/oauth/callback` +
    `&state=${state}`;

  res.cookie("state", state);
  res.redirect(authUrl);
});

app.get("/oauth/callback", async (req, res) => {
  const { shop, code, state } = req.query;

  if (!verifyQueryHmac(req.query)) {
    return res.status(403).send("Invalid HMAC");
  }

  const tokenRes = await axios.post(
    `https://${shop}/admin/oauth/access_token`,
    {
      client_id: SHOPIFY_API_KEY,
      client_secret: SHOPIFY_API_SECRET,
      code
    }
  );

  const accessToken = tokenRes.data.access_token;

  SHOPIFY_STORE_DOMAIN = shop;
  SHOPIFY_ADMIN_TOKEN = accessToken;

  if (pool) {
    await pool.query(
      `INSERT INTO shop_tokens (shop, access_token)
       VALUES ($1, $2)
       ON CONFLICT (shop)
       DO UPDATE SET access_token = EXCLUDED.access_token`,
      [shop, accessToken]
    );
    console.log("✅ Token saved in DB");
  }

  res.send("App instalada y token guardado en DB");
});

// ===============================
// WEBHOOK PRODUCT CREATE
// ===============================
app.post("/webhook/products-create", async (req, res) => {
  res.status(200).send("ok");

  const productId = req.body.id;
  if (!productId) return;

  const productData = await shopifyGet(`products/${productId}.json`);
  const product = productData.product;

  const newTitle = await translateText(product.title);
  const newBody = await translateHtmlTextNodes(product.body_html);

  const updatedVariants = product.variants.map(v => ({
    id: v.id,
    price: calculatePrice(parseFloat(v.price)).toString()
  }));

  await shopifyPut(`products/${productId}.json`, {
    product: {
      id: productId,
      title: newTitle,
      body_html: newBody,
      status: "active",
      variants: updatedVariants
    }
  });

  console.log("Product updated:", productId);
});

// ===============================
app.get("/", (req, res) => {
  res.send("fridker transformer running with DB");
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running on port", PORT));
