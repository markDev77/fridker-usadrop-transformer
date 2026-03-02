require("dotenv").config();
const express = require("express");
const axios = require("axios");
const { Pool } = require("pg");
const cheerio = require("cheerio");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 10000;
const { DATABASE_URL, OPENAI_API_KEY } = process.env;

/* ==========================
   CONFIG NEGOCIO
========================== */

const USD_TO_MXN = 20;
const FIXED_STOCK = 11;

const DEFAULT_WEIGHT_VALUE = 1;
const DEFAULT_WEIGHT_UNIT = "kg";

const PRODUCT_API_VERSION = "2024-01";
const FULFILLMENT_API_VERSION = "2026-01";

// Shopify rate limit safety
const SHOPIFY_MIN_INTERVAL_MS = 650;

// Retry control
const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 800;

// Espera post-create para que Shopify materialice variantes/inventory_item_id
const PRODUCT_CREATE_WARMUP_MS = 1800;

/* ==========================
   ZEUS COMPLIANCE (paramétrico)
========================== */

const DEFAULT_BANNED_WORDS = [
  "imitacion",
  "imitación",
  "replica",
  "réplica",
  "falsificado",
  "copia",
  "clon",
  "cerveza",
  "granada",
  "arma",
  "pistola",
  "rifle",
  "municion",
  "munición",
  "cuchillo",
  "navaja"
];


/* ==========================
   ORIGEN AUTORIZADO + DEDUP
========================== */

const USADROP_SKU_REGEX = /^PD\.\d+$/i;
const ZEUS_SIGNATURE_TAG_PREFIX = "ZEUS_SIG_";

function isValidUsadropSku(sku) {
  const s = (sku || "").trim();
  return USADROP_SKU_REGEX.test(s);
}

