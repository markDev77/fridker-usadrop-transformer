const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "10mb" }));

// ===============================
// CONFIG
// ===============================
const USD_TO_MXN = 20;
const BASE_FEE = 200;
const MARGIN_1 = 1.15; // 15%
const MARGIN_2 = 1.20; // 20%
const FIXED_STOCK = 11;

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
// SIMPLE HTML TEXT TRANSLATOR
// (solo texto plano, no toca etiquetas)
// ===============================
async function translateText(text) {
  try {
    const response = await axios.post(
      "https://api.mymemory.translated.net/get",
      null,
      {
        params: {
          q: text,
          langpair: "en|es"
        }
      }
    );

    return response.data.responseData.translatedText;
  } catch (err) {
    return text;
  }
}

// ===============================
// WEBHOOK ENDPOINT
// ===============================
app.post("/transform", async (req, res) => {
  try {
    const product = req.body;

    const transformed = {
      title: await translateText(product.title || ""),
      body_html: await translateText(product.body_html || ""),
      variants: (product.variants || []).map(v => ({
        price: calculatePrice(parseFloat(v.price || 0)),
        inventory_quantity: FIXED_STOCK,
        sku: v.sku || ""
      }))
    };

    res.json(transformed);
  } catch (error) {
    res.status(500).json({ error: "Transformation error" });
  }
});

// ===============================
app.get("/", (req, res) => {
  res.send("fridker-usadrop-transformer running");
});

// ===============================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
