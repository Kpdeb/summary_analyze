#!/usr/bin/env node
/**
 * DocPay CLI — x402-powered document summarizer
 *
 * Usage:
 *   node cli.js summarize ./report.pdf [--mode page|words]
 *   node cli.js quote     ./report.pdf
 *   node cli.js help
 *
 * The CLI simulates the full x402 payment handshake:
 *   1. POST /summarize  → receives 402 with payment terms
 *   2. "Sign" the payment (mock wallet — real impl uses viem/ethers)
 *   3. Retry POST /summarize with X-Payment header
 *   4. Display summary
 */

import { readFileSync, existsSync } from "fs";
import { basename, extname } from "path";
import { createHash, randomBytes } from "crypto";

const SERVER = process.env.DOCPAY_SERVER || "http://localhost:3001";

// ── ANSI colours ──────────────────────────────
const c = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  magenta:"\x1b[35m",
};
const bold   = (s) => `${c.bold}${s}${c.reset}`;
const dim    = (s) => `${c.dim}${s}${c.reset}`;
const cyan   = (s) => `${c.cyan}${s}${c.reset}`;
const green  = (s) => `${c.green}${s}${c.reset}`;
const yellow = (s) => `${c.yellow}${s}${c.reset}`;
const red    = (s) => `${c.red}${s}${c.reset}`;
const blue   = (s) => `${c.blue}${s}${c.reset}`;
const magenta= (s) => `${c.magenta}${s}${c.reset}`;

// ── Logo ──────────────────────────────────────
function logo() {
  console.log();
  console.log(bold(cyan("  ██████╗  ██████╗  ██████╗    ██████╗  █████╗ ██╗   ██╗")));
  console.log(bold(cyan(" ██╔══██╗██╔═══██╗██╔════╝    ██╔══██╗██╔══██╗╚██╗ ██╔╝")));
  console.log(bold(cyan(" ██║  ██║██║   ██║██║         ██████╔╝███████║ ╚████╔╝ ")));
  console.log(bold(cyan(" ██║  ██║██║   ██║██║         ██╔═══╝ ██╔══██║  ╚██╔╝  ")));
  console.log(bold(cyan(" ██████╔╝╚██████╔╝╚██████╗    ██║     ██║  ██║   ██║   ")));
  console.log(bold(cyan(" ╚═════╝  ╚═════╝  ╚═════╝    ╚═╝     ╚═╝  ╚═╝   ╚═╝   ")));
  console.log();
  console.log(dim("  x402-powered document summarization · pay-per-use\n"));
}

// ── Spinner ───────────────────────────────────
function spinner(msg) {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];
  let i = 0;
  const id = setInterval(() => {
    process.stdout.write(`\r  ${cyan(frames[i++ % frames.length])} ${msg}`);
  }, 80);
  return () => {
    clearInterval(id);
    process.stdout.write("\r" + " ".repeat(60) + "\r");
  };
}

