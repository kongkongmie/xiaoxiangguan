import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "./fixture.mjs";

const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  // One good run and one failing run so the task list has both.
  await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft", profileId: app.profiles[0].id });
  const port = new URL((await app.call("GET", "/api/provider")).baseUrl).port;
  await writeFile(join(app.folder, "secrets/provider.json"), JSON.stringify({ backend: "http", protocol: "openai-chat", providerName: "Mock", baseUrl: `http://127.0.0.1:${port}/v1`, model: "broken", noAuth: true }));
  const brokenProfile = (await app.call("POST", "/api/engine-profiles", { name: "过载的模型", color: "#b7801f" })).profiles.at(-1);
  await app.call("POST", "/api/books/neko/chapters/c2/translate", { mode: "draft", profileId: brokenProfile.id });
  await app.idle();

  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(app.base); await page.evaluate(() => localStorage.setItem("xxg:theme", "porcelain"));
  await page.goto(`${app.base}/#/settings`); await page.click("[data-view=settings]");
  await page.waitForSelector(".engine-chip"); await page.waitForFunction(() => document.querySelectorAll("#provider-model-select option").length > 3, null, { timeout: 8000 });
  const form = page.locator("#provider-form");
  await form.screenshot({ path: `${out}20-engine-form.png` });

  // Choosing a model tests it and saves it.
  await page.selectOption("#provider-model-select", "deepseek");
  await page.waitForSelector("#provider-test-result.test-ok", { timeout: 8000 });
  if ((await app.call("GET", "/api/provider")).model !== "deepseek") fail("model not auto-saved");
  await form.screenshot({ path: `${out}21-auto-saved.png` });

  // A failing model is reported and nothing is saved.
  await page.selectOption("#provider-model-select", "broken");
  await page.waitForSelector("#provider-test-result.test-failed", { timeout: 8000 });
  if ((await app.call("GET", "/api/provider")).model !== "deepseek") fail("failed test must not save");
  await form.screenshot({ path: `${out}22-test-failed.png` });

  // One click switches to a saved engine.
  await page.click(`[data-switch-profile="${app.profiles[2].id}"]`);
  await page.waitForSelector(`[data-switch-profile="${app.profiles[2].id}"][aria-pressed="true"]`, { timeout: 8000 });
  if ((await app.call("GET", "/api/provider")).model !== "codex") fail("switch did not activate the profile");
  await page.locator("#engine-switch").screenshot({ path: `${out}23-switched.png` });

  // Task list: engine line and details with the raw reply.
  await page.click("[data-view=tasks]"); await page.waitForSelector(".task-row");
  await page.locator(".task-row", { hasText: "失败" }).first().locator("summary").click().catch(() => page.locator(".task-details summary").first().click());
  await page.waitForTimeout(300);
  const detail = await page.locator(".task-details[open]").first().innerText();
  if (!/HTTP 状态\s*503/.test(detail) || !detail.includes("overloaded") || !detail.includes("过载的模型")) fail("task details incomplete: " + detail.slice(0, 300));
  await page.screenshot({ path: `${out}24-task-details.png`, fullPage: true });
  await page.evaluate(() => localStorage.setItem("xxg:theme", "lamplight")); await page.reload(); await page.waitForSelector(".task-row");
  await page.locator(".task-details").first().evaluate((n) => { n.open = true; }); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}25-task-details-lamplight.png`, fullPage: true });
  console.log("errors:", JSON.stringify(errors));
  await browser.close();
} finally { app.stop(); }
