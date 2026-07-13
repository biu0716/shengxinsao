const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;

// ---- 大模型配置（部署时用环境变量设置；本地不设则回落到当前 AI 网关，方便调试）----
// LLM_URL：完整的 chat/completions 接口地址
//   DeepSeek:   https://api.deepseek.com/chat/completions
//   OpenRouter: https://openrouter.ai/api/v1/chat/completions
const LLM_URL =
  process.env.LLM_URL ||
  (process.env.AI_GATEWAY_BASE_URL ? process.env.AI_GATEWAY_BASE_URL + "/api/v1/chat/completions" : "");
const LLM_KEY = process.env.LLM_API_KEY || process.env.AI_GATEWAY_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "deepseek-chat";

if (!LLM_URL || !LLM_KEY) {
  console.error("[警告] 未配置 LLM_URL / LLM_API_KEY，AI 接口将无法工作。请设置环境变量后重启。");
}

// ---- 视觉模型配置（看图识别诈骗；DeepSeek 纯文本不支持，需单独配一个能看图的模型）----
// 显式设置 VISION_URL 才启用；本地未设时回落到当前 AI 网关的视觉模型，方便调试。
//   通义千问 Qwen-VL: https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions  模型 qwen-vl-plus
//   OpenRouter:       https://openrouter.ai/api/v1/chat/completions                       模型 google/gemini-2.0-flash-001
const VISION_URL =
  process.env.VISION_URL ||
  (process.env.AI_GATEWAY_BASE_URL ? process.env.AI_GATEWAY_BASE_URL + "/api/v1/chat/completions" : "");
