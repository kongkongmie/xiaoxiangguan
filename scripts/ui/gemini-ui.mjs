import { chromium } from "playwright";
import http from "node:http";
import { boot } from "./fixture.mjs";
const out = (await import("./paths.mjs")).shots;
// Stand-in for the local relay on its real port.
const relay = http.createServer(async (req, res) => {
  let body = ""; for await (const p of req) body += p;
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ models: [{ name: "models/gemini-3-pro", displayName: "Gemini 3 Pro" }, { name: "models/gemini-3-pro-抗截断假流" }, { name: "models/gemini-3-flash" }] })); }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "连接成功" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } })}\n\n`); res.end();
});
await new Promise((r) => relay.listen(8890, "127.0.0.1", r));
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${app.base}/#/settings`); await page.click("[data-view=settings]"); await page.waitForSelector("#provider-preset");
  await page.selectOption("#provider-preset", "gemini-relay");
  await page.waitForFunction(() => [...document.querySelectorAll("#provider-model-select option")].some((o) => o.value === "gemini-3-pro"), null, { timeout: 8000 });
  await page.selectOption("#provider-model-select", "gemini-3-pro-抗截断假流");
  await page.waitForSelector("#provider-test-result.test-ok", { timeout: 8000 });
  const saved = await app.call("GET", "/api/provider");
  if (saved.protocol !== "gemini" || saved.model !== "gemini-3-pro-抗截断假流" || saved.baseUrl !== "http://127.0.0.1:8890") fail(JSON.stringify(saved));
  await page.reload(); await page.click("[data-view=settings]"); await page.waitForSelector("#provider-preset");
  if (await page.inputValue("#provider-preset") !== "gemini-relay") fail("preset not recognised after reload");
  await page.waitForTimeout(800);
  await page.locator("#provider-form").screenshot({ path: `${out}40-gemini-relay.png` });
  console.log("errors:", JSON.stringify(errors)); await browser.close();
} finally { app.stop(); relay.close(); }