function normalizeForSignature(str) {
  return (str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function computeProductSignature(title, imageKey) {
  const base = `${normalizeForSignature(title)}|${(imageKey || "").trim()}`;
  return crypto.createHash("sha256").update(base).digest("hex").slice(0, 12);
}

function buildTagSetFromProduct(product, extraTags = []) {
  const existing = (product?.tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const all = [...existing, ...extraTags]
    .map((t) => String(t || "").trim())
    .filter(Boolean);

  return Array.from(new Set(all));
}

async function findProductsByTag(shop, accessToken, tag) {
  const q = `
    query ($query: String!) {
      products(first: 5, query: $query) {
        edges { node { id } }
      }
    }`;

  const data = await shopifyGraphQL(shop, accessToken, q, { query: `tag:${tag}` });

  const edges = data?.products?.edges || [];
  return edges
    .map((e) => e?.node?.id)
    .filter(Boolean)
    .map((gid) => String(gid).split("/").pop());
}

function getBannedWords() {
  const extra = (process.env.ZEUS_BANNED_WORDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const all = [...DEFAULT_BANNED_WORDS, ...extra];
  return Array.from(new Set(all.map(w => w.toLowerCase())));
}

const LEATHER_WORDS = ["cuero", "piel genuina", "piel real"];
const LEATHER_REPLACEMENT = "piel sintética";

/* ==========================
   MARKETPLACE BLOCK LIST (STRUCTURAL)
========================== */

const MARKETPLACE_BLOCK_WORDS = [
  // armas / punzocortantes / autodefensa
  "defensa",
  "autodefensa",
  "self defense",
  "self-defense",
  "arma",
  "weapon",
  "knife",
  "cuchillo",
  "navaja",
  "dagger",
  "espiga",
  "punta",
  "táctico",
  "tactico",
  // municiones / explosivos
  "municion",
  "munición",
  "ammunition",
  "granada",
  "explosivo",
  // pistolas / rifles
  "pistola",
  "rifle",
  "gun",
  "firearm"
];

function isBlockedProduct(title, bodyHtml) {
  const t = String(title || "").toLowerCase();
  const b = cheerio.load(bodyHtml || "", { decodeEntities: false }).text().toLowerCase();
  return MARKETPLACE_BLOCK_WORDS.some(w => t.includes(w) || b.includes(w));
}

/* ==========================
   IMAGE FALLBACK FROM HTML
   Si no hay imagen principal (product.images vacío),
   toma la primera <img src="..."> del body_html y la sube como imagen del producto
========================== */

function extractFirstImageFromHtml(html) {
  const $ = cheerio.load(html || "", { decodeEntities: false });
  const img = $("img").first();
  const src = img.attr("src");
  if (!src) return null;

  const s = String(src).trim();
  if (!s) return null;
  if (s.startsWith("data:")) return null; // evita base64
  return s;
}
function normalizeImageFingerprint(src) {
  if (!src || typeof src !== "string") return "";
  let clean = src.trim();
  // Drop surrounding quotes if any
  clean = clean.replace(/^['"]|['"]$/g, "");
  // Remove query/hash
  clean = clean.split("#")[0].split("?")[0];

  // If it's a full URL, keep only the path; otherwise keep as-is
  try {
    if (/^https?:\/\//i.test(clean)) {
      const u = new URL(clean);
      clean = (u.pathname || "").toLowerCase();
    } else {
      clean = clean.toLowerCase();
    }
  } catch (_) {
    clean = clean.toLowerCase();
  }

  // Take last path segment if available; fallback to full (relative) path
  const parts = clean.split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : clean;
  return last || "";
}

function extractImageFingerprintsFromHtml(html, limit = 3) {
  if (!html || typeof html !== "string") return [];
  const out = [];
  const imgTagRegex = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = imgTagRegex.exec(html)) !== null) {
    const fp = normalizeImageFingerprint(m[1]);
    if (fp) out.push(fp);
    if (out.length >= limit) break;
  }
  return out;
}

function buildImageFingerprintKey(realProduct, limit = 3) {
  const fps = [];

  // 1) From Shopify product images
  const imgs = Array.isArray(realProduct?.images) ? realProduct.images : [];
  for (const img of imgs) {
    const src = img?.src || img?.url || img?.originalSrc;
    const fp = normalizeImageFingerprint(src);
    if (fp) fps.push(fp);
    if (fps.length >= limit) break;
  }

  // 2) From HTML (often includes supplier images)
  const htmlFps = extractImageFingerprintsFromHtml(realProduct?.body_html || "", limit);
  for (const fp of htmlFps) {
    if (fp) fps.push(fp);
    if (fps.length >= limit * 2) break; // allow a bit more then de-dupe
  }

  // De-dupe preserving order
  const seen = new Set();
  const uniq = [];
  for (const fp of fps) {
    if (!fp) continue;
    if (seen.has(fp)) continue;
    seen.add(fp);
    uniq.push(fp);
    if (uniq.length >= limit) break;
  }

  return uniq.join("|");
}

async function ensureMainImage(shop, accessToken, productId, realProduct) {
  if (Array.isArray(realProduct?.images) && realProduct.images.length > 0) return;

  const fallbackImage = extractFirstImageFromHtml(realProduct?.body_html);
  if (!fallbackImage) {
    log("No fallback image found", { shop, productId });
    return;
  }

  await shopifyRequest(shop, {
    method: "POST",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}/images.json`,
    headers: { "X-Shopify-Access-Token": accessToken },
    data: { image: { src: fallbackImage } }
  });

  log("Fallback image applied", { shop, productId, fallbackImage });
}

/* ==========================
   POSTGRES
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
      log("QUEUE: start", {
        shop,
        jobName: item.jobName,
        jobId: item.jobId,
        remaining: q.queue.length
      });

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
    const backoff = retryAfter ?? BASE_BACKOFF_MS * Math.pow(2, attempt);
    log("Shopify retry", { shop, status, attempt: attempt + 1, wait_ms: backoff });

    await sleep(backoff);
    return shopifyRequest(shop, config, attempt + 1);
  }
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
   PRICING - BLINDAJE MEDIO
   + regla 699 (solo rangos indicados)
========================== */

function calculatePrice(usdRaw) {
  const usd = Number(usdRaw);
  let adjustedUsd = Number.isFinite(usd) ? usd : 0;

  // Multiplicadores por tramo
  if (adjustedUsd <= 8) adjustedUsd *= 2.1;
  else if (adjustedUsd <= 20) adjustedUsd *= 1.9;
  else if (adjustedUsd <= 40) adjustedUsd *= 1.75;
  else if (adjustedUsd <= 80) adjustedUsd *= 1.65;
  else adjustedUsd *= 1.55;

  // Conversión + fee + blindaje
  let mxn = adjustedUsd * USD_TO_MXN;
  mxn += 350;
  mxn *= 1.16;

  // Psicología retail estándar (terminación 9)
  mxn = Math.ceil(mxn / 10) * 10 - 1;

  // Regla especial (solo estos rangos)
  if ((mxn >= 300 && mxn <= 600) || (mxn >= 700 && mxn <= 740)) {
    mxn = 699;
  }

  return Math.max(599, mxn);
}

/* ==========================
   CATEGORÍA SIMPLE
========================== */

function detectCategory(title) {
  const t = (title || "").toLowerCase();
  if (t.includes("bag") || t.includes("bolsa")) return "BOLSOS";
  if (t.includes("massage") || t.includes("masaje")) return "TERAPIA";
  if (t.includes("led")) return "ILUMINACION";
  if (t.includes("chair") || t.includes("silla")) return "HOGAR";
  return "GENERAL";
}

/* ==========================
   TRADUCCIÓN + HTML PRESERVANDO TAGS
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
   COMPLIANCE HELPERS
========================== */

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSpaces(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function detectMaterialHint(title, bodyHtml) {
  const bodyText = cheerio.load(bodyHtml || "", { decodeEntities: false }).text().toLowerCase();

  const hasPU =
    bodyText.includes(" material: pu") ||
    bodyText.includes("material: pu") ||
    bodyText.includes("material:pu") ||
    bodyText.includes("polyurethane") ||
    bodyText.includes("poliuretano") ||
    bodyText.includes("piel sintética") ||
    bodyText.includes("sintético") ||
    bodyText.includes("sintetico") ||
    bodyText.includes(" pu ") ||
    bodyText.includes(" pu,") ||
    bodyText.includes(" pu.");

  const saysLeather = String(title || "").toLowerCase().includes("cuero") || bodyText.includes("cuero");
  return { hasPU, saysLeather };
}

function sanitizeTextForMarketplace(text, materialHint) {
  let s = String(text || "");

  const bannedWords = getBannedWords();
  for (const w of bannedWords) {
    const re = new RegExp(`\\b${escapeRegExp(w)}\\b`, "gi");
    s = s.replace(re, "");
  }

  if (materialHint?.hasPU) {
    for (const w of LEATHER_WORDS) {
      const re = new RegExp(`\\b${escapeRegExp(w)}\\b`, "gi");
      s = s.replace(re, LEATHER_REPLACEMENT);
    }
  }

  s = s.replace(/\(\s*\)/g, "");
  s = s.replace(/\[\s*\]/g, "");
  s = normalizeSpaces(s);

  return s;
}

function sanitizeHtmlForMarketplace(html, materialHint) {
  const $ = cheerio.load(html || "", { decodeEntities: false });

  function walk(node) {
    if (!node) return;
    if (node.type === "text" && node.data && node.data.trim()) {
      node.data = sanitizeTextForMarketplace(node.data, materialHint);
    }
    if (node.children) node.children.forEach(walk);
  }

  walk($.root()[0]);
  return $.root().html();
}

function ensureNonEmptyTitle(title, fallback) {
  const t = normalizeSpaces(title);
  if (t && t.length >= 3) return t;
  const fb = normalizeSpaces(fallback);
  if (fb && fb.length >= 3) return fb;
  return "Producto importado";
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
   GRAPHQL HELPERS (SKUs -> product_ids)
========================== */

function gidToNumericId(gid) {
  if (!gid) return null;
  const m = String(gid).match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

async function shopifyGraphQL(shop, accessToken, query, variables) {
  return shopifyRequest(shop, {
    method: "POST",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json"
    },
    data: { query, variables }
  });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function findProductIdsBySkus(shop, accessToken, skus) {
  const uniq = Array.from(new Set((skus || []).map(s => String(s || "").trim()).filter(Boolean)));
  if (uniq.length === 0) return [];

  const productIds = new Set();
  const batches = chunk(uniq, 10);

  const GQL = `
    query($q: String!) {
      productVariants(first: 50, query: $q) {
        edges {
          node {
            sku
            product { id }
          }
        }
      }
    }
  `;

  for (const batch of batches) {
    const q = batch.map(s => `sku:${s.replace(/"/g, "")}`).join(" OR ");
    const resp = await shopifyGraphQL(shop, accessToken, GQL, { q });

    const edges = resp?.data?.data?.productVariants?.edges || [];
    for (const e of edges) {
      const pid = gidToNumericId(e?.node?.product?.id);
      if (pid) productIds.add(pid);
    }
  }

  return Array.from(productIds);
}

/* ==========================
   FULL MODE: PRODUCT TRANSFORM
   (pricing + peso + stock + vendor/tags + compliance)
   ✅ BLOQUEO + ✅ IMAGEN fallback
========================== */

async function transformProductById(shop, accessToken, productId) {
  await sleep(PRODUCT_CREATE_WARMUP_MS);

  const freshProduct = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const realProduct = freshProduct.data.product;
  const realVariants = Array.isArray(realProduct?.variants)
    ? realProduct.variants
    : [];


  // ✅ ORIGEN AUTORIZADO (SKU PD.XXX)
  const invalidSkus = realVariants
    .map((v) => (v?.sku || "").trim())
    .filter((sku) => sku && !isValidUsadropSku(sku));

  if (invalidSkus.length) {
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: { product: { id: productId, status: "draft", tags: buildTagSetFromProduct(realProduct, ["ORIGIN_NOT_AUTHORIZED"]).join(", ") } }
    });
    log("Producto bloqueado por ORIGEN AUTORIZADO (SKU inválido)", { shop, productId, invalidSkus: invalidSkus.slice(0, 10) });
    return;
  }

  // 🔴 BLOQUEO ESTRUCTURAL (ANTES DE TODO)
  if (isBlockedProduct(realProduct.title, realProduct.body_html)) {
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: {
        product: {
          id: productId,
          status: "draft",
          tags: buildTagSetFromProduct(realProduct, ["BLOCKED_BY_POLICY"]).join(", ")
        }
      }
    });

    log("Producto bloqueado por política marketplace", { shop, productId, title: realProduct.title });
    return;
  }

  // 🔴 ASEGURAR IMAGEN PRINCIPAL (SI NO TRAE)
  await ensureMainImage(shop, accessToken, productId, realProduct);

  // ✅ DEDUP: firma estructural (título original + 1a imagen + #variantes)
  const imageKey = buildImageFingerprintKey(realProduct, 3);
  const sigHash = computeProductSignature(realProduct.title, imageKey);
  const sigTag = `${ZEUS_SIGNATURE_TAG_PREFIX}${sigHash}`;

  const dupIds = await findProductsByTag(shop, accessToken, sigTag);
  const hasDup = dupIds.some((id) => String(id) !== String(productId));

  if (hasDup) {
    const tags = buildTagSetFromProduct(realProduct, ["DUPLICATE_SIGNATURE", sigTag]).join(", ");
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: { product: { id: productId, status: "draft", tags } }
    });
    log("Producto bloqueado por duplicidad estructural (signature hash)", { shop, productId, sigTag, dupIds });
    return;
  }

  const materialHint = detectMaterialHint(realProduct.title, realProduct.body_html);

  const translatedTitleRaw = await translateText(realProduct.title);
  let translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);

  const titleBefore = translatedTitleRaw;
  let translatedTitle = sanitizeTextForMarketplace(translatedTitleRaw, materialHint);
  translatedHtml = sanitizeHtmlForMarketplace(translatedHtml, materialHint);

  translatedTitle = ensureNonEmptyTitle(translatedTitle, titleBefore);
  const detectedCat = detectCategory(translatedTitle);
  const tags = buildTagSetFromProduct(realProduct, [detectedCat, sigTag]).join(", ");

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
        tags,
        status: "active"
      }
    }
  });

  // Variantes: pricing + peso
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

  // Inventory fixed stock
  const locations = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/locations.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const locationId = locations.data?.locations?.[0]?.id;
  if (!locationId) throw new Error("No locations found to set inventory");

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

  log("Producto transformado (FULL)", {
    shop,
    productId,
    variants: realVariants.length,
    bannedWordsCount: getBannedWords().length
  });
}