// ── Build multipart form body ─────────────────
function buildFormData(filePath, pricingMode) {
  const boundary = `----DocPayBoundary${randomBytes(8).toString("hex")}`;
  const fileData  = readFileSync(filePath);
  const filename  = basename(filePath);
  const mime      = extname(filename).toLowerCase() === ".pdf"
    ? "application/pdf"
    : "text/plain";

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ── Mock wallet: sign x402 payment ───────────
function mockSignPayment(paymentTerms, pricingMode) {
  /**
   * Real implementation would:
   *   1. Import viem/ethers wallet
   *   2. Sign the EIP-712 typed data from paymentTerms
   *   3. Submit the signed tx to the blockchain
   * 
   * Here we simulate a signed payment header for demo purposes.
   */
  const accept  = paymentTerms.accepts[0];
  const mockTx  = {
    txHash:  "0x" + randomBytes(32).toString("hex"),
    network: accept.network,
    amount:  parseFloat(accept.maxAmountRequired) / 1_000_000,
    asset:   accept.asset,
    payTo:   accept.payTo,
    paidAt:  new Date().toISOString(),
  };
  return Buffer.from(JSON.stringify(mockTx)).toString("base64");
}

// ── Command: quote ────────────────────────────
async function cmdQuote(filePath) {
  if (!existsSync(filePath)) {
    console.error(red(`  ✗ File not found: ${filePath}`));
    process.exit(1);
  }

  const stop = spinner("Analyzing document…");
  const { body, contentType } = buildFormData(filePath, "page");

  const res  = await fetch(`${SERVER}/quote`, {
    method:  "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  stop();

  if (!res.ok) {
    console.error(red(`  ✗ Server error: ${res.status}`));
    process.exit(1);
  }

  const data = await res.json();

  console.log(`\n  ${bold("📄 Document Quote")}\n`);
  console.log(`  File    : ${cyan(data.filename)}`);
  console.log(`  Words   : ${bold(data.stats.words.toLocaleString())}`);
  console.log(`  Pages   : ${bold(data.stats.pages)}`);
  console.log();
  console.log(`  ${bold("Pricing Options:")}`);
  console.log(`  ${green("●")} By page  : ${bold(yellow("$" + data.pricing.byPage.amount))} USDC  (${dim(data.pricing.byPage.label)})`);
  console.log(`  ${blue("●")} By words : ${bold(yellow("$" + data.pricing.byWords.amount))} USDC  (${dim(data.pricing.byWords.label)})`);
  console.log(`\n  Network: ${dim(data.network)}\n`);
}

// ── Command: summarize ────────────────────────
async function cmdSummarize(filePath, mode = "page") {
  if (!existsSync(filePath)) {
    console.error(red(`  ✗ File not found: ${filePath}`));
    process.exit(1);
  }

  console.log(`\n  ${bold("🔁 x402 Payment Flow")}\n`);
  console.log(`  ${dim("Step 1 — Initial request (no payment yet)…")}`);

  // ── Round 1: expect 402 ───────────────────────
  let stop = spinner("Sending request to server…");
  const { body: body1, contentType: ct1 } = buildFormData(filePath, mode);

  const res1 = await fetch(`${SERVER}/summarize`, {
    method:  "POST",
    headers: { "Content-Type": ct1, "x-pricing-mode": mode },
    body:    body1,
  });
  stop();

  if (res1.status !== 402) {
    // Unexpected — maybe server config
    const data = await res1.json();
    if (data.summary) return printResult(data);
    console.error(red(`  ✗ Unexpected response: ${res1.status}`));
    process.exit(1);
  }

  const paymentTerms = await res1.json();
  const accept       = paymentTerms.accepts[0];
  const amountUSDC   = (parseFloat(accept.maxAmountRequired) / 1_000_000).toFixed(4);

  // ── Show 402 details ─────────────────────────
  console.log(`\n  ${yellow("⚡ 402 Payment Required")}\n`);
  console.log(`  ${dim("The server responded with x402 payment terms:")}`);
  console.log(`  Amount   : ${bold(yellow(`$${amountUSDC} USDC`))}`);
  console.log(`  Network  : ${cyan(accept.network)}`);
  console.log(`  Pay to   : ${dim(accept.payTo)}`);
  console.log(`  Timeout  : ${dim(accept.maxTimeoutSeconds + "s")}`);
  console.log(`  Purpose  : ${dim(accept.description)}`);

  // ── Mock wallet sign ─────────────────────────
  console.log(`\n  ${dim("Step 2 — Wallet signing payment…")}`);
  stop = spinner("Signing transaction with wallet…");
  await sleep(600); // simulate signing latency
  const paymentHeader = mockSignPayment(paymentTerms, mode);
  stop();
  console.log(`  ${green("✔")} Payment signed  ${dim("(mock wallet — demo mode)")}`);

  // ── Round 2: with payment header ─────────────
  console.log(`\n  ${dim("Step 3 — Retrying request with X-Payment header…")}`);
  stop = spinner("Sending payment & fetching summary…");
  const { body: body2, contentType: ct2 } = buildFormData(filePath, mode);

  const res2 = await fetch(`${SERVER}/summarize`, {
    method:  "POST",
    headers: {
      "Content-Type":    ct2,
      "x-pricing-mode":  mode,
      "x-payment":       paymentHeader,
    },
    body: body2,
  });
  stop();

  if (!res2.ok) {
    const err = await res2.json();
    console.error(red(`\n  ✗ Payment failed: ${err.error || res2.status}`));
    process.exit(1);
  }

  const data = await res2.json();
  console.log(`  ${green("✔")} Payment accepted  ${dim(`tx: 0x…${JSON.parse(Buffer.from(paymentHeader, "base64").toString()).txHash.slice(-8)}`)}`);

  printResult(data);
}

function printResult(data) {
  console.log(`\n  ${"─".repeat(56)}`);
  console.log(`\n  ${bold("📋 Summary")}\n`);
  console.log(`  ${cyan("File   :")} ${data.filename}`);
  console.log(`  ${cyan("Words  :")} ${data.stats.words.toLocaleString()}`);
  console.log(`  ${cyan("Pages  :")} ${data.stats.pages}`);
  console.log(`  ${cyan("Charged:")} ${bold(green("$" + data.amountCharged))} USDC  (${dim(data.pricingMode + " pricing")})\n`);
  console.log(`  ${"─".repeat(56)}\n`);

  // Word-wrap summary at ~70 chars
  const lines = data.summary.split("\n");
  for (const line of lines) {
    if (!line.trim()) { console.log(); continue; }
    const wrapped = wordWrap(line, 68);
    for (const wl of wrapped) console.log(`  ${wl}`);
  }

  console.log(`\n  ${"─".repeat(56)}\n`);
  console.log(`  ${green("✔")} Done. ${dim("Payment settled on " + data.currency + " (" + (data.network || "base-sepolia") + ")")}\n`);
}

function wordWrap(str, width) {
  const words  = str.split(" ");
  const lines  = [];
  let   current = "";
  for (const w of words) {
    if ((current + " " + w).trim().length <= width) {
      current = (current + " " + w).trim();
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Help ──────────────────────────────────────
function help() {
  logo();
  console.log(`  ${bold("Usage:")}\n`);
  console.log(`  ${cyan("node cli.js summarize")} <file> ${dim("[--mode page|words]")}`);
  console.log(`    Summarize a document via x402 pay-per-use\n`);
  console.log(`  ${cyan("node cli.js quote")} <file>`);
  console.log(`    Get a price quote without paying\n`);
  console.log(`  ${bold("Options:")}\n`);
  console.log(`  ${dim("--mode page")}    Charge $0.05 per page ${dim("(default)")}`);
  console.log(`  ${dim("--mode words")}   Charge $0.02 per 1k words\n`);
  console.log(`  ${bold("Environment:")}\n`);
  console.log(`  ${dim("DOCPAY_SERVER")}  Server URL ${dim("(default: http://localhost:3001)")}`);
  console.log(`  ${dim("WALLET_KEY")}     Private key for real x402 payments\n`);
  console.log(`  ${bold("Examples:")}\n`);
  console.log(`  ${dim("$")} node cli.js quote ./report.pdf`);
  console.log(`  ${dim("$")} node cli.js summarize ./paper.txt --mode words`);
  console.log(`  ${dim("$")} DOCPAY_SERVER=https://api.example.com node cli.js summarize ./doc.pdf\n`);
}

// ── Main ──────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd  = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    help();
    return;
  }

  logo();

  const file = args[1];
  const mode = args.includes("--mode") ? args[args.indexOf("--mode") + 1] : "page";

  try {
    if (cmd === "quote") {
      await cmdQuote(file);
    } else if (cmd === "summarize") {
      await cmdSummarize(file, mode);
    } else {
      console.error(red(`  ✗ Unknown command: ${cmd}\n`));
      help();
      process.exit(1);
    }
  } catch (err) {
    console.error(red(`\n  ✗ Error: ${err.message}\n`));
    process.exit(1);
  }
}

main();
