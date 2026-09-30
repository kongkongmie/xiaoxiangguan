// "继续翻译" asks which engine takes over, and the chosen profile finishes the chapter.
import { chromium } from "playwright";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boot } from "./fixture.mjs";
const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  const port = new URL((await app.call("GET", "/api/provider")).baseUrl).port;
  await writeFile(join(app.folder, "secrets/provider.json"), JSON.stringify({ backend: "http", protocol: "openai-chat", providerName: "Mock", baseUrl: `http://127.0.0.1:${port}/v1`, model: "broken", noAuth: true }));
  await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft" }); await app.idle();
  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.base); await page.click("[data-view=tasks]");
  await page.click("[data-task-retry]"); await page.waitForSelector("dialog.batch-dialog[open]");
  const lead = await page.locator(".batch-lead").innerText(); if (!lead.includes("从头开始")) fail("lead: " + lead);
  await page.locator(".batch-engine", { hasText: "阿澈 · Codex" }).click();
  await page.locator("dialog.batch-dialog").screenshot({ path: `${out}80-relay-choose.png` });
  await page.click('dialog.batch-dialog button[value="go"]');
  await page.waitForTimeout(500);
  const tasks = await app.idle(); const last = tasks.filter((t) => t.chapterId === "c1").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (last.status !== "completed" || last.engine?.model !== "codex") fail(`relay task: ${last.status} ${last.engine?.model} ${last.error || ""}`);
  // Cancelling the chooser starts nothing.
  const count = tasks.length; await page.goto(app.base); await page.click("[data-view=tasks]"); await page.waitForTimeout(500);
  if (await page.locator("[data-task-retry]").count()) { await page.locator("[data-task-retry]").first().click(); await page.click('dialog.batch-dialog button[value="cancel"]'); await page.waitForTimeout(400); if ((await app.call("GET", "/api/library")).books[0].tasks.length !== count) fail("cancel should not queue"); }
  console.log("errors:", JSON.stringify(errors)); await browser.close();
} finally { app.stop(); }
