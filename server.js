require("dotenv").config();
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SHOPIFY_SCOPES,
  APP_URL,
  DATABASE_URL
} = process.env;

/* ==========================
   PostgreSQL
========================== */

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_tokens (
        shop TEXT PRIMARY KEY,
        access_token TEXT NOT NULL
      );
    `);
    console.log("shop_tokens table ready");
  } catch (err) {
    console.error("Database init error:", err.message);
  }
}

/* ==========================
   ROOT + HEALTH
========================== */

app.get("/", (req, res) => {
  res.send("Fridker UsaDrop Transformer API running 🚀");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/* ==========================
   SHOPIFY OAUTH INSTALL
========================== */

app.get("/oauth/install", (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  const redirectUri = `${APP_URL}/oauth/callback`;

  const installUrl = `https://${shop}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SHOPIFY_SCOPES}&redirect_uri=${redirectUri}`;

  res.redirect(installUrl);
});

/* ==========================
   SHOPIFY OAUTH CALLBACK
========================== */

app.get("/oauth/callback", async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Missing parameters");
  }

  try {
    const tokenResponse = await axios.post(
      `https://${shop}/admin/oauth/access_token`,
      {
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code
      }
    );

    const accessToken = tokenResponse.data.access_token;

    await pool.query(
      `
      INSERT INTO shop_tokens (shop, access_token)
      VALUES ($1, $2)
      ON CONFLICT (shop)
      DO UPDATE SET access_token = EXCLUDED.access_token
      `,
      [shop, accessToken]
    );

    console.log("Token saved in DB for:", shop);

    res.send("App instalada correctamente y token guardado 🚀");

  } catch (err) {
    console.error("OAuth Error:", err.response?.data || err.message);
    res.status(500).send("Error during OAuth process");
  }
});

/* ==========================
   TEST PRODUCTS
========================== */

app.get("/test-products", async (req, res) => {
  const { shop } = req.query;

  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  try {
    const result = await pool.query(
      "SELECT access_token FROM shop_tokens WHERE shop = $1",
      [shop]
    );

    if (!result.rows.length) {
      return res.status(404).send("No token found for this shop");
    }

    const accessToken = result.rows[0].access_token;

    const response = await axios.get(
      `https://${shop}/admin/api/2024-01/products.json`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    console.error("Product fetch error:", err.response?.data || err.message);
    res.status(500).send("Error fetching products");
  }
});

/* ==========================
   START SERVER
========================== */

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