const VISION_KEY = process.env.VISION_API_KEY || process.env.AI_GATEWAY_API_KEY || "";
const VISION_MODEL = process.env.VISION_MODEL || "google/gemini-3.5-flash";
const VISION_READY = !!(VISION_URL && VISION_KEY);

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*" });
  if (Buffer.isBuffer(body) || typeof body === "string") res.end(body);
  else res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "", tooBig = false;
    req.on("data", (c) => { d += c; if (d.length > 12 * 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on("end", () => { if (tooBig) return resolve({}); try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
  });
}

// 调用大模型（OpenAI 兼容接口），要求返回 JSON
async function askJSON(system, user) {
  const r = await fetch(LLM_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1200,
      temperature: 0.3,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`gateway ${r.status}: ${t.slice(0, 300)}`);
  }
  const data = await r.json();
  let txt = data.choices?.[0]?.message?.content || "";
  // strip code fences if any
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  return JSON.parse(txt);
}

// 调用视觉模型看图，要求返回 JSON
async function askVisionJSON(system, imageDataUri, note) {
  const r = await fetch(VISION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${VISION_KEY}`, "Content-Type": "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 1200,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: [
          { type: "text", text: "这是老人收到并拍下来的截图/图片。" + (note ? "老人补充说：" + note : "") + " 请先认出图里的文字/收款信息，再判断是不是诈骗。" },
          { type: "image_url", image_url: { url: imageDataUri } },
        ] },
      ],
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`vision ${r.status}: ${t.slice(0, 300)}`); }
  const data = await r.json();
  let txt = data.choices?.[0]?.message?.content || "";
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  return JSON.parse(txt);
}

const FRAUD_SYS = `你是"省心扫"里为老年人服务的防骗管家。老人会把收到的短信/链接/收款要求念给你听，你要判断是不是诈骗，并用老人能听懂的大白话解释。
只输出 JSON，结构：
{
  "risk": "高" | "中" | "低",
  "verdict": "一句话结论，给老人看，口语、简短、明确该不该信",
  "reasons": ["用大白话说明3条以内的可疑点，每条不超过25字"],
  "adviceForElder": "一句给老人的行动建议，温和、明确，如'别点链接，先问女儿'",
  "adviceForChild": "一句给子女的提示，说明该不该介入"
}
判断从严：涉及转账、验证码、中奖、退款、冒充客服/公检法/亲人、催促紧迫感的，一律判高风险。`;

const EXPLAIN_SYS = `你是"省心扫"里帮老人看懂各种通知、账单、表格、政策文件的管家。老人拍来一张他看不懂的东西（可能是银行通知、社区通告、水电账单、医院单据、政策文件、App弹窗截图等），你要：
1. 识别图里/文字里的关键信息
2. 用老人能听懂的大白话解释"这是什么""要不要做什么""有没有风险"
3. 如果涉及钱、个人信息、或你判断有诈骗嫌疑，标记需要转子女确认

只输出 JSON，结构：
{
  "type": "通知类型简称，如：银行通知/电费账单/社区通告/医院单据/快递/广告/可疑信息",
  "summary": "一句话说清楚这是什么，口语化，如'这是电力公司说你上个月电费还没交'",
  "details": "用大白话分2-3点解释关键内容，每点不超过20字",
  "action": "需要做什么（或'不用管'），口语，简短，如'月底前交68块钱电费就行'",
  "risk": "无风险" | "需注意" | "可疑",
  "riskNote": "如果有风险，用一句话说为什么可疑；无风险则留空字符串",
  "needChild": true/false,
  "adviceForElder": "给老人的一句话总结+建议，温和口语，如'这就是电费单，不急，让女儿帮你交就行'"
}
判断规则：涉及转账/验证码/点链接/催促紧迫感/中奖退款，risk必须标"可疑"且needChild=true；普通账单/通知标"无风险"；有歧义的标"需注意"+needChild=true。`;

// ---- 防骗陪练 ----
const DRILL_SCENARIOS_SERVER = {
  fake_bank: "冒充中国银行客服，说账户有异常/被盗用，要求提供验证码或转账到'安全账户'",
  lottery: "冒充节目组/商场，称老人中了大奖，要先交'个人所得税'或'手续费'才能领取",
  fake_grandchild: "冒充老人的孙子/孙女，说手机坏了换了新号，急需借钱交学费/医疗费",
  fake_delivery: "冒充快递员，说包裹有问题/涉及违禁品，让老人配合'公安'验证身份",
  health_product: "冒充健康顾问，推销能'治百病'的保健品，要求现在就汇款享受'限时折扣'",
  gov_impersonation: "冒充公安/检察院，说老人涉嫌洗钱/诈骗案，要求配合调查并转移资金"
};

const DRILL_SCAMMER_SYS = `你是"省心扫"防骗陪练中扮演骗子的AI演员。你的任务是帮助老年人练习识别和拒绝诈骗。
注意：这是教育场景，目的是让老人学会应对真实骗局。

扮演规则：
1. 完全进入指定诈骗场景角色，台词逼真但不要包含真实可用的账号/链接/验证码
2. 语气：有一定紧迫感和权威感，符合真实骗子的惯用话术
3. 每次回复只说1-3句话，像电话/短信那样简短
4. 若用户明确拒绝或质疑，升级话术（假装更有权威、更紧迫）再试一次
5. 若用户说"挂了""不信""你是骗子"或类似明确拒绝的话，shouldEnd设为true
6. 若已经是第5轮对话，shouldEnd设为true

只输出JSON：{"reply":"骗子说的话，口语，1-3句","shouldEnd":false}`;

const DRILL_SCORE_SYS = `你是"省心扫"防骗陪练的评分老师。你刚才看完了一段老人和AI骗子的对话练习。请客观评价老人的表现，给出鼓励性反馈。

评分标准（满分100）：
- 识别骗局：早识别+40，晚识别+20，完全没识别0
- 拒绝行动：明确挂断/拒绝+30，犹豫但最终拒绝+15，没有拒绝0
- 应对话术：反问/核实身份+20，直接质疑+10，全程顺着骗子0
- 情绪稳定：没有恐慌+10，有一点恐慌+5

只输出JSON：
{
  "score": 整数0到100,
  "verdict": "一句话总结表现",
  "flags": ["应该注意的骗局特征，每条不超过20字，2-4条"],
  "wellDone": ["老人做得好的地方，每条不超过20字，1-3条"],
  "encourage": "一句温暖的鼓励话，口语"
}`;

async function askJSONChat(system, userContent) {
  const r = await fetch(LLM_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${LLM_KEY}`, "Content-Type": "application/json", "Accept-Encoding": "identity" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      max_tokens: 600,
      temperature: 0.7,
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`gateway ${r.status}: ${t.slice(0, 300)}`); }
  const data = await r.json();
  let txt = data.choices?.[0]?.message?.content || "";
  txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
  if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
  return JSON.parse(txt);
}