/* ==========================
   STABLE MODE (NO toca pricing/peso/stock)
   ✅ BLOQUEO + ✅ IMAGEN fallback + ✅ traducción/sanitize + vendor/tags/status
========================== */

async function transformProductStableById(shop, accessToken, productId) {
  const freshProduct = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const realProduct = freshProduct.data.product;
  const realVariants = Array.isArray(realProduct?.variants)
    ? realProduct.variants
    : [];


  // ✅ ORIGEN AUTORIZADO (SKU PD.XXX)
  const invalidSkus = realVariants
    .map((v) => (v?.sku || "").trim())
    .filter((sku) => sku && !isValidUsadropSku(sku));

  if (invalidSkus.length) {
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: { product: { id: productId, status: "draft", tags: buildTagSetFromProduct(realProduct, ["ORIGIN_NOT_AUTHORIZED"]).join(", ") } }
    });
    log("Producto bloqueado por ORIGEN AUTORIZADO (SKU inválido)", { shop, productId, invalidSkus: invalidSkus.slice(0, 10) });
    return;
  }

  // 🔴 BLOQUEO ESTRUCTURAL
  if (isBlockedProduct(realProduct.title, realProduct.body_html)) {
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: {
        product: {
          id: productId,
          status: "draft",
          tags: buildTagSetFromProduct(realProduct, ["BLOCKED_BY_POLICY"]).join(", ")
        }
      }
    });

    log("Producto bloqueado por política marketplace (STABLE)", { shop, productId, title: realProduct.title });
    return;
  }

  // 🔴 IMAGEN fallback si no trae
  await ensureMainImage(shop, accessToken, productId, realProduct);

  const materialHint = detectMaterialHint(realProduct.title, realProduct.body_html);

  const translatedTitleRaw = await translateText(realProduct.title);
  let translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);

  const titleBefore = translatedTitleRaw;
  let translatedTitle = sanitizeTextForMarketplace(translatedTitleRaw, materialHint);
  translatedHtml = sanitizeHtmlForMarketplace(translatedHtml, materialHint);

  translatedTitle = ensureNonEmptyTitle(translatedTitle, titleBefore);
  const detectedCat = detectCategory(translatedTitle);
  const tags = buildTagSetFromProduct(realProduct, [detectedCat]).join(", ");

  // ✅ OJO: NO toca variants / NO toca inventory / NO toca pricing / NO toca peso
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
        tags,
        status: "active"
      }
    }
  });

  log("Producto transformado (STABLE)", { shop, productId });
}

