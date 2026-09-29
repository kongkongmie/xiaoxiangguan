import { chromium } from "playwright";
import { boot } from "./fixture.mjs";
const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft", profileId: app.profiles[0].id }); await app.idle();
  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${app.base}/#/books/neko`); await page.waitForSelector("#translate-book");
  if ((await page.innerText("#translate-book")).trim() !== "翻译全书") fail("button label: " + await page.innerText("#translate-book"));
  await page.click("#translate-book"); await page.waitForSelector("dialog.batch-dialog[open]");
  let text = await page.locator(".batch-summary").innerText();
  if (!text.includes("1 章") || !text.includes("跳过 1 章")) fail("summary: " + text);
  await page.locator(".batch-engine", { hasText: "DeepSeek" }).click();
  await page.locator("dialog.batch-dialog").screenshot({ path: `${out}41-batch.png` });
  await page.uncheck("input[name=skipDone]"); text = await page.locator(".batch-summary").innerText();
  if (!text.includes("2 章")) fail("unchecked: " + text);
  await page.check("input[name=skipDone]");
  await page.click("[data-go]"); await page.waitForTimeout(500);
  const tasks = await app.idle();
  const c2 = tasks.filter((t) => t.chapterId === "c2");
  if (c2.length !== 1 || c2[0].engine?.model !== "deepseek") fail("queued: " + JSON.stringify(c2.map((t) => t.engine?.model)));
  if (tasks.filter((t) => t.chapterId === "c1").length !== 1) fail("c1 should be skipped");
  console.log("errors:", JSON.stringify(errors)); await browser.close();
} finally { app.stop(); }
