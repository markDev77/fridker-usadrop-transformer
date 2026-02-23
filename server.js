require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cheerio = require("cheerio");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const {
  DATABASE_URL,
  OPENAI_API_KEY
} = process.env;

/* ==========================
   CONFIG NEGOCIO
========================== */

const USD_TO_MXN = 20;
const BASE_FEE = 200;
const MARGIN_1 = 1.15;
const MARGIN_2 = 1.20;
const FIXED_STOCK = 11;

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

function calculatePrice(usd) {
  let mxn = usd * USD_TO_MXN;
  mxn += BASE_FEE;
  mxn *= MARGIN_1;
  mxn *= MARGIN_2;
  return Math.ceil(mxn);
}

function detectCategory(title) {
  const t = title.toLowerCase();

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
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`
        }
      }
    );

    return response.data.choices[0].message.content;
  } catch (err) {
    console.log("Traducción omitida:", err.response?.data || err.message);
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

    console.log("Webhook recibido:", product.title);

    // pequeño delay para evitar conflicto Shopify
    await new Promise(resolve => setTimeout(resolve, 1500));

    const freshProduct = await axios.get(
      `https://${shop}/admin/api/2024-01/products/${product.id}.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken
        }
      }
    );

    const realProduct = freshProduct.data.product;
    const realVariants = realProduct.variants;

    const translatedTitle = await translateText(realProduct.title);
    const translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);

    const detectedCat = detectCategory(realProduct.title);

    /* ====== 1️⃣ Actualizar producto (sin variants) ====== */

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
        headers: {
          "X-Shopify-Access-Token": accessToken
        }
      }
    );

    /* ====== 2️⃣ Actualizar precio variante por variante ====== */

    for (const variant of realVariants) {
      await axios.put(
        `https://${shop}/admin/api/2024-01/variants/${variant.id}.json`,
        {
          variant: {
            id: variant.id,
            price: calculatePrice(parseFloat(variant.price))
          }
        },
        {
          headers: {
            "X-Shopify-Access-Token": accessToken
          }
        }
      );
    }

    /* ====== 3️⃣ Fijar inventario ====== */

    const locations = await axios.get(
      `https://${shop}/admin/api/2024-01/locations.json`,
      {
        headers: { "X-Shopify-Access-Token": accessToken }
      }
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

    console.log("Producto transformado correctamente");

  } catch (err) {
    console.error("Error webhook full:", err.response?.data || err.message);
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
