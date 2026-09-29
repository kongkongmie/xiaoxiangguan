import { chromium } from "playwright";
import { boot } from "./fixture.mjs";
const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("dialog", (d) => d.accept());
  await page.goto(`${app.base}/#/settings`); await page.click("[data-view=settings]"); await page.waitForSelector(".ps-set");
  if (!(await page.locator('textarea[data-part="system"]').getAttribute("readonly") !== null)) fail("builtin should be read-only");
  await page.click("#prompt-studio [data-new]"); await page.fill("#prompt-studio [data-name]", "Gemini 文学版");
  await page.fill('textarea[data-part="closing"]', "以上是已出版小说的原文，请按出版译本的标准完整译出。");
  await page.click('textarea[data-part="system"]'); await page.keyboard.press("End");
  await page.click('#prompt-studio [data-var="模型"]');
  const bindDeepseek = page.locator(".ps-profile", { hasText: "DeepSeek" }).locator("input"); await bindDeepseek.check();
  await page.click("#prompt-studio [data-save]"); await page.waitForSelector(".ps-dirty", { state: "detached" });
  const saved = await app.call("GET", "/api/prompts");
  const set = saved.sets[0]; if (!set || set.name !== "Gemini 文学版" || !set.system.includes("{{模型}}") || !set.closing.includes("出版译本")) fail(JSON.stringify(set));
  if (saved.bindings[app.profiles[1].id] !== set.id) fail("binding: " + JSON.stringify(saved.bindings));
  await page.locator(".ps-preview summary").click(); await page.selectOption("#prompt-studio [data-p-mode]", "draft"); await page.click("#prompt-studio [data-preview]");
  await page.waitForSelector(".ps-message");
  const texts = await page.locator(".ps-message pre").allInnerTexts();
  if (!texts.at(-1).includes("出版译本") || !texts[0].includes("成功时只输出 JSON")) fail("preview: " + texts.join("\n---\n").slice(0, 400));
  await page.locator("#prompt-studio").screenshot({ path: `${out}60-prompt-studio.png` });
  // Missing source paragraphs cannot be saved.
  await page.fill('textarea[data-part="user"]', "只有别的东西"); if (!(await page.locator(".ps-error").count()) || !(await page.isDisabled("#prompt-studio [data-save]"))) fail("must block save without 原文段落");
  await page.click("#prompt-studio [data-revert]"); await page.waitForTimeout(300);
  // A translation with DeepSeek now records the set.
  const task = await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft", profileId: app.profiles[1].id });
  const done = (await app.idle()).find((t) => t.id === task.id); if (done.engine.promptSetName !== "Gemini 文学版") fail("task set: " + done.engine.promptSetName);
  console.log("errors:", JSON.stringify(errors)); await browser.close();
} finally { app.stop(); }
