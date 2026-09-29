import { chromium } from "playwright";
import { boot } from "./fixture.mjs";

const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  for (const p of app.profiles) await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft", profileId: p.id });
  await app.idle();
  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("dialog", (d) => d.accept());
  const shot = (name) => page.screenshot({ path: `${out}${name}.png` });
  const theme = (name) => page.evaluate((t) => localStorage.setItem("xxg:theme", t), name);
  const url = `${app.base}/#/books/neko/chapters/c1`;

  await page.goto(app.base); await theme("porcelain");
  await page.goto(url); await page.waitForSelector(".version-chip"); await page.waitForTimeout(600); await shot("01-reader-strip");

  // Row-aligned comparison: pick by clicking the text itself.
  await page.click(".version-compare-toggle"); await page.waitForSelector(".compare-row"); await page.waitForTimeout(400); await shot("02-compare");
  const rows = page.locator(".compare-row");
  if (await page.locator(".original-page").isVisible()) fail("original pane should give way to the sheet");
  await rows.nth(0).locator(".compare-variant").nth(2).click();
  await rows.nth(1).locator(".compare-variant").nth(0).click();
  await rows.nth(2).locator(".compare-variant").nth(1).click();
  await page.waitForTimeout(300); await shot("03-picked");
  const last = rows.nth(3); await last.scrollIntoViewIfNeeded(); await last.locator("[data-toggle-custom]").click();
  await last.locator("textarea").fill("在他掌心里定了定神，打量那书生的脸——这大概就是我与所谓“人类”的初见。当时只觉得古怪，这感觉至今未散。头一件，那张本该覆着毛的脸光溜溜的，活像只水壶。后来我见过的猫也不算少，却再没碰上这般残缺的模样。");
  await last.locator("[data-use-custom]").click(); await page.waitForTimeout(2600);
  if (!(await last.evaluate((n) => n.classList.contains("is-custom")))) fail("custom pick lost after polling");
  if (!(await page.locator(".compose-summary strong").innerText()).includes("4 / 4")) fail("picked count wrong");
  await shot("04-custom");
  // Row alignment: each original sits level with its versions.
  const gaps = await rows.evaluateAll((list) => list.map((r) => Math.abs(r.querySelector(".compare-original").getBoundingClientRect().top - r.querySelector(".compare-variants").getBoundingClientRect().top)));
  if (gaps.some((d) => d > 2)) fail("original and versions are not level: " + gaps);

  await page.click("[data-compose]"); await page.waitForSelector(".version-legend", { timeout: 8000 }); await page.waitForTimeout(600);
  const composed = await page.locator("#translation-read").innerText();
  if (!composed.includes("在他掌心里定了定神") || !composed.includes("本喵是一只猫") || !composed.includes("据说这个书生")) fail("composed text wrong");
  await shot("05-composed");

  // Single paragraph: click it, open the comparison, get a fresh opinion from one engine, and use it.
  await page.locator("#translation-read p").nth(1).click(); await page.waitForSelector(".paragraph-compare-button:not([hidden])"); await shot("06-paragraph-entry");
  await page.click(".paragraph-compare-button"); await page.waitForSelector("dialog.paragraph-compare[open]"); await page.waitForTimeout(300); await shot("07-paragraph-dialog");
  const codex = app.profiles.find((p) => p.name.includes("Codex"));
  await page.click(".pc-live"); await page.click(`[data-live="${codex.id}"]`); await page.waitForSelector(".pc-variant.is-waiting"); await shot("08-paragraph-waiting");
  await page.waitForSelector(".pc-variant .v-name small:text('节选')", { timeout: 20000 }); await page.waitForTimeout(400); await shot("09-paragraph-excerpt");
  if (await page.locator(".pc-variant.is-waiting").count()) fail("waiting placeholder should clear once the excerpt arrives");
  await page.locator(".pc-variant", { hasText: "本喵生在何处" }).locator(".pc-use").click();
  await page.waitForFunction(() => document.querySelector("#translation-read").innerText.includes("本喵生在何处"), null, { timeout: 8000 });
  await page.waitForTimeout(600); await shot("10-paragraph-replaced");

  for (const [t, name] of [["lamplight", "11-compare-lamplight"], ["bamboo", "12-compare-bamboo"]]) {
    await theme(t); await page.reload(); await page.waitForSelector(".version-chip"); await page.click(".version-compare-toggle"); await page.waitForTimeout(500); await shot(name);
  }
  await theme("paper"); await page.reload(); await page.waitForSelector(".version-chip"); await page.locator("#translation-read p").nth(2).click(); await page.click(".paragraph-compare-button"); await page.waitForTimeout(400); await shot("13-dialog-paper");

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(url); await phone.waitForSelector("#reader-side"); await phone.click("#reader-side"); await phone.waitForSelector(".version-chip"); await phone.click(".version-compare-toggle"); await phone.waitForTimeout(500);
  await phone.screenshot({ path: `${out}14-phone-compare.png` });
  console.log("errors:", JSON.stringify(errors));
  await browser.close();
} finally { app.stop(); }
