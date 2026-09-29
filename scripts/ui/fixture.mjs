import { fileURLToPath, pathToFileURL } from "node:url";
// Boots Xiaoxiangguan with a public-domain chapter translated by three mock "engines", each in its own style.
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]$/, "");
// Natsume Soseki, 吾輩は猫である (1905), public domain.
export const SOURCE = [
  "吾輩は猫である。名前はまだ無い。",
  "どこで生れたかとんと見当がつかぬ。何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している。吾輩はここで始めて人間というものを見た。しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだ。",
  "この書生というのは時々我々を捕えて煮て食うという話である。しかしその当時は何という考もなかったから別段恐しいとも思わなかった。ただ彼の掌に載せられてスーと持ち上げられた時何だかフワフワした感じがあったばかりである。",
  "掌の上で少し落ちついて書生の顔を見たのがいわゆる人間というものの見始であろう。この時妙なものだと思った感じが今でも残っている。",
  "第一毛をもって装飾されべきはずの顔がつるつるしてまるで薬缶だ。その後猫にもだいぶ逢ったがこんな片輪には一度も出会わした事がない。"
];
const STYLES = {
  sonnet: ["我是猫。名字嘛，还没有。",
    "我在哪儿出生的，完全摸不着头脑。只记得自己曾在一个昏暗潮湿的地方喵喵地哭。我就是在那里第一次见到了叫作“人”的东西。而且后来听说，那是人类当中最凶恶的一族，叫作“书生”。",
    "听说这书生常常把我们抓去煮来吃。不过那时我什么想法也没有，所以也不觉得特别可怕。只是被他放在掌心、嗖地一下托起来的时候，有种轻飘飘的感觉罢了。",
    "在掌心上稍稍定下神来，看了看书生的脸，这大概就是我见识所谓“人”的开端吧。那时觉得“真是个怪东西”的感觉，至今还留在心里。",
    "首先，那张本该用毛来装饰的脸，竟光溜溜的，活像一把水壶。后来我也见过不少猫，却从没遇到过这样的残缺之物。"],
  deepseek: ["咱家是猫，名字还没有。",
    "在哪里出生，一点头绪也没有。只记得在一个昏暗潮湿的地方喵喵地叫着。咱家在这里第一次看到了名为人类的东西。而且后来听说，那是被称作书生的、人类中最为狞恶的种族。",
    "据说这个书生时常把我们抓来煮了吃。不过当时并没有什么想法，所以也不怎么觉得害怕。只是被他放在手掌上嗖地举起来的时候，感到有些轻飘飘的而已。",
    // DeepSeek merges the last two paragraphs, so every version is compared on them as one unit.
    ["在手掌上稍微镇定下来后看到书生的脸，这大概就是看到所谓人类的开始。当时觉得奇怪的那种感觉，至今仍然留着。首先，本应以毛发装饰的脸却光秃秃的，简直像个水壶。此后也遇到过不少猫，但从未碰到过这样的残疾者。"]],
  codex: ["本喵是一只猫，至今还没有名字。",
    "本喵生在何处，全然没有印象。只记得在一个又暗又潮的地方喵喵直哭。本喵就是在那儿头一回见到了“人”这种东西。后来才听说，那是人类里头最凶残的一类，叫“书生”。",
    "据说这种书生时不时会把我们逮去煮着吃。可那会儿本喵什么都不懂，也就没觉得有多可怕。只是被他搁在手心里、忽地一下举起来时，觉得有点儿飘飘然。",
    "在他手心里稍稍稳住神，瞧了瞧书生的脸，这恐怕就是本喵见识“人类”的头一遭。那时只觉得“这玩意儿真怪”，这感觉到现在还没散。",
    "头一件，本该长满毛的脸却溜光水滑，简直就是只铁壶。后来本喵也见过不少猫，可从没碰上过这般残缺的家伙。"]
};

