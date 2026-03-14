import express from "express";
import cors from "cors";
import multer from "multer";
import { createReadStream, readFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
// x402 Payment Middleware (simulated for demo)
// In production: use @x402/express paymentMiddleware
// with a real Coinbase CDP wallet address
// ─────────────────────────────────────────────

const PRICE_PER_PAGE   = 0.05;   // $0.05 USDC per page
const PRICE_PER_1K     = 0.02;   // $0.02 USDC per 1k words
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS || "0xYourWalletAddressHere";
const NETWORK          = process.env.NETWORK          || "base-sepolia";

/**
 * Simulated x402 payment verification.
 * In production this calls the Coinbase facilitator at
 * https://x402.org/facilitator to verify the on-chain tx.
 */
function verifyX402Payment(req, expectedAmountUSDC) {
  const paymentHeader = req.headers["x-payment"];
  if (!paymentHeader) return { valid: false, reason: "missing_payment" };

  try {
    const payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
    // Real check: payment.network === NETWORK && payment.amount >= expectedAmountUSDC
    // && verify signature via facilitator API
    if (payment && payment.txHash && payment.amount >= expectedAmountUSDC) {
      return { valid: true };
    }
    return { valid: false, reason: "insufficient_payment" };
  } catch {
    return { valid: false, reason: "invalid_payment_header" };
  }
}

/**
 * Build a 402 Payment Required response body following x402 spec.
 */
function build402Response(amountUSDC, description, path) {
  return {
    x402Version: 1,
    error: "Payment Required",
    accepts: [
      {
        scheme: "exact",
        network: NETWORK,
        maxAmountRequired: String(Math.round(amountUSDC * 1_000_000)), // USDC 6-decimal
        resource: `${process.env.SERVER_URL || "http://localhost:3001"}${path}`,
        description,
        mimeType: "application/json",
        payTo: MERCHANT_ADDRESS,
        maxTimeoutSeconds: 300,
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
        extra: {
          name: "USDC",
          version: "2",
        },
      },
    ],
  };
}

// ─────────────────────────────────────────────
// Utility: count pages & words from text
// ─────────────────────────────────────────────

function analyzeText(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  // Approximate: ~250 words per page
  const pages = Math.max(1, Math.ceil(words / 250));
  return { words, pages };
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "1.0.0",
    pricing: {
      perPage: `$${PRICE_PER_PAGE} USDC`,
      per1kWords: `$${PRICE_PER_1K} USDC`,
    },
    network: NETWORK,
    merchant: MERCHANT_ADDRESS,
  });
});

// Step 1: Upload doc and get pricing quote (free)
app.post("/quote", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No document uploaded" });

  try {
    const text = await extractText(req.file);

    // Clean up temp file
    try { unlinkSync(req.file.path); } catch {}

    const { words, pages } = analyzeText(text);
    const costByPage  = pages * PRICE_PER_PAGE;
    const costByWords = (words / 1000) * PRICE_PER_1K;

    res.json({
      filename: req.file.originalname,
      stats: { words, pages },
      pricing: {
        byPage:  { amount: costByPage.toFixed(4),  label: `${pages} pages × $${PRICE_PER_PAGE}` },
        byWords: { amount: costByWords.toFixed(4), label: `${Math.ceil(words / 1000)}k words × $${PRICE_PER_1K}` },
      },
      currency: "USDC",
      network: NETWORK,
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to analyze document", details: err.message });
  }
});

// Step 2: Summarize — protected by x402
app.post("/summarize", upload.single("document"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No document uploaded" });

  let text = "";
  try {
    text = await extractText(req.file);
    try { unlinkSync(req.file.path); } catch {}
  } catch (err) {
    return res.status(500).json({ error: "Failed to read document" });
  }

  const { words, pages } = analyzeText(text);
  const pricingMode = req.headers["x-pricing-mode"] || "page";
  const amountDue   = pricingMode === "words"
    ? parseFloat(((words / 1000) * PRICE_PER_1K).toFixed(6))
    : parseFloat((pages * PRICE_PER_PAGE).toFixed(6));

  // ── x402 Check ──────────────────────────────
  const { valid, reason } = verifyX402Payment(req, amountDue);

  if (!valid) {
    const description = pricingMode === "words"
      ? `Summarize ${words} words ($${PRICE_PER_1K}/1k words)`
      : `Summarize ${pages} pages ($${PRICE_PER_PAGE}/page)`;

    return res.status(402)
      .set("Content-Type", "application/json")
      .set("X-Payment-Required", "true")
      .json(build402Response(amountDue, description, "/summarize"));
  }
  // ── Payment verified — process request ───────

  const summary = generateSummary(text, { words, pages });

  res.json({
    success: true,
    filename: req.file?.originalname || "document",
    stats: { words, pages },
    amountCharged: amountDue,
    currency: "USDC",
    pricingMode,
    summary,
  });
});

// ─────────────────────────────────────────────
// Text extraction (PDF / TXT / plain)
// ─────────────────────────────────────────────

async function extractText(file) {
  const mime = file.mimetype || "";
  const data = readFileSync(file.path);

  if (mime === "application/pdf" || file.originalname?.endsWith(".pdf")) {
    // Dynamic import of pdf-parse to avoid ESM issues
    const pdfParse = (await import("pdf-parse")).default;
    const result   = await pdfParse(data);
    return result.text;
  }

  // Fallback: treat as plain text
  return data.toString("utf-8");
}

// ─────────────────────────────────────────────
// Summary generator (uses Claude API internally)
// ─────────────────────────────────────────────

async function generateSummary(text, { words, pages }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Fallback: deterministic summary for demo
    return buildFallbackSummary(text, { words, pages });
  }

  try {
    const truncated = text.slice(0, 12000); // stay within token limits
    const response  = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 800,
        messages: [
          {
            role: "user",
            content: `Please summarize the following document in 3-5 concise paragraphs. 
Include: main topic, key points, and conclusions.\n\n---\n${truncated}`,
          },
        ],
      }),
    });

    const json = await response.json();
    return json.content?.[0]?.text || buildFallbackSummary(text, { words, pages });
  } catch {
    return buildFallbackSummary(text, { words, pages });
  }
}

function buildFallbackSummary(text, { words, pages }) {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40)
    .slice(0, 8);

  return [
    `This document contains approximately ${words} words across ${pages} page${pages !== 1 ? "s" : ""}.`,
    sentences.slice(0, 3).join(". ") + ".",
    sentences.slice(3, 6).join(". ") + (sentences.length > 3 ? "." : ""),
    `The document covers ${pages} page${pages !== 1 ? "s" : ""} of content related to the above topics.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 DocPay server running on http://localhost:${PORT}`);
  console.log(`   Network:  ${NETWORK}`);
  console.log(`   Merchant: ${MERCHANT_ADDRESS}`);
  console.log(`   Pricing:  $${PRICE_PER_PAGE}/page | $${PRICE_PER_1K}/1k words\n`);
});