/* ==========================
   CLEAN ONLY (rechazos Nelo)
   SOLO title + body_html
   NO toca pricing/peso/stock
   ✅ BLOQUEO + ✅ IMAGEN fallback
========================== */

async function cleanProductById(shop, accessToken, productId) {
  const freshProduct = await shopifyRequest(shop, {
    method: "GET",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken }
  });

  const realProduct = freshProduct.data.product;

  // 🔴 BLOQUEO ESTRUCTURAL
  if (isBlockedProduct(realProduct.title, realProduct.body_html)) {
    await shopifyRequest(shop, {
      method: "PUT",
      url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
      headers: { "X-Shopify-Access-Token": accessToken },
      data: {
        product: {
          id: productId,
          status: "draft",
          tags: buildTagSetFromProduct(realProduct, ["BLOCKED_BY_POLICY"]).join(", ")
        }
      }
    });

    log("Producto bloqueado por política marketplace (CLEAN)", { shop, productId, title: realProduct.title });
    return;
  }

  // 🔴 IMAGEN fallback si no trae
  await ensureMainImage(shop, accessToken, productId, realProduct);

  const materialHint = detectMaterialHint(realProduct.title, realProduct.body_html);

  const translatedTitleRaw = await translateText(realProduct.title);
  let translatedHtml = await translateHtmlPreservingTags(realProduct.body_html);

  const titleBefore = translatedTitleRaw;
  let translatedTitle = sanitizeTextForMarketplace(translatedTitleRaw, materialHint);
  translatedHtml = sanitizeHtmlForMarketplace(translatedHtml, materialHint);

  translatedTitle = ensureNonEmptyTitle(translatedTitle, titleBefore);

  await shopifyRequest(shop, {
    method: "PUT",
    url: `https://${shop}/admin/api/${PRODUCT_API_VERSION}/products/${productId}.json`,
    headers: { "X-Shopify-Access-Token": accessToken },
    data: {
      product: {
        id: productId,
        title: translatedTitle,
        body_html: translatedHtml
      }
    }
  });

  log("Producto limpiado (CLEAN ONLY)", { shop, productId });
}

