# DocPay — x402 Document Summarizer

> **Pay-per-use document summarization powered by the x402 HTTP payment protocol.**
> Charge users in USDC on Base — no accounts, no subscriptions, no API keys.

```
  ██████╗  ██████╗  ██████╗    ██████╗  █████╗ ██╗   ██╗
  ██╔══██╗██╔═══██╗██╔════╝    ██╔══██╗██╔══██╗╚██╗ ██╔╝
  ██║  ██║██║   ██║██║         ██████╔╝███████║ ╚████╔╝
  ██║  ██║██║   ██║██║         ██╔═══╝ ██╔══██║  ╚██╔╝
  ██████╔╝╚██████╔╝╚██████╗    ██║     ██║  ██║   ██║
  ╚═════╝  ╚═════╝  ╚═════╝    ╚═╝     ╚═╝  ╚═╝   ╚═╝
```

## What is x402?

x402 activates the long-dormant **HTTP 402 "Payment Required"** status code to enable
instant, blockchain-native micropayments directly inside HTTP — no accounts, no billing
dashboards, no credit cards.

**The flow:**
```
Client → POST /summarize
          ↓
Server ← 402 Payment Required  { amount, network, payTo, asset }
          ↓
Client   signs & sends USDC on Base
          ↓
Client → POST /summarize  +  X-Payment: <signed-tx>
          ↓
Server ← 200 OK  { summary, stats, amountCharged }
```

---

## Project Structure

```
docpay/
├── server/          Express API with x402 payment middleware
│   ├── index.js     Server entry point
│   ├── .env.example Environment variables
│   └── package.json
├── cli/
│   └── cli.js       Command-line client (full x402 flow demo)
├── web/
│   └── index.html   Beautiful single-file WebApp
└── README.md
```

---

## Quick Start

### 1. Server

```bash
cd server
cp .env.example .env
# Edit .env — add your wallet address and Anthropic key
npm install
npm start
# → Running on http://localhost:3001
```

### 2. Web App

Open `web/index.html` in your browser (or serve it):

```bash
npx serve web/
# → http://localhost:3000
```

### 3. CLI

```bash
# Get a price quote (free)
node cli/cli.js quote ./my-report.pdf

# Summarize with per-page pricing
node cli/cli.js summarize ./my-report.pdf --mode page

# Summarize with per-word pricing
node cli/cli.js summarize ./my-report.pdf --mode words
```

---

## Pricing

| Mode       | Price        | Example                        |
|------------|-------------|--------------------------------|
| Per page   | $0.05 USDC  | 10-page PDF = $0.50 USDC       |
| Per 1k words| $0.02 USDC | 5,000 words = $0.10 USDC       |

Change in `server/index.js`:
```js
const PRICE_PER_PAGE = 0.05;   // $0.05 USDC per page
const PRICE_PER_1K   = 0.02;   // $0.02 USDC per 1k words
```

---

## Environment Variables

```env
# Your EVM wallet address (receives USDC payments)
MERCHANT_ADDRESS=0xYourAddressHere

# base-mainnet | base-sepolia (testnet)
NETWORK=base-sepolia

# Public URL of this server
SERVER_URL=http://localhost:3001

# Anthropic API key (optional — falls back to extractive summary)
ANTHROPIC_API_KEY=sk-ant-...
```

---

## x402 Integration Details

### Server (Express middleware)

The server implements the x402 protocol manually for full transparency.
For production, use the official `@x402/express` package:

```js
import { paymentMiddleware } from '@x402/express';

app.use(paymentMiddleware({
  'POST /summarize': {
    accepts: [{
      scheme: 'exact',
      network: 'base-mainnet',
      maxAmountRequired: '50000',   // $0.05 USDC (6 decimals)
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
      payTo: process.env.MERCHANT_ADDRESS,
    }],
    description: 'Document summarization — $0.05/page',
  },
}));
```

### Client (fetch wrapper)

For production clients use `@x402/fetch`:

```js
import { wrapFetchWithPayment } from '@x402/fetch';
import { createWalletClient } from 'viem';

const wallet = createWalletClient({ ... }); // your wallet
const fetchWithPayment = wrapFetchWithPayment(fetch, wallet);

// Automatically handles 402 → sign → retry
const res = await fetchWithPayment('http://localhost:3001/summarize', {
  method: 'POST',
  body: formData,
});
```

### 402 Response Schema (x402 V1)

```json
{
  "x402Version": 1,
  "error": "Payment Required",
  "accepts": [{
    "scheme": "exact",
    "network": "base-sepolia",
    "maxAmountRequired": "50000",
    "resource": "http://localhost:3001/summarize",
    "description": "Summarize 12 pages ($0.05/page)",
    "mimeType": "application/json",
    "payTo": "0xMerchantAddress",
    "maxTimeoutSeconds": 300,
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
  }]
}
```

---

## API Reference

### `GET /health`
Returns server status, pricing, and network info.

### `POST /quote`
**Free** — analyze a document and return pricing info.

| Field | Type | Description |
|-------|------|-------------|
| `document` | `File` | PDF or text document |

**Response:**
```json
{
  "filename": "report.pdf",
  "stats": { "words": 3200, "pages": 13 },
  "pricing": {
    "byPage":  { "amount": "0.6500", "label": "13 pages × $0.05" },
    "byWords": { "amount": "0.0640", "label": "4k words × $0.02" }
  }
}
```

### `POST /summarize`
**Paid** — requires x402 payment.

| Header | Description |
|--------|-------------|
| `x-pricing-mode` | `page` (default) or `words` |
| `x-payment` | Base64-encoded signed payment (after 402) |

**Without payment → 402:**
```json
{
  "x402Version": 1,
  "error": "Payment Required",
  "accepts": [...]
}
```

**With valid payment → 200:**
```json
{
  "success": true,
  "stats": { "words": 3200, "pages": 13 },
  "amountCharged": 0.65,
  "currency": "USDC",
  "summary": "This document examines..."
}
```

---

## Going to Production

1. **Real wallet**: Use `viem` or `ethers.js` to sign payments with a real private key
2. **Mainnet USDC**: Switch `NETWORK=base-mainnet` and use mainnet USDC address
3. **Facilitator**: Register with the [Coinbase CDP facilitator](https://x402.org) for on-chain settlement verification
4. **SSL**: Put the server behind HTTPS (required for x402 in production)
5. **Official SDK**: Replace the manual middleware with `@x402/express`

---

## Stack

- **Server**: Node.js · Express · `pdf-parse` · `@x402/express`
- **CLI**: Pure Node.js · no runtime deps
- **Web**: Vanilla HTML/CSS/JS (zero build step)
- **Payments**: x402 protocol · USDC · Base (Coinbase L2)
- **AI**: Claude Haiku via Anthropic API (optional)

---

## License

MIT — built with ❤️ using [x402](https://x402.org) by Coinbase