export async function boot() {
  const folder = await mkdtemp(join(tmpdir(), "xxg-ui-"));
  const mock = http.createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    if (req.method === "GET" && req.url.endsWith("/models")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ data: ["sonnet", "deepseek", "codex", "broken"].map((id) => ({ id })) })); }
    const request = JSON.parse(body); const prompt = request.messages.at(-1).content;
    if (request.model === "broken") { res.writeHead(503, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { type: "overloaded_error", message: "The model is overloaded. Please try again later.", request_id: "req_demo_123" } })); }
    const picked = prompt.match(/选中了：「([\s\S]+?)」/)?.[1];
    if (picked) {
      const pairs = [["名前", "名字"], ["吾輩", "我"], ["書生", "书生"], ["薄暗いじめじめした所", "又暗又潮的地方"]];
      const found = pairs.find(([a, b]) => a === picked || b === picked);
      const matches = found ? [found[0] === picked ? found[1] : found[0], "这段文字并不存在"] : [];
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ matches, note: found ? "直译，对应名词本身" : "意译，无法逐字对应" }) } }] }));
    }
    const match = prompt.match(/原文段落：\n(\[[^\n]+\])/);
    res.writeHead(200, { "content-type": "application/json" });
    if (!match) return res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ terms: [], characters: [], uncertainties: [], risks: [] }) } }] }));
    const paragraphs = JSON.parse(match[1]); const style = STYLES[request.model === "slow" ? "sonnet" : request.model];
    const segments = [];
    // Translate by position in the chapter, so excerpts of a single paragraph get that paragraph's text.
    const global = (p) => SOURCE.findIndex((s) => s === p.text || s.startsWith(String(p.text).slice(0, 12)));
    for (let i = 0; i < paragraphs.length; i++) {
      const g = global(paragraphs[i]);
      if (g === 3 && Array.isArray(style[3]) && paragraphs[i + 1]) { segments.push({ sourceParagraphIds: [paragraphs[i].id, paragraphs[i + 1].id], text: style[3][0] }); i++; continue; }
      segments.push({ sourceParagraphIds: [paragraphs[i].id], text: Array.isArray(style[g]) ? style[g][0] : style[g] });
    }
    // A slow thinking model that streams: reasoning first, then the JSON a few characters at a time.
    if (request.model === "slow" && request.stream) {
      // Headers were already sent as JSON above; like some relays, the events arrive under that label.
      const send = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      for (const thought of ["先看人称：吾輩是猫的自称，", "带一点自大，", "译成“我”还是“咱家”？", "这里保留傲慢语气，用“我”加上语气词。", "第二段注意书生这个词……"]) { send({ reasoning_content: thought }); await wait(700); }
      const body = JSON.stringify({ segments });
      for (let i = 0; i < body.length; i += 24) { send({ content: body.slice(i, i + 24) }); await wait(120); }
      send({}, "stop"); return res.end("data: [DONE]\n\n");
    }
    await new Promise((r) => setTimeout(r, 150));
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ segments }) } }] }));
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  for (const dir of ["data", "secrets", "library/neko/state"]) await mkdir(join(folder, dir), { recursive: true });
  await writeFile(join(folder, "data/library.json"), JSON.stringify({ books: [{ id: "neko", title: "吾輩は猫である", author: "夏目漱石", language: "ja", sourceLanguage: "ja", format: "EPUB", chapters: [{ id: "c1", title: "一", source: SOURCE.join("\n\n"), status: "extracted" }, { id: "c2", title: "二", source: "吾輩は新年来多少有名になったので、猫ながらちょっと鼻が高く感ぜらるるのはありがたい。", status: "extracted" }], tasks: [], glossary: [], characters: [], uncertainties: [] }], exports: [] }));
  const provider = (model, name) => JSON.stringify({ backend: "http", protocol: "openai-chat", providerName: name, baseUrl: `http://127.0.0.1:${mock.address().port}/v1`, model, noAuth: true });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(`${REPO}/server.mjs`).href)});`], { env: { ...process.env, PORT: "0", TRANSLATION_LIBRARY_DATA_DIR: folder }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const base = await new Promise((resolve, reject) => { child.stdout.on("data", (d) => { const url = String(d).match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]; if (url) resolve(url); }); child.once("exit", () => reject(new Error(stderr))); });
  const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) }); const v = await r.json(); if (!r.ok) throw new Error(v.error); return v; };
  const idle = async () => { for (let i = 0; i < 300; i++) { const lib = await call("GET", "/api/library"); const t = lib.books[0].tasks || []; if (t.length && t.every((x) => !["queued", "running", "paused"].includes(x.status))) return t; await new Promise((r) => setTimeout(r, 100)); } throw new Error("idle timeout"); };
  const profiles = [];
  for (const [model, name, label, color] of [["sonnet", "Anthropic", "阿青 · Sonnet", "#3f6e9a"], ["deepseek", "DeepSeek", "DeepSeek", "#b5485d"], ["codex", "OpenAI", "阿澈 · Codex", "#4e8a6a"]]) {
    await writeFile(join(folder, "secrets/provider.json"), provider(model, name));
    profiles.push((await call("POST", "/api/engine-profiles", { name: label, color })).profiles.at(-1));
  }
  return { base, call, idle, profiles, folder, stop: () => { child.kill(); mock.close(); } };
}