/* ==========================
   WEBHOOK: PRODUCTS CREATE (FULL)
========================== */

app.post("/webhook/products-create", async (req, res) => {
  res.status(200).send("ok");

  const shop = req.headers["x-shopify-shop-domain"];
  if (!shop) return;

  const productId = req.body?.id;
  if (!productId) return;

  enqueueShopJob(shop, "products-create(FULL)", async () => {
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
   RECONCILE (manual por product_ids) - CLEAN ONLY
   Body: { shop, product_ids:[...] }
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
      enqueueShopJob(shop, "reconcile(CLEAN)", async () => {
        const accessToken = await getToken(shop);
        await cleanProductById(shop, accessToken, pid);
      });
    });

    return res.json({ ok: true, queued: product_ids.length });
  } catch (err) {
    console.error("reconcile error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   RECONCILE BY SKUS - CLEAN ONLY
   Body: { shop, skus:[...] }
========================== */

app.post("/reconcile-by-skus", async (req, res) => {
  try {
    const { shop, skus } = req.body || {};
    if (!shop || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop: 'xxx.myshopify.com', skus: ['SKU1','SKU2'] }"
      });
    }

    const accessToken = await getToken(shop);
    const productIds = await findProductIdsBySkus(shop, accessToken, skus);

    if (productIds.length === 0) {
      return res.json({ ok: true, queued: 0, note: "No se encontraron productos en Shopify para esos SKUs" });
    }

    productIds.forEach(pid => {
      enqueueShopJob(shop, "reconcile-by-skus(CLEAN)", async () => {
        const token = await getToken(shop);
        await cleanProductById(shop, token, pid);
      });
    });

    return res.json({ ok: true, queued: productIds.length, product_ids: productIds });
  } catch (err) {
    console.error("reconcile-by-skus error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   FORCE FULL MANUAL
   Body: { shop, product_id }
   Ejecuta transformProductById (FULL)
========================== */

app.post("/force-full", async (req, res) => {
  try {
    const { shop, product_id } = req.body || {};

    if (!shop || !product_id) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop: 'xxx.myshopify.com', product_id: 1234567890 }"
      });
    }

    enqueueShopJob(shop, "force-full(FULL)", async () => {
      const accessToken = await getToken(shop);
      await transformProductById(shop, accessToken, product_id);
    });

    return res.json({ ok: true, queued: product_id });
  } catch (err) {
    console.error("force-full error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   FORCE FULL BY SKUS
   Body: { shop, skus:[...] }
========================== */

app.post("/force-full-by-skus", async (req, res) => {
  try {
    const { shop, skus } = req.body || {};

    if (!shop || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop, skus: ['PD.77','PD.714'] }"
      });
    }

    const accessToken = await getToken(shop);
    const productIds = await findProductIdsBySkus(shop, accessToken, skus);

    if (productIds.length === 0) {
      return res.json({ ok: true, queued: 0, note: "No se encontraron productos para esos SKUs" });
    }

    productIds.forEach(pid => {
      enqueueShopJob(shop, "force-full-by-skus(FULL)", async () => {
        const token = await getToken(shop);
        await transformProductById(shop, token, pid);
      });
    });

    return res.json({ ok: true, queued: productIds.length, product_ids: productIds });
  } catch (err) {
    console.error("force-full-by-skus error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   FORCE STABLE (NO pricing/peso/stock)
   Body: { shop, product_id }
========================== */

app.post("/force-stable", async (req, res) => {
  try {
    const { shop, product_id } = req.body || {};

    if (!shop || !product_id) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop: 'xxx.myshopify.com', product_id: 1234567890 }"
      });
    }

    enqueueShopJob(shop, "force-stable(STABLE)", async () => {
      const accessToken = await getToken(shop);
      await transformProductStableById(shop, accessToken, product_id);
    });

    return res.json({ ok: true, queued: product_id });
  } catch (err) {
    console.error("force-stable error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ==========================
   FORCE STABLE BY SKUS (NO pricing/peso/stock)
   Body: { shop, skus:[...] }
========================== */

app.post("/force-stable-by-skus", async (req, res) => {
  try {
    const { shop, skus } = req.body || {};

    if (!shop || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        ok: false,
        error: "Body requerido: { shop, skus: ['PD.77','PD.714'] }"
      });
    }

    const accessToken = await getToken(shop);
    const productIds = await findProductIdsBySkus(shop, accessToken, skus);

    if (productIds.length === 0) {
      return res.json({ ok: true, queued: 0, note: "No se encontraron productos para esos SKUs" });
    }

    productIds.forEach(pid => {
      enqueueShopJob(shop, "force-stable-by-skus(STABLE)", async () => {
        const token = await getToken(shop);
        await transformProductStableById(shop, token, pid);
      });
    });

    return res.json({ ok: true, queued: productIds.length, product_ids: productIds });
  } catch (err) {
    console.error("force-stable-by-skus error:", err.response?.data || err.message);
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
  res.json({
    ok: true,
    time: nowIso(),
    shopsInMemory: shopQueues.size,
    bannedWordsCount: getBannedWords().length,
    version: "zeus-transformer-v1.5.1-image-htmlfp-dedup"
  });
});

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initDB();
});