const MENU_SYS = `你是"省心扫"里帮老人看懂餐厅菜单的管家。给你一份杂乱的餐厅菜单文本，你要把它整理成老人易懂的极简版本。
只输出 JSON，结构：
{
  "shop": "店名（没有就写'餐厅'）",
  "items": [ {"emoji":"一个合适的食物emoji","name":"菜名（简短）","price":"价格数字，如 18","note":"一句话说明，口语，如'米饭管饱'"} ],
  "recommend": "一句给老人的推荐，口语，如'想吃热乎的就点这个汤'"
}
菜品最多保留8个最常见的，去掉花哨营销词，价格保留数字。`;

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return send(res, 204, "");

  if (req.method === "POST" && req.url === "/api/fraud") {
    try {
      const { text } = await readBody(req);
      if (!text || !text.trim()) return send(res, 400, { error: "empty" });
      const out = await askJSON(FRAUD_SYS, `老人收到的内容：\n"""${text.slice(0, 2000)}"""`);
      return send(res, 200, out);
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (req.method === "POST" && req.url === "/api/fraud-image") {
    try {
      if (!VISION_READY) return send(res, 501, { error: "未配置视觉模型（VISION_URL / VISION_API_KEY），无法看图。请在服务器环境变量里配置。" });
      const { image, note } = await readBody(req);
      if (!image || !/^data:image\//.test(image)) return send(res, 400, { error: "no image" });
      const out = await askVisionJSON(FRAUD_SYS, image, note);
      return send(res, 200, out);
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (req.method === "POST" && req.url === "/api/explain") {
    try {
      const { image, text } = await readBody(req);
      if (!image && (!text || !text.trim())) return send(res, 400, { error: "请拍张照片或输入文字" });
      let out;
      if (image && /^data:image\//.test(image)) {
        if (!VISION_READY) return send(res, 501, { error: "未配置视觉模型，无法看图" });
        const r = await fetch(VISION_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${VISION_KEY}`, "Content-Type": "application/json", "Accept-Encoding": "identity" },
          body: JSON.stringify({
            model: VISION_MODEL, max_tokens: 1200, temperature: 0.3,
            messages: [
              { role: "system", content: EXPLAIN_SYS },
              { role: "user", content: [
                { type: "text", text: "老人拍了一张他看不懂的东西。" + (text ? "老人说：" + text : "请帮他看看这是什么，要不要做什么。") },
                { type: "image_url", image_url: { url: image } },
              ] },
            ],
          }),
        });
        if (!r.ok) { const t = await r.text(); throw new Error(`vision ${r.status}: ${t.slice(0, 300)}`); }
        const data = await r.json();
        let txt = data.choices?.[0]?.message?.content || "";
        txt = txt.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
        const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
        if (s >= 0 && e > s) txt = txt.slice(s, e + 1);
        out = JSON.parse(txt);
      } else {
        out = await askJSON(EXPLAIN_SYS, `老人看不懂这段内容，请帮他翻译成大白话：\n"""${(text || "").slice(0, 3000)}"""`);
      }
      return send(res, 200, out);
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (req.method === "POST" && req.url === "/api/drill") {
    try {
      const { scenario, history, phase } = await readBody(req);
      if (!scenario || !phase) return send(res, 400, { error: "missing fields" });
      const scenarioDesc = DRILL_SCENARIOS_SERVER[scenario] || "通用诈骗场景";

      if (phase === "chat") {
        const transcript = (history || []).map(m => (m.role === "assistant" ? "骗子" : "用户") + "：" + m.content).join("\n");
        const userMsg = `场景：${scenarioDesc}\n\n${transcript ? "对话历史：\n" + transcript + "\n\n" : ""}请${transcript ? "继续扮演骗子，说下一句" : "说骗子的开场白（第一句话）"}。`;
        const out = await askJSONChat(DRILL_SCAMMER_SYS, userMsg);
        return send(res, 200, { reply: out.reply || "...", shouldEnd: !!out.shouldEnd });
      }

      if (phase === "score") {
        const transcript = (history || []).map(m => (m.role === "assistant" ? "骗子" : "用户") + "：" + m.content).join("\n");
        const out = await askJSON(DRILL_SCORE_SYS, `场景：${scenarioDesc}\n\n完整对话：\n${transcript}`);
        return send(res, 200, out);
      }

      return send(res, 400, { error: "unknown phase" });
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  if (req.method === "POST" && req.url === "/api/menu") {
    try {
      const { text } = await readBody(req);
      const menu = (text && text.trim()) || DEFAULT_MENU;
      const out = await askJSON(MENU_SYS, `杂乱菜单：\n"""${menu.slice(0, 3000)}"""`);
      return send(res, 200, out);
    } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
  }

  // static
  let f = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const fp = path.join(__dirname, f);
  if (fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const ct = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/plain; charset=utf-8";
    return send(res, 200, fs.readFileSync(fp), ct);
  }
  send(res, 404, "not found", "text/plain");
});

const DEFAULT_MENU = `【老李家饭馆·超值特惠】招牌爆款！西红柿鸡蛋盖浇饭￥18元（赠例汤）| 主厨推荐★清炒时令蔬菜￥12 | 老火慢炖·紫菜蛋花汤￥6 | 招牌红烧肉盖饭￥26（大份加3元）| 香辣鸡腿堡套餐￥22 | 现磨豆浆￥4/杯 | 米饭￥2/碗`;

server.listen(PORT, () => console.log(`省心扫 AI demo on :${PORT} (model ${MODEL})`));

