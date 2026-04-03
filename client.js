import { chromium } from "playwright-core";
import WebSocket from "ws";
import { appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ──
const JARVIS_URL = process.env.JARVIS_BRIDGE_URL || "";
const AUTH_TOKEN = process.env.JARVIS_BRIDGE_TOKEN;
const CDP_URL = process.env.CDP_URL || "http://localhost:9222";
const AUDIT_LOG = join(__dirname, "audit.log");
const CMD_TIMEOUT = 30_000;
const MAX_RECONNECT_DELAY = 30_000;

if (!AUTH_TOKEN) {
  console.error("[bridge] JARVIS_BRIDGE_TOKEN env var is required");
  process.exit(1);
}
if (!JARVIS_URL) {
  console.error("[bridge] JARVIS_BRIDGE_URL env var is required (e.g. wss://jarvis-zmann.zocomputer.io/bridge)");
  process.exit(1);
}

let browser = null;
let ws = null;
let reconnectDelay = 1000;
let shuttingDown = false;

// ── Chrome CDP ──
async function connectBrowser() {
  if (browser?.isConnected()) return browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    console.log("[bridge] Connected to Chrome CDP at", CDP_URL);
    return browser;
  } catch (err) {
    console.error("[bridge] Failed to connect to Chrome CDP:", err.message);
    browser = null;
    throw new Error(`Chrome CDP unavailable at ${CDP_URL}. Is Chrome running with --remote-debugging-port=9222?`);
  }
}

async function getActivePage() {
  const b = await connectBrowser();
  const contexts = b.contexts();
  if (contexts.length === 0) throw new Error("No browser contexts available");
  const pages = contexts[0].pages();
  if (pages.length === 0) throw new Error("No pages open");
  return pages[pages.length - 1];
}

function audit(action, url, status, ms) {
  const entry = JSON.stringify({ ts: new Date().toISOString(), action, url: url || null, status, ms });
  try { appendFileSync(AUDIT_LOG, entry + "\n"); } catch {}
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function extractText(page) {
  const text = await page.evaluate(() => {
    const sel = ["script", "style", "noscript", "svg", "iframe"];
    sel.forEach(s => document.querySelectorAll(s).forEach(el => el.remove()));

    function walk(node) {
      if (node.nodeType === 3) return node.textContent.trim();
      if (node.nodeType !== 1) return "";
      const tag = node.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) return "";
      const children = Array.from(node.childNodes).map(walk).filter(Boolean);
      const block = ["div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "section", "article", "header", "footer", "main", "blockquote"];
      if (block.includes(tag)) return children.join(" ") + "\n";
      return children.join(" ");
    }

    return walk(document.body)
      .split("\n")
      .map(l => l.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  });
  return text.slice(0, 15000);
}

// ── Command Handler ──
async function handleCommand(cmd) {
  const { id, action } = cmd;
  const start = Date.now();

  try {
    switch (action) {
      case "navigate_and_extract": {
        const { url, extract = "text" } = cmd;
        if (!url) throw new Error("url is required for navigate_and_extract");

        send({ id, type: "progress", message: `Navigating to ${url}...` });
        const page = await getActivePage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1500);
        send({ id, type: "progress", message: "Page loaded, extracting content..." });

        const title = await page.title();
        const result = { id, type: "result", url: page.url(), title };

        if (extract === "text" || extract === "both") {
          result.content = await extractText(page);
        }
        if (extract === "screenshot" || extract === "both") {
          const buf = await page.screenshot({ type: "png", fullPage: false });
          result.screenshot = buf.toString("base64");
        }

        audit(action, url, "ok", Date.now() - start);
        send(result);
        break;
      }

      case "interact": {
        const { steps = [] } = cmd;
        if (!steps.length) throw new Error("steps array is required for interact");
        const page = await getActivePage();

        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          send({ id, type: "progress", message: `Step ${i + 1}/${steps.length}: ${step.type} ${step.selector || ""}` });

          switch (step.type) {
            case "click":
              await page.click(step.selector, { timeout: 5000 });
              break;
            case "type":
              await page.fill(step.selector, step.text || "", { timeout: 5000 });
              break;
            case "scroll":
              await page.evaluate((dir) => {
                const amount = 500;
                if (dir === "up") window.scrollBy(0, -amount);
                else if (dir === "down") window.scrollBy(0, amount);
                else if (dir === "left") window.scrollBy(-amount, 0);
                else if (dir === "right") window.scrollBy(amount, 0);
                else window.scrollBy(0, amount);
              }, step.direction || "down");
              break;
            case "wait":
              await page.waitForTimeout(step.ms || 1000);
              break;
          }
        }

        const title = await page.title();
        const content = await extractText(page);
        audit(action, page.url(), "ok", Date.now() - start);
        send({ id, type: "result", url: page.url(), title, content });
        break;
      }

      case "get_tabs": {
        const b = await connectBrowser();
        const tabs = [];
        for (const ctx of b.contexts()) {
          for (const page of ctx.pages()) {
            tabs.push({ url: page.url(), title: await page.title() });
          }
        }
        audit(action, null, "ok", Date.now() - start);
        send({ id, type: "result", tabs });
        break;
      }

      case "screenshot": {
        const page = await getActivePage();
        const buf = await page.screenshot({ type: "png", fullPage: false });
        const title = await page.title();
        audit(action, page.url(), "ok", Date.now() - start);
        send({ id, type: "result", url: page.url(), title, screenshot: buf.toString("base64") });
        break;
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } catch (err) {
    audit(action, cmd.url, "error", Date.now() - start);
    send({ id, type: "error", message: err.message });
  }
}

// ── WebSocket Client (connects outbound to Jarvis on Zo) ──
function connect() {
  if (shuttingDown) return;

  console.log(`[bridge] Connecting to ${JARVIS_URL}...`);
  ws = new WebSocket(JARVIS_URL);

  ws.on("open", () => {
    console.log("[bridge] Connected, authenticating...");
    ws.send(JSON.stringify({ type: "auth", token: AUTH_TOKEN }));
  });

  ws.on("message", async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === "auth") {
      if (msg.status === "ok") {
        reconnectDelay = 1000;
        console.log("[bridge] Authenticated — ready for commands");
      } else {
        console.error("[bridge] Auth failed:", msg.message);
        ws.close();
      }
      return;
    }

    if (msg.type === "error" && !msg.id) {
      console.error("[bridge] Server error:", msg.message);
      return;
    }

    if (msg.id && msg.action) {
      const timeout = setTimeout(() => {
        send({ id: msg.id, type: "error", message: "Command timeout (30s)" });
      }, CMD_TIMEOUT);

      try {
        await handleCommand(msg);
      } finally {
        clearTimeout(timeout);
      }
    }
  });

  ws.on("close", () => {
    console.log("[bridge] Disconnected");
    ws = null;
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("[bridge] Connection error:", err.message);
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  console.log(`[bridge] Reconnecting in ${reconnectDelay / 1000}s...`);
  setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

// ── Startup ──
console.log("[bridge] Jarvis Browser Bridge (reverse connection mode)");
console.log(`[bridge] Target: ${JARVIS_URL}`);
console.log(`[bridge] Chrome CDP: ${CDP_URL}`);
connect();

process.on("SIGTERM", () => { shuttingDown = true; ws?.close(); process.exit(0); });
process.on("SIGINT", () => { shuttingDown = true; ws?.close(); process.exit(0); });
