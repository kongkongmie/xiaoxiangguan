import { chromium } from "playwright";
import { boot } from "./fixture.mjs";

const out = (await import("./paths.mjs")).shots;
const app = await boot();
const fail = (m) => { throw new Error(m); };
try {
  for (const p of app.profiles) await app.call("POST", "/api/books/neko/chapters/c1/translate", { mode: "draft", profileId: p.id });
  await app.idle();
  // Endpoint: exact text only, paraphrases dropped.
  const direct = await app.call("POST", "/api/books/neko/chapters/c1/align", { side: "source", selection: "名前", sourceText: "吾輩は猫である。名前はまだ無い。", translationText: "我是猫。名字嘛，还没有。" });
  if (JSON.stringify(direct.matches) !== '["名字"]' || direct.dropped !== 1) fail("align endpoint: " + JSON.stringify(direct));

  const browser = await chromium.launch({ ...(await import("./paths.mjs")).launch });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = []; page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(app.base); await page.evaluate(() => localStorage.setItem("xxg:theme", "lamplight"));
  await page.goto(`${app.base}/#/books/neko/chapters/c1`); await page.waitForSelector(".version-chip"); await page.waitForTimeout(600);
  const tops = await page.evaluate(() => [document.querySelector("#source-scroll p"), document.querySelector("#translation-read p")].map((n) => Math.round(n.getBoundingClientRect().top)));
  console.log("first paragraph tops", tops);
  if (Math.abs(tops[0] - tops[1]) > 2) fail("first paragraphs not level: " + tops);
  await page.screenshot({ path: `${out}30-aligned.png` });

  // Select a word in the original and ask for its counterpart.
  const selectIn = (selector, word) => page.evaluate(([sel, w]) => {
    const node = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(w));
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT); let t; while ((t = walker.nextNode())) { const i = t.data.indexOf(w); if (i >= 0) { const r = document.createRange(); r.setStart(t, i); r.setEnd(t, i + w.length); getSelection().removeAllRanges(); getSelection().addRange(r); const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; } }
  }, [selector, word]);
  const at = await selectIn("#source-scroll p", "名前");
  await page.mouse.move(at.x, at.y); await page.evaluate(() => document.querySelector(".reading-room").dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
  await page.waitForSelector(".align-button:not([hidden])"); await page.screenshot({ path: `${out}31-align-button.png` });
  await page.click(".align-button"); await page.waitForSelector(".align-pop:not([hidden])");
  const pop = await page.locator(".align-pop").innerText();
  if (!pop.includes("名字") || !pop.includes("未标出")) fail("pop: " + pop);
  const marked = await page.evaluate(() => { const h = CSS.highlights.get("align-match"); return h ? [...h].map((r) => r.toString()) : []; });
  if (!marked.includes("名字")) fail("highlight: " + marked);
  await page.waitForTimeout(200); await page.screenshot({ path: `${out}32-align-result.png` });

  // And from the translation side.
  await page.keyboard.press("Escape");
  const at2 = await selectIn("#translation-read p", "又暗又潮的地方");
  await page.evaluate(() => document.querySelector(".reading-room").dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
  await page.waitForSelector(".align-button:not([hidden])"); await page.click(".align-button"); await page.waitForSelector(".align-pop:not([hidden])");
  const marked2 = await page.evaluate(() => [...CSS.highlights.get("align-match")].map((r) => r.toString()));
  if (!marked2.includes("薄暗いじめじめした所")) fail("reverse highlight: " + marked2);
  await page.screenshot({ path: `${out}33-align-reverse.png` });
  await page.keyboard.press("Escape");

  // Comparison without per-version labels.
  await page.click(".version-compare-toggle"); await page.waitForSelector(".compare-row"); await page.waitForTimeout(300);
  if (await page.locator(".compare-variant .v-name").count()) fail("labels still shown");
  await page.locator(".compare-row").nth(1).locator(".compare-variant").nth(0).click(); await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}34-compare-compact.png` });
  await page.evaluate(() => localStorage.setItem("xxg:theme", "porcelain")); await page.reload(); await page.waitForSelector(".version-chip"); await page.click(".version-compare-toggle"); await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}35-compare-compact-light.png` });
  console.log("errors:", JSON.stringify(errors));
  await browser.close();
} finally { app.stop(); }
