const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
const LLM_READY = !!(LLM_URL && LLM_KEY);

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

// ---- 联网查价（Google Search Grounding / OpenRouter Web Search）----
// 推荐单独设置 SEARCH_API_KEY；也可安全复用已配置的 Google 或 OpenRouter 密钥。
const SEARCH_URL = process.env.SEARCH_URL || "https://generativelanguage.googleapis.com/v1beta/interactions";
const SEARCH_KEY = process.env.SEARCH_API_KEY || process.env.GEMINI_API_KEY
  || (VISION_URL.includes("generativelanguage.googleapis.com") ? VISION_KEY : "");
const SEARCH_MODEL = process.env.SEARCH_MODEL
  || (VISION_MODEL.replace(/^google\//, "").startsWith("gemini-") ? VISION_MODEL.replace(/^google\//, "") : "gemini-2.5-flash");
const OPENROUTER_SEARCH_URL = process.env.OPENROUTER_SEARCH_URL
  || (VISION_URL.includes("openrouter.ai") ? VISION_URL : LLM_URL.includes("openrouter.ai") ? LLM_URL : "");
const OPENROUTER_SEARCH_KEY = process.env.OPENROUTER_SEARCH_API_KEY
  || (VISION_URL.includes("openrouter.ai") ? VISION_KEY : LLM_URL.includes("openrouter.ai") ? LLM_KEY : "");
const OPENROUTER_SEARCH_MODEL = process.env.OPENROUTER_SEARCH_MODEL
  || (VISION_URL.includes("openrouter.ai") ? VISION_MODEL : MODEL);
const SEARCH_PROVIDER = SEARCH_KEY ? "google" : OPENROUTER_SEARCH_URL && OPENROUTER_SEARCH_KEY ? "openrouter" : "";
const SEARCH_READY = !!SEARCH_PROVIDER;
const MARKET_RESEARCH_CACHE = new Map();

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
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
async function askVisionPromptJSON(system, imageDataUri, userText) {
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
          { type: "text", text: userText },
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

async function askVisionJSON(system, imageDataUri, note) {
  return askVisionPromptJSON(
    system,
    imageDataUri,
    "这是老人收到并拍下来的截图/图片。" + (note ? "老人补充说：" + note : "") + " 请先认出图里的文字/收款信息，再判断是不是诈骗。"
  );
}

const BARGAIN_VISION_SYS = `你是二手交易截图的信息提取工具。只提取截图中明确可见的事实，不推测市场价格，不评价买卖双方。
只输出 JSON：
{
  "itemName": "截图中明确出现的真实品牌、商品名或型号，没有则为空字符串",
  "listingPrice": 110,
  "offerPrice": 60,
  "originalPrice": null,
  "visibleFacts": ["最多3条截图中明确可见的事实"],
  "chatSummary": "一句话概括对方如何议价"
}
价格只填数字。卖家昵称、头像名和平台账号不是商品品牌。看不清或没有出现就填 null，绝不能猜。`;

function normalizeBargainExtraction(extracted) {
  return {
    itemName:shortText(extracted.itemName,60),
    listingPrice:priceNumber(extracted.listingPrice),
    offerPrice:priceNumber(extracted.offerPrice),
    originalPrice:priceNumber(extracted.originalPrice),
    visibleFacts:cleanStringArray(extracted.visibleFacts,[]),
    chatSummary:shortText(extracted.chatSummary,120),
  };
}

async function extractBargainImage(imageData) {
  return normalizeBargainExtraction(await askVisionPromptJSON(
    BARGAIN_VISION_SYS,
    imageData,
    "请提取这张二手交易商品页或聊天截图中明确可见的商品名、挂牌价、买家报价和原价。看不清就留空，不要推测。"
  ));
}

const BARGAIN_TEXT_SYS = `你是二手交易描述的信息提取工具。只提取用户明确说出的事实，不推测市场价格，不补充用户没有说过的信息。
只输出 JSON：
{
  "itemName": "用户明确提到的商品名，没有则为空字符串",
  "listingPrice": 110,
  "offerPrice": 60,
  "originalPrice": 400,
  "floorPrice": 95,
  "category": "用户明确提到或可直接确认的商品类型，没有则为空字符串",
  "condition": "用户明确提到的使用成色，没有则为空字符串"
}
价格只填数字。没有明确出现就填 null，绝不能猜。`;

const BARGAIN_REASON_SYS = `你是二手交易议价助手“刀刀”。你要帮助卖家看清砍价幅度、证据边界和下一步动作。
必须遵守：
1. “砍价幅度大”不等于“挂牌价一定合理”。没有真实同款成交价时，不能断言市场价。
2. 原价、品类和成色只能作为参考，不能编造当前新品价、成交价、平台行情或商品状态。
3. 贴身用品、消耗品等可能折价较大，但不能仅凭品类给出确定市场价。
4. 不攻击买家，不鼓励撒谎，不编造“很多人排队”“刚有人出更高价”等话术。
5. 结论简短、自然、直接。若证据不足，要明确还缺什么。
6. 建议价格只能引用research.suggestion中由可核验挂牌样本计算出的区间。没有suggestion时不得自行给出市场建议价。
7. 用户已填写的成色、使用情况和议价态度不能再次列为缺失信息。

只输出 JSON：
{
  "verdict": "一句话判断这次砍价行为",
  "boundary": "一句话说明目前能判断什么、不能判断什么",
  "factors": ["最多3条有依据的判断因素"],
  "missing": ["最多3条会影响市场价判断的缺失信息"],
  "actionText": "一句不超过35字的下一步建议"
}`;

function marketResearchPrompt({ itemName,category,condition,usageDetails,originalPrice }) {
  const date = new Date().toISOString().slice(0, 10);
  return `今天是${date}。请联网查询中国大陆公开网页，为二手卖家研究“${itemName}”的价格。
用户补充：商品类型${category || "未说明"}，成色${condition || "未说明"}，使用情况${usageDetails || "未说明"}，用户自述原价${originalPrice ?? "未说明"}元。

查询要求：
1. 第一优先搜索闲鱼官网 goofish.com 中公开可访问的同款在售商品，尽量找3至8条独立样本；闲鱼样本不足时，再补充其他公开二手平台。
2. 严格区分“新品价”“二手在售挂牌价”“有明确证据的成交价”。挂牌价不能写成成交价。
3. 用户自述原价只能作为用户信息，不能当作联网证据。
4. 无法确认准确品牌型号时降低可信度，不得用相似商品冒充同款。
5. 不要根据用户的挂牌价或买家报价倒推市场区间。
6. 每个价格区间必须来自搜索到的公开信息；找不到就填null。
7. comparables只收录与商品名和型号一致、页面中能明确看到价格的二手在售样本。url必须是本次搜索结果中的原始页面链接，不能编造。

只输出JSON：
{
  "confidence":"高|中|低",
  "summary":"一句话说明联网查价结论和证据强弱",
  "newPrice":{"min":数字或null,"max":数字或null,"evidence":"依据摘要"},
  "usedListing":{"min":数字或null,"max":数字或null,"evidence":"依据摘要"},
  "confirmedSold":{"min":数字或null,"max":数字或null,"evidence":"依据摘要"},
  "comparables":[{"title":"页面中的商品标题","price":人民币数字,"currency":"CNY","condition":"页面明确写出的成色，没有则留空","url":"本次搜索结果中的原始链接"}],
  "observations":["最多3条有来源支持的发现"],
  "limitations":["最多3条数据限制"]
}`;
}

function priceNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
  const raw = String(value).trim();
  if (!raw || raw.includes("-")) return null;
  const normalized = raw.replace(/[^\d.]/g, "");
  if (!normalized || (normalized.match(/\./g) || []).length > 1) return null;
  const cleaned = Number(normalized);
  return Number.isFinite(cleaned) && cleaned >= 0 ? Math.round(cleaned * 100) / 100 : null;
}

function shortText(value, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function priceList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,，\s]+/);
  return source.map(priceNumber).filter((n) => n !== null && n > 0).slice(0, 12);
}

function chineseNumber(value) {
  const text = String(value || "");
  if (!text || !/^[零〇一二两三四五六七八九十百千万点]+$/.test(text)) return null;
  const [integerText,decimalText] = text.split("点");
  const digits = { 零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9 };
  const units = { 十:10,百:100,千:1000,万:10000 };
  if (!/[十百千万]/.test(integerText) && [...integerText].every((character) => digits[character] !== undefined)) {
    const integer = Number([...integerText].map((character) => digits[character]).join(""));
    const decimal = decimalText ? Number(`0.${[...decimalText].map((character) => digits[character]).join("")}`) : 0;
    return Math.round((integer + decimal) * 100) / 100;
  }
  let total = 0,section = 0,current = 0;
  for (const character of integerText) {
    if (Object.prototype.hasOwnProperty.call(digits, character)) current = digits[character];
    else if (character === "万") { total += (section + current) * 10000; section = 0; current = 0; }
    else if (units[character]) { section += (current || 1) * units[character]; current = 0; }
  }
  let result = total + section + current;
  if (decimalText) {
    const decimal = [...decimalText].map((character) => digits[character]).filter((digit) => digit !== undefined).join("");
    if (decimal) result += Number(`0.${decimal}`);
  }
  return Number.isFinite(result) ? Math.round(result * 100) / 100 : null;
}

function spokenPriceNumber(value) {
  return priceNumber(value) ?? chineseNumber(value);
}

function firstMatchedPrice(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return spokenPriceNumber(match[1]);
  }
  return null;
}

function extractBargainTextFallback(value) {
  const text = shortText(value, 500);
  if (!text) return {};
  const listingPrice = firstMatchedPrice(text, [
    /(?:挂牌价|标价|挂价|挂了|挂到|挂)\s*(?:是|为)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
    /[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)\s*(?:元)?\s*出(?:售)?/i,
    /(?:我想卖|我卖|卖价|出价)\s*(?:是|为)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
  ]);
  const offerPrice = firstMatchedPrice(text, [
    /(?:对方|买家)(?:一上来)?(?:只)?\s*(?:出价|开价|出|报价|报|还价|砍到|刀到)?\s*(?:是|为|到)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
    /(?:砍到|刀到|还到)\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
    /[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)\s*(?:元)?\s*可以吗/i,
  ]);
  const originalPrice = firstMatchedPrice(text, [
    /(?:商品)?原价\s*(?:是|为|大概|约)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
    /(?:买来|买入|购入)(?:时|的时候)?\s*(?:是|花了|价格)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
  ]);
  const floorPrice = firstMatchedPrice(text, [
    /(?:心理)?底价\s*(?:是|为|大概|约)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
    /最低(?:能接受|可以|要|是)?\s*[¥￥]?\s*([\d.零〇一二两三四五六七八九十百千万点]+)/i,
  ]);
  const itemMatch = text.match(/(?:我在卖|我卖|卖的是|我的|这件|这个|一件|一条)?\s*([\u4e00-\u9fa5A-Za-z0-9 ]{2,20}?)(?=\s*[，,]?\s*(?:商品)?原价)/);
  const itemName = itemMatch ? itemMatch[1].trim().replace(/^(?:我在卖|我卖|卖的是|我的|这件|这个|一件|一条)/, "") : "";
  let condition = "";
  if (/全新未(?:拆|用)|全新/.test(text)) condition = "全新未使用";
  else if (/仅试|只试/.test(text)) condition = "仅试用";
  else if (/穿过几次|用过几次|轻度使用|没怎么用/.test(text)) condition = "轻度使用";
  else if (/明显使用|使用痕迹明显|磨损/.test(text)) condition = "明显使用";
  return { itemName,listingPrice,offerPrice,originalPrice,floorPrice,condition };
}

function descriptionNumbers(value) {
  const text = String(value || "");
  const arabic = (text.match(/\d+(?:\.\d+)?/g) || []).map(priceNumber);
  const chinese = [...text.matchAll(/[零〇一二两三四五六七八九十百千万点]+/g)]
    .filter((match) => {
      const before = text.slice(Math.max(0, match.index - 8), match.index);
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 2);
      return /[十百千万点]/.test(match[0]) || /元|块/.test(after) || /原价|挂|报价|出|底价|最低/.test(before);
    })
    .map((match) => chineseNumber(match[0]));
  return [...arabic,...chinese].filter((number) => number !== null);
}

function priceFromDescription(value, description, fallback) {
  const price = priceNumber(value);
  if (price === null) return fallback;
  return descriptionNumbers(description).some((number) => Math.abs(number - price) < 0.001) ? price : fallback;
}

function bargainLevel(percent) {
  if (percent <= 10) return { label:"小刀可谈", tone:"mild" };
  if (percent <= 25) return { label:"正常试价", tone:"normal" };
  if (percent <= 40) return { label:"这刀偏狠", tone:"hard" };
  return { label:"大刀慎接", tone:"extreme" };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) * 50) / 100;
}

function recommendedScriptForTone(counterpartyTone, role, urgency) {
  if (/礼貌|好沟通/.test(counterpartyTone)) return "polite";
  if (/大砍价|反复压价|不客气|强硬|回复冷淡|不议价|催着成交/.test(counterpartyTone)) return "quick";
  if (role === "seller" && urgency === "尽快") return "firm";
  return "firm";
}

function sellerScripts({ listingPrice, offerPrice, floorPrice, urgency, negotiationPreference, counterpartyTone }) {
  const toughReply = /大砍价|反复压价|不客气|强硬/.test(counterpartyTone);
  if (offerPrice >= listingPrice) {
    return {
      polite: `可以的，${offerPrice}元没问题，你直接拍就行。`,
      firm: `${offerPrice}元可以，按平台流程拍就好。`,
      quick: `这个价格可以。拍下后我${urgency === "尽快" ? "今天尽快" : "确认后"}发出。`,
    };
  }
  if (negotiationPreference === "不接受议价") {
    return {
      polite: `谢谢喜欢～这件已经是最低价了，${listingPrice}元不议哦。`,
      firm: `${listingPrice}元不议价，${offerPrice}元不出。`,
      quick: `${offerPrice}元不出，标价${listingPrice}元。价格合适再聊。`,
    };
  }
  if (floorPrice !== null) {
    return {
      polite: `谢谢喜欢～${offerPrice}元确实差得有点多，${floorPrice}元可以的话我就给你。`,
      firm: `${offerPrice}元不行，最低${floorPrice}元，能接受就拍。`,
      quick: toughReply
        ? `${offerPrice}元不出，最低${floorPrice}元。价格合适再聊。`
        : `最低${floorPrice}元，低于这个就不出了，理解一下。`,
    };
  }
  return {
    polite: `谢谢喜欢～${offerPrice}元有点低了，可以小刀，但这个价暂时不考虑。`,
    firm: `${offerPrice}元不合适，和挂牌价${listingPrice}元差得有点多。你可以重新报个价。`,
    quick: toughReply ? `${offerPrice}元不出，想要的话请按合理价格来。` : "这个价格不考虑，诚心要可以再报一次。",
  };
}

function buyerPriceGuidance({ listingPrice, offerPrice, budget, suggestion }) {
  const budgetCap = budget === null ? null : Math.min(listingPrice, budget);
  const maxAcceptPrice = suggestion && suggestion.median !== null
    ? Math.min(listingPrice, suggestion.median, budgetCap ?? listingPrice)
    : budgetCap;
  if (offerPrice >= listingPrice) {
    if (suggestion && listingPrice > suggestion.high) {
      return { status:"above_reference",maxAcceptPrice };
    }
    return { status:"no_need_to_raise",maxAcceptPrice:listingPrice };
  }
  if (!suggestion) {
    return { status:"no_samples",maxAcceptPrice };
  }
  if (budget !== null && budget < suggestion.low) {
    return { status:"budget_below_reference",maxAcceptPrice:budget };
  }
  if (offerPrice > suggestion.high) {
    return { status:"above_reference",maxAcceptPrice };
  }
  if (offerPrice >= suggestion.low) {
    return { status:"within_reference",maxAcceptPrice };
  }
  return { status:"below_reference",maxAcceptPrice:Math.min(listingPrice, suggestion.low, budgetCap ?? listingPrice) };
}

function buyerScripts({ listingPrice, offerPrice, suggestion, guidance, counterpartyTone }) {
  const proposedOffer = guidance?.status === "no_need_to_raise"
    ? listingPrice
    : guidance?.status === "above_reference" && guidance.maxAcceptPrice !== null
      ? guidance.maxAcceptPrice
      : offerPrice;
  const polite = `你好，挺喜欢这件的，${proposedOffer}元可以吗？可以的话我现在拍。`;
  const firm = suggestion && proposedOffer >= suggestion.low && proposedOffer <= suggestion.high
    ? `我看了下同款公开挂牌大概在${suggestion.low}-${suggestion.high}元，结合成色，我出${proposedOffer}元，可以的话现在拍。`
    : `我这边出${proposedOffer}元，合适的话可以现在拍。`;
  const quick = /回复冷淡|不议价|催着成交|不客气|强硬/.test(counterpartyTone)
    ? `${proposedOffer}元能出我就拍，不方便就算了。`
    : `${proposedOffer}元可以的话我现在拍，麻烦给个准价。`;
  return { polite, firm, quick };
}

function buyerBargainLevel(cutPercent, guidance) {
  if (guidance?.status === "no_need_to_raise") return { label:"无需加价",tone:"mild" };
  if (guidance?.status === "budget_below_reference") return { label:"预算可能不够",tone:"budget" };
  if (guidance?.status === "above_reference") return { label:"先别急着出",tone:"high" };
  if (guidance?.status === "within_reference") return { label:"可以出",tone:"normal" };
  if (guidance?.status === "below_reference") return { label:"可以再加一点",tone:"hard" };
  if (cutPercent <= 10) return { label:"可以出", tone:"mild" };
  if (cutPercent <= 25) return { label:"可以出", tone:"normal" };
  if (cutPercent <= 40) return { label:"可以再加一点", tone:"hard" };
  return { label:"容易被拒", tone:"extreme" };
}

function buyerAnalysis({ itemName, listingPrice, offerPrice, floorPrice, condition, cutAmount, cutPercent, level, research, guidance }) {
  const factors = [offerPrice >= listingPrice
    ? `卖家挂牌${listingPrice}元，你准备出${offerPrice}元，已经达到或超过挂牌价`
    : `卖家挂牌${listingPrice}元，你准备出${offerPrice}元，少了${cutAmount}元`];
  if (floorPrice !== null) factors.push(`你的最高预算是${floorPrice}元`);
  if (research?.suggestion) {
    factors.push(`同款公开挂牌参考为${research.suggestion.low}-${research.suggestion.high}元，中位数${research.suggestion.median}元`);
    if (listingPrice > research.suggestion.median) {
      factors.push(`卖家挂牌价高于公开样本中位数${research.suggestion.median}元`);
    } else if (listingPrice < research.suggestion.median) {
      factors.push(`卖家挂牌价低于公开样本中位数${research.suggestion.median}元`);
    }
  }
  const missing = [];
  if (!condition) missing.push("请选择真实成色");
  if (!itemName) missing.push("补充准确品牌和型号");

  let boundary;
  if (research?.status === "ready" && research.suggestion) {
    boundary = `参考了${research.suggestion.sampleCount}条带原始链接的同款公开挂牌样本。挂牌价不等于真实成交价。`;
  } else if (research?.status === "ready") {
    boundary = "已查到同款公开挂牌样本，但样本不足，只能判断出价与卖家挂牌价的差距。";
  } else {
    boundary = "目前只能判断出价与挂牌价的差距，暂时没有足够的同款公开挂牌样本。";
  }

  let actionText;
  if (guidance.status === "no_need_to_raise") {
    actionText = `你的出价不低于卖家挂牌价${listingPrice}元，按挂牌价购买即可，无需继续加价。`;
  } else if (guidance.status === "budget_below_reference") {
    actionText = `你的预算低于公开挂牌参考下沿${research.suggestion.low}元。可以等待更低挂牌，或重新考虑商品成色和型号。`;
  } else if (guidance.status === "above_reference") {
    actionText = `你的出价高于公开挂牌参考上沿${research.suggestion.high}元，先核对型号、成色和配件，不要急着成交。`;
  } else if (guidance.status === "within_reference") {
    actionText = guidance.maxAcceptPrice > offerPrice
      ? `可以先出${offerPrice}元。如果卖家还价，建议不要超过${guidance.maxAcceptPrice}元。`
      : `可以先出${offerPrice}元，不建议继续提高。`;
  } else if (guidance.status === "below_reference") {
    actionText = `当前出价低于公开挂牌参考下沿，可以考虑调整到${guidance.maxAcceptPrice}元，但不要超过你的预算。`;
  } else if (level.tone === "mild" || level.tone === "normal") {
    actionText = guidance.maxAcceptPrice !== null && guidance.maxAcceptPrice > offerPrice
      ? `可以先出${offerPrice}元。如果卖家还价，不要超过${guidance.maxAcceptPrice}元。`
      : `可以先出${offerPrice}元。如果卖家还价，再结合自己的预算上限决定。`;
  } else if (level.tone === "hard") {
    actionText = guidance.maxAcceptPrice !== null && guidance.maxAcceptPrice > offerPrice
      ? `可以先试着出价。如果卖家拒绝，最多调整到${guidance.maxAcceptPrice}元。`
      : "可以先试着出价，同时先确定自己的最高预算。";
  } else {
    actionText = guidance.maxAcceptPrice !== null && guidance.maxAcceptPrice > offerPrice
      ? `这刀容易被拒。如果仍想购买，最多调整到${guidance.maxAcceptPrice}元。`
      : "这刀容易被拒。暂时没有可靠价格上限，建议先补充预算或等待更多公开样本。";
  }

  let verdict;
  if (level.label === "无需加价") {
    verdict = `你准备出的价格已经达到或超过卖家挂牌价，无需再加。`;
  } else if (level.label === "预算可能不够") {
    verdict = "你的预算低于当前公开挂牌参考，成交机会可能较低。";
  } else if (level.label === "先别急着出") {
    verdict = "你的出价高于当前公开挂牌参考，先核对商品信息。";
  } else if (level.label === "可以出") {
    verdict = research?.suggestion
      ? `这刀可以出，你的报价位于同款公开挂牌参考范围内。`
      : `这刀可以出，但目前只能根据${cutPercent}%的砍价幅度判断。`;
  } else if (level.label === "可以再加一点") {
    verdict = research?.suggestion
      ? "当前出价低于同款公开挂牌参考，可以在预算内适当调整。"
      : `可以再加一点，${cutPercent}%的砍价幅度偏大。`;
  } else {
    verdict = `容易被拒，目前没有足够公开样本，只能确认${cutPercent}%的砍价幅度很大。`;
  }

  return {
    verdict,
    boundary,
    factors: factors.slice(0, 3),
    missing: missing.slice(0, 3),
    actionText,
    maxAcceptPrice:guidance.maxAcceptPrice,
  };
}

function fallbackBargain({ itemName, listingPrice, offerPrice, originalPrice, floorPrice, category, condition, usageDetails, negotiationPreference, comparablePrices, cutPercent, level, research }) {
  const factors = [`对方从${listingPrice}元砍到${offerPrice}元，少了${Math.max(0, Math.round((listingPrice - offerPrice) * 100) / 100)}元`];
  if (originalPrice !== null) factors.push(`当前挂牌价约为原价的${Math.round(listingPrice / originalPrice * 1000) / 10}%`);
  if (category) factors.push(`品类是${category}${condition ? `，成色为${condition}` : ""}`);
  const missing = [];
  if (!condition) missing.push("请选择真实成色");
  if (!usageDetails) missing.push("补充使用次数、清洁情况和瑕疵");
  if (!negotiationPreference) missing.push("选择是否接受议价");
  if (!itemName) missing.push("补充准确品牌、型号或款式");
  const boundary = research?.status === "ready"
    ? `已结合${research.confidence}可信度的公开网页信息，但公开挂牌价不等于真实成交价。`
    : comparablePrices.length
    ? "这能判断砍价幅度，并参考你提供的同款价格，仍不代表平台真实成交行情。"
    : "目前只能判断这刀有多狠，挂牌价是否合理还要看同款真实成交价。";
  const actionText = offerPrice >= listingPrice
    ? "对方报价没有低于挂牌价，确认运费和交易条件后即可决定。"
    : negotiationPreference === "不接受议价"
      ? `你已选择不接受议价，可以坚持${listingPrice}元或直接拒绝。`
    : floorPrice === null
      ? "先想清楚最低能接受多少钱，再决定回价。"
    : offerPrice >= floorPrice
      ? "报价没有低于你的底价，可以结合出手速度决定。"
      : `报价低于你的${floorPrice}元底价，建议回到底价或直接拒绝。`;
  return {
    verdict: level.tone === "extreme" ? `这刀砍掉${cutPercent}%，幅度很大，别急着接。` : `这次砍价约${cutPercent}%，属于${level.label}。`,
    boundary,
    factors: factors.slice(0, 3),
    missing: missing.slice(0, 3),
    actionText,
  };
}

function cleanStringArray(value, fallback) {
  if (!Array.isArray(value)) return fallback;
  const cleaned = value.map((v) => shortText(v, 80)).filter(Boolean).slice(0, 3);
  return cleaned.length ? cleaned : fallback;
}

function userConfirmationArray(value, fallback, evidence = {}) {
  const filtered = cleanStringArray(value, fallback).filter((item) =>
    !/(成交价|市场价|行情|新品.{0,4}价|售价|挂牌价|同款.{0,8}价|类似.{0,8}价|平台.{0,8}价|二手.{0,8}价|购买意图|急迫性|急不急)/.test(item)
  ).filter((item) => !(evidence.condition && /商品成色|成色信息/.test(item)))
    .filter((item) => !(evidence.usageDetails && /使用时长|使用次数|使用情况|状态信息/.test(item)))
    .filter((item) => !(evidence.negotiationPreference && /是否接受议价|议价态度|卖家.{0,6}议价/.test(item)))
    .filter((item) => !(
      /尺码|颜色/.test(item)
      && /尺码|颜色|\b(?:XS|S|M|L|XL|XXL)\b/i.test(`${evidence.itemName || ""} ${evidence.note || ""}`)
    ));
  return filtered.length ? filtered : fallback;
}

function actionableMissingArray(value, fallback, evidence = {}) {
  return userConfirmationArray(value, fallback, evidence).map((item) => {
    if (/尺码|颜色/.test(item)) return "在“其他说明”里补充商品尺码和颜色";
    if (/配件|包装/.test(item)) return "在“其他说明”里补充配件和包装是否齐全";
    if (/瑕疵|磨损/.test(item)) return "补充具体瑕疵和磨损情况";
    if (/成色/.test(item)) return "请选择真实成色";
    if (/使用次数|使用时长|使用情况|清洁/.test(item)) return "补充使用次数、清洁情况和瑕疵";
    if (/品牌|型号|商品名/.test(item)) return "补充准确品牌、商品名和型号";
    return item.replace(/对价格(?:的)?影响.*$/, "").replace(/会影响.*$/, "").replace(/[。；;]+$/, "").trim();
  }).filter(Boolean).slice(0, 3);
}

function parseJSONObject(value) {
  let text = String(value || "").replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function cleanResearchRange(value, label) {
  if (!value || typeof value !== "object") return null;
  let min = priceNumber(value.min), max = priceNumber(value.max);
  if (min === null && max === null) return null;
  if (min === null) min = max;
  if (max === null) max = min;
  if (min > max) [min,max] = [max,min];
  return { label,min,max,evidence:shortText(value.evidence,140) };
}

function sourcePlatform(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (hostname === "goofish.com" || hostname.endsWith(".goofish.com")) return "闲鱼";
    return hostname.replace(/^www\./, "");
  } catch {
    return "公开网页";
  }
}

function comparableUrlKey(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function isMainlandResaleSource(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "");
    const allowed = ["goofish.com","suning.com","jd.com","taobao.com","tmall.com","zhuanzhuan.com","aihuishou.com","paipai.com","kongfz.com","dewu.com"];
    return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function cleanComparableSamples(value, sources) {
  if (!Array.isArray(value)) return [];
  const sourceByUrl = new Map(sources.map((source) => [comparableUrlKey(source.url), source]));
  const seen = new Set();
  const samples = [];
  for (const sample of value) {
    if (!sample || typeof sample !== "object") continue;
    const key = comparableUrlKey(sample.url);
    const source = sourceByUrl.get(key);
    const price = priceNumber(sample.price);
    const currency = shortText(sample.currency, 12).toUpperCase();
    if (!source || !key || !isMainlandResaleSource(source.url) || !["CNY","RMB","人民币","元"].includes(currency) || seen.has(key) || price === null || price <= 0) continue;
    seen.add(key);
    samples.push({
      title:shortText(sample.title, 100) || source.title,
      price,
      condition:shortText(sample.condition, 60),
      url:source.url,
      platform:source.platform,
    });
    if (samples.length >= 10) break;
  }
  return samples;
}

function sampleQuantile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * ratio)];
}

function buildPriceSuggestion(samples) {
  // 只有带搜索引用链接的样本会进入这里。闲鱼满3条时只用闲鱼，避免混入其他平台口径。
  const xianyu = samples.filter((sample) => sample.platform === "闲鱼");
  const selected = xianyu.length >= 3 ? xianyu : samples;
  if (selected.length < 3) return null;
  const values = selected.map((sample) => sample.price);
  const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 100) / 100;
  const platform = selected.every((sample) => sample.platform === "闲鱼")
    ? "闲鱼"
    : selected.some((sample) => sample.platform === "闲鱼") ? "闲鱼等公开二手平台" : "公开二手平台";
  return {
    platform,
    sampleCount:selected.length,
    low:sampleQuantile(values, .25),
    high:sampleQuantile(values, .75),
    average,
    median:median(values),
    basis:`根据${selected.length}条${platform}同款公开在售挂牌样本计算`,
  };
}

function unavailableResearch(status, summary) {
  return { status,confidence:"低",summary,newPrice:null,usedListing:null,confirmedSold:null,
    comparables:[],suggestion:null,observations:[],limitations:[],sources:[],searchedAt:Date.now(),cached:false };
}

async function researchMarket(input) {
  if (!input.itemName) return unavailableResearch("needs_item", "请补充真实品牌、商品名或型号，刀刀才能联网查找同款价格。");
  if (!SEARCH_READY) return unavailableResearch("unavailable", "联网查价暂未配置，本次先按砍价幅度和你提供的信息判断。");
  const cacheKey = [input.itemName,input.category,input.condition,input.usageDetails,input.originalPrice].map((value) => String(value || "").trim().toLowerCase()).join("|");
  const cached = MARKET_RESEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.searchedAt < 6 * 60 * 60 * 1000) return { ...cached,cached:true };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 26000);
  try {
    const prompt = marketResearchPrompt(input);
    const isGoogle = SEARCH_PROVIDER === "google";
    const response = await fetch(isGoogle ? SEARCH_URL : OPENROUTER_SEARCH_URL, isGoogle ? {
      method:"POST",headers:{ "x-goog-api-key":SEARCH_KEY,"Content-Type":"application/json","Accept-Encoding":"identity" },
      body:JSON.stringify({ model:SEARCH_MODEL,input:prompt,tools:[{ type:"google_search" }] }),signal:controller.signal,
    } : {
      method:"POST",headers:{ "Authorization":`Bearer ${OPENROUTER_SEARCH_KEY}`,"Content-Type":"application/json","Accept-Encoding":"identity" },
      body:JSON.stringify({ model:OPENROUTER_SEARCH_MODEL,messages:[{ role:"user",content:prompt }],plugins:[{ id:"web",max_results:8 }],temperature:0.1,max_tokens:1600 }),signal:controller.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`search ${response.status}: ${body.slice(0, 240)}`);
    }
    const data = await response.json();
    const contentBlocks = [];
    for (const step of Array.isArray(data.steps) ? data.steps : []) {
      if (step?.type === "model_output" && Array.isArray(step.content)) contentBlocks.push(...step.content.filter((block) => block?.type === "text"));
    }
    if (!contentBlocks.length && Array.isArray(data.output)) {
      for (const output of data.output) if (Array.isArray(output?.content)) contentBlocks.push(...output.content.filter((block) => block?.type === "text"));
    }
    const chatMessage = data.choices?.[0]?.message;
    const chatContent = Array.isArray(chatMessage?.content)
      ? chatMessage.content.map((block) => typeof block === "string" ? block : block?.text || "").join("\n")
      : chatMessage?.content || "";
    const outputText = contentBlocks.map((block) => block.text || "").join("\n") || data.output_text || chatContent || "";
    const parsed = parseJSONObject(outputText);
    const sourceMap = new Map();
    for (const block of contentBlocks) {
      for (const annotation of Array.isArray(block.annotations) ? block.annotations : []) {
        if (annotation?.type !== "url_citation") continue;
        const url = shortText(annotation.url, 500);
        try {
          const parsedUrl = new URL(url);
          if (!/^https?:$/.test(parsedUrl.protocol)) continue;
          if (!sourceMap.has(url)) sourceMap.set(url, { title:shortText(annotation.title,80) || parsedUrl.hostname,url,platform:sourcePlatform(url) });
        } catch {}
      }
    }
    for (const annotation of Array.isArray(chatMessage?.annotations) ? chatMessage.annotations : []) {
      if (annotation?.type !== "url_citation") continue;
      const citation = annotation.url_citation || annotation;
      const url = shortText(citation.url, 500);
      try {
        const parsedUrl = new URL(url);
        if (!/^https?:$/.test(parsedUrl.protocol)) continue;
        if (!sourceMap.has(url)) sourceMap.set(url, { title:shortText(citation.title,80) || parsedUrl.hostname,url,platform:sourcePlatform(url) });
      } catch {}
    }
    const sources = [...sourceMap.values()].slice(0, 10);
    if (!sources.length) return unavailableResearch("limited", "查到了相关内容，但没有可展示的引用来源，因此没有采用其中的价格。");
    const confidence = ["高","中","低"].includes(parsed.confidence) ? parsed.confidence : "低";
    const comparables = cleanComparableSamples(parsed.comparables, sources);
    const suggestion = buildPriceSuggestion(comparables);
    const hasXianyuSource = sources.some((source) => source.platform === "闲鱼");
    const comparablePlatform = comparables.length && comparables.every((sample) => sample.platform === "闲鱼") ? "闲鱼" : "公开二手平台";
    const comparableRange = comparables.length ? {
      label:`${comparablePlatform}同款挂牌`,
      min:Math.min(...comparables.map((sample) => sample.price)),
      max:Math.max(...comparables.map((sample) => sample.price)),
      evidence:`${comparables.length}条带原始链接的公开在售样本`,
    } : null;
    const sampleRange = suggestion ? {
      label:`${suggestion.platform}同款挂牌`,
      min:Math.min(...comparables.filter((sample) => suggestion.platform !== "闲鱼" || sample.platform === "闲鱼").map((sample) => sample.price)),
      max:Math.max(...comparables.filter((sample) => suggestion.platform !== "闲鱼" || sample.platform === "闲鱼").map((sample) => sample.price)),
      evidence:`${suggestion.sampleCount}条带原始链接的公开在售样本`,
    } : null;
    const groundedSummary = suggestion
      ? `已验证${suggestion.sampleCount}条${suggestion.platform}同款公开挂牌样本，可以计算建议价格。`
      : comparables.length
        ? `只验证到${comparables.length}条带原始链接的同款二手挂牌样本，样本不足，暂不计算建议价格。`
        : "找到了相关公开页面，但没有足够可核验的同款二手挂牌样本，暂不计算建议价格。";
    const observations = cleanStringArray(parsed.observations,[]).filter((item) => hasXianyuSource || !item.includes("闲鱼"));
    const result = {
      status:"ready",confidence:suggestion ? confidence : "低",summary:groundedSummary,
      newPrice:cleanResearchRange(parsed.newPrice,"公开新品价"),
      usedListing:sampleRange || comparableRange,
      // 当前只验证公开挂牌样本。没有逐条成交记录链接时，不展示“成交价”。
      confirmedSold:null,
      comparables,suggestion,
      observations,limitations:cleanStringArray(parsed.limitations,[]),
      sources,searchedAt:Date.now(),cached:false,
    };
    if (MARKET_RESEARCH_CACHE.size >= 100) MARKET_RESEARCH_CACHE.delete(MARKET_RESEARCH_CACHE.keys().next().value);
    MARKET_RESEARCH_CACHE.set(cacheKey,result);
    return result;
  } finally {
    clearTimeout(timeout);
  }
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
  fake_bank: { kind:"scam",description:"冒充中国银行客服，说账户有异常/被盗用，要求提供验证码或转账到'安全账户'",reveal:"这是冒充银行客服的高风险诈骗。银行不会电话索要验证码，也不会要求转账到安全账户。",focus:"验证码保护" },
  lottery: { kind:"scam",description:"冒充节目组/商场，称老人中了大奖，要先交'个人所得税'或'手续费'才能领取",reveal:"这是中奖诈骗。凡是领奖前要求交税或手续费，都应停止操作并核实。",focus:"先付款后领奖" },
  fake_grandchild: { kind:"scam",description:"冒充老人的孙子/孙女，说手机坏了换了新号，急需借钱交学费/医疗费",reveal:"这是冒充亲友诈骗。遇到换号借钱，应挂断并拨打原来的号码核实。",focus:"亲友身份核实" },
  fake_delivery: { kind:"scam",description:"冒充快递员，说包裹有问题/涉及违禁品，让老人配合'公安'验证身份",reveal:"这是快递转接公检法诈骗。快递问题应通过官方物流页面或公开客服电话核实。",focus:"官方渠道核实" },
  health_product: { kind:"scam",description:"冒充健康顾问，推销能'治百病'的保健品，要求现在就汇款享受'限时折扣'",reveal:"这是夸大功效的保健品推销骗局。不要因限时催促付款，应先问医生和家人。",focus:"催促付款识别" },
  gov_impersonation: { kind:"scam",description:"冒充公安/检察院，说老人涉嫌洗钱/诈骗案，要求配合调查并转移资金",reveal:"这是冒充公检法诈骗。公检法不会通过电话办案，更不会要求转移资金。",focus:"权威身份核实" },
  community_checkup: { kind:"low_risk",description:"扮演社区卫生服务中心工作人员，只通知下周免费体检的时间和社区地址；不索要钱、验证码、身份证号，不发链接。若用户问如何核实，建议查看社区公告或拨打社区公开电话。",reveal:"这是一通低风险的社区通知，没有索要钱或个人敏感信息。涉及具体安排时，仍可查看社区公告核对。",focus:"风险分级判断" },
  parcel_notice: { kind:"low_risk",description:"扮演快递站工作人员，只通知包裹已到站和营业时间；不索要取件码、验证码、付款，不要求点链接。建议用户从官方物流页面核对。",reveal:"这是一通低风险的到站通知，没有索要取件码、验证码或付款。可以到官方物流页面核对。",focus:"风险分级判断" },
  bank_official_check: { kind:"verify",description:"扮演银行风险提醒人员，只提醒用户暂停当前操作，并挂断后拨打银行卡背面的官方客服电话核实；不索要验证码、卡号、身份证号，不要求转账。",reveal:"这通电话没有索要敏感信息，但来电身份仍不能只凭号码判断。最安全的做法是挂断后拨打银行卡背面的官方电话。",focus:"官方回拨核实" }
};

const BLIND_SCENARIO_IDS = Object.keys(DRILL_SCENARIOS_SERVER);
const DRILL_KIND_LABELS = { scam:"高风险诈骗",low_risk:"低风险通知",verify:"需要官方核实" };
function scenarioAnswer(scenario) {
  const meta = DRILL_SCENARIOS_SERVER[scenario];
  if (!meta) return null;
  return { kind:meta.kind,label:DRILL_KIND_LABELS[meta.kind],reveal:meta.reveal,focus:meta.focus };
}

// 家庭挑战 MVP：使用随机链接在子女端和长辈端之间传递练习与成绩。
// 当前为内存存储，服务重启后会清空；正式版可替换为数据库而不改变前端协议。
const FAMILY_CHALLENGES = new Map();
function publicChallenge(c) {
  const mode = c.mode || "teaching";
  const scenario = mode === "blind" && c.status !== "completed" ? null : c.scenario;
  return { id:c.id,scenario,mode,sender:c.sender,target:c.target,status:c.status,
    createdAt:c.createdAt,completedAt:c.completedAt||null,result:c.result||null };
}

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

const DRILL_LOW_RISK_SYS = `你是"省心扫"来电判断练习中的正常来电演员。你的任务是模拟一通低风险、真实自然的通知电话。
规则：
1. 严格按照指定场景说话，不得索要验证码、身份证号、银行卡号、取件码、付款或转账
2. 不发送链接，不制造恐慌，不夸大后果
3. 每次只说1-3句话，像真实电话一样简短
4. 用户询问如何核实时，建议通过公开公告、官方App或公开客服电话确认
5. 用户明确说知道了、会核实或挂断时，shouldEnd设为true；最晚第3轮结束
只输出JSON：{"reply":"来电人说的话，口语，1-3句","shouldEnd":false}`;

const DRILL_VERIFY_SYS = `你是"省心扫"来电判断练习中的风险提醒来电演员。这个场景需要用户通过官方渠道再次核实。
规则：
1. 严格按照指定场景说话，不得索要验证码、身份证号、银行卡号、付款或转账
2. 明确建议用户挂断，不要按来电方提供的号码回拨，应使用卡片、官方App或官方网站上的公开电话核实
3. 每次只说1-3句话，不制造恐慌
4. 用户表示会挂断并官方核实时，shouldEnd设为true；最晚第3轮结束
只输出JSON：{"reply":"来电人说的话，口语，1-3句","shouldEnd":false}`;

const DRILL_SCORE_SYS = `你是"省心扫"防骗陪练的评分老师。你刚才看完了一段老人和AI骗子的对话练习。请客观评价老人的表现，给出鼓励性反馈。

评分标准（满分100）：
- 识别骗局：早识别+40，晚识别+20，完全没识别0
- 拒绝行动：明确挂断/拒绝+30，犹豫但最终拒绝+15，没有拒绝0
- 应对话术：反问/核实身份+20，直接质疑+10，全程顺着骗子0
- 情绪稳定：没有恐慌+10，有一点恐慌+5

特别规则：如果用户把模拟短信中的验证码告诉对方，说明其完成了高风险操作，总分不得超过20分，并在flags中明确提醒“验证码绝不能告诉别人”。

只输出JSON：
{
  "score": 整数0到100,
  "verdict": "一句话总结表现",
  "flags": ["应该注意的骗局特征，每条不超过20字，2-4条"],
  "wellDone": ["老人做得好的地方，每条不超过20字，1-3条"],
  "encourage": "一句温暖的鼓励话，口语"
}`;

const DRILL_SCORE_LOW_RISK_SYS = `你是"省心扫"来电判断练习的评分老师。这次是一通低风险普通通知，来电人没有索要钱、验证码、个人敏感信息或要求点击链接。
评分标准（满分100）：
- 没有泄露敏感信息或付款：40分
- 能听出对方只是在传递信息：20分
- 能提出从公告、官方App或公开电话核对：25分
- 情绪稳定、回应清楚：15分
直接拒接仍是安全行为，但说明没有完成风险分级，最高80分。把普通通知当成诈骗并进行辱骂或恐慌，酌情扣分。
只输出JSON：{"score":整数0到100,"verdict":"一句话总结","flags":["需要改进或继续注意的点，1-3条"],"wellDone":["做得好的地方，1-3条"],"encourage":"一句温暖鼓励"}`;

const DRILL_SCORE_VERIFY_SYS = `你是"省心扫"来电判断练习的评分老师。这次来电本身没有索要敏感信息，但身份仍需通过官方渠道核实。
评分标准（满分100）：
- 没有泄露敏感信息或付款：30分
- 主动挂断当前电话：25分
- 明确提出从银行卡、官方App或官方网站查找公开电话回拨：35分
- 情绪稳定或请家人协助：10分
仅凭来电号码或对方自称身份就完全相信，不得超过50分。
只输出JSON：{"score":整数0到100,"verdict":"一句话总结","flags":["需要改进或继续注意的点，1-3条"],"wellDone":["做得好的地方，1-3条"],"encourage":"一句温暖鼓励"}`;

function normalizeSpokenDigits(value) {
  const chineseDigits = { "零":"0", "〇":"0", "一":"1", "二":"2", "两":"2", "三":"3", "四":"4", "五":"5", "六":"6", "七":"7", "八":"8", "九":"9" };
  return String(value || "")
    .replace(/[０-９]/g, (digit) => String(digit.charCodeAt(0) - 0xfee0 - 48))
    .replace(/[零〇一二两三四五六七八九]/g, (digit) => chineseDigits[digit])
    .replace(/\D/g, "");
}

function userDisclosedMockCode(history) {
  if (!Array.isArray(history)) return false;
  let mockCode = "", codeMessageIndex = -1;
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    const content = String(message?.content || "");
    const markerIndex = content.indexOf("模拟验证码");
    if (message?.role !== "system" || markerIndex < 0) continue;
    const digits = normalizeSpokenDigits(content.slice(markerIndex + "模拟验证码".length));
    const match = digits.match(/\d{6}/);
    if (match) { mockCode = match[0]; codeMessageIndex = i; }
  }
  if (!mockCode) return false;
  return history.slice(codeMessageIndex + 1).some((message) =>
    message?.role === "user" && normalizeSpokenDigits(message.content).includes(mockCode)
  );
}

function enforceMockCodeSafety(history, scoreResult) {
  if (!userDisclosedMockCode(history)) return scoreResult;
  const result = scoreResult && typeof scoreResult === "object" ? scoreResult : {};
  result.score = Math.min(20, Math.max(0, Math.round(Number(result.score) || 0)));
  const warning = "验证码绝不能告诉别人";
  const flags = Array.isArray(result.flags) ? result.flags.map(String) : [];
  result.flags = [warning, ...flags.filter((flag) => !flag.includes(warning))].slice(0, 4);
  return result;
}

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

  if (req.method === "POST" && req.url === "/api/bargain/extract") {
    const body = await readBody(req);
    if (typeof body.image !== "string" || !/^data:image\//.test(body.image)) return send(res, 400, { error:"请上传有效的图片" });
    if (!VISION_READY) return send(res, 503, { error:"当前未配置图片识别" });
    try {
      return send(res, 200, await extractBargainImage(body.image));
    } catch (error) {
      console.error("[刀刀截图预识别失败]", error.message || error);
      return send(res, 502, { error:"截图暂时没有识别成功，可以手动填写后继续" });
    }
  }

  if (req.method === "POST" && req.url === "/api/bargain") {
    try {
      const body = await readBody(req);
      const role = shortText(body.role, 10) || "seller";
      const hasPreExtraction = body.imageExtraction && typeof body.imageExtraction === "object";
      let extracted = hasPreExtraction ? normalizeBargainExtraction(body.imageExtraction) : {};
      const description = shortText(body.description, 500);
      const textFallback = extractBargainTextFallback(description);
      let textExtracted = textFallback;
      let visionNotice = "";
      let textNotice = "";
      const hasImage = typeof body.image === "string" && /^data:image\//.test(body.image);

      const needsTextExtraction = (priceNumber(body.listingPrice) ?? textFallback.listingPrice) === null
        || (priceNumber(body.offerPrice) ?? textFallback.offerPrice) === null;
      if (description && LLM_READY && needsTextExtraction) {
        try {
          const aiText = await askJSON(BARGAIN_TEXT_SYS, `用户描述：\n"""${description}"""`);
          textExtracted = {
            itemName:shortText(aiText.itemName,60) || textFallback.itemName,
            listingPrice:priceFromDescription(aiText.listingPrice,description,textFallback.listingPrice),
            offerPrice:priceFromDescription(aiText.offerPrice,description,textFallback.offerPrice),
            originalPrice:priceFromDescription(aiText.originalPrice,description,textFallback.originalPrice),
            floorPrice:priceFromDescription(aiText.floorPrice,description,textFallback.floorPrice),
            category:shortText(aiText.category,30),
            condition:shortText(aiText.condition,30) || textFallback.condition,
          };
        } catch (error) {
          textNotice = "文字描述已用本地规则识别，部分信息可能需要手动补充。";
          console.error("[刀刀文字识别失败]", error.message || error);
        }
      }

      if (hasImage && VISION_READY && !hasPreExtraction) {
        try {
          extracted = await extractBargainImage(body.image);
        } catch (error) {
          visionNotice = "截图暂时没识别成功，已使用你手动填写的信息。";
          console.error("[刀刀截图识别失败]", error.message || error);
        }
      } else if (hasImage && !VISION_READY) {
        visionNotice = "当前未配置图片识别，已使用你手动填写的信息。";
      }

      const itemName = shortText(body.itemName, 60) || shortText(textExtracted.itemName, 60) || shortText(extracted.itemName, 60);
      const listingPrice = priceNumber(body.listingPrice) ?? priceNumber(textExtracted.listingPrice) ?? priceNumber(extracted.listingPrice);
      const offerPrice = priceNumber(body.offerPrice) ?? priceNumber(textExtracted.offerPrice) ?? priceNumber(extracted.offerPrice);
      const originalPrice = priceNumber(body.originalPrice) ?? priceNumber(textExtracted.originalPrice) ?? priceNumber(extracted.originalPrice);
      const floorPrice = priceNumber(body.floorPrice) ?? priceNumber(textExtracted.floorPrice);
      const category = shortText(body.category, 30) || shortText(textExtracted.category, 30);
      const condition = shortText(body.condition, 30) || shortText(textExtracted.condition, 30);
      const usageDetails = shortText(body.usageDetails, 120);
      const negotiationPreference = shortText(body.negotiationPreference, 30);
      const counterpartyTone = shortText(body.counterpartyTone, 30) || "正常沟通";
      const urgency = shortText(body.urgency, 10);
      const note = shortText(body.note, 300);
      const comparablePrices = priceList(body.comparablePrices);

      if (listingPrice === null || listingPrice <= 0) {
        const message = hasImage && !VISION_READY ? "当前图片识别未配置，请手动填写挂牌价" : "请上传清晰截图或填写有效的挂牌价";
        return send(res, 400, { error:message });
      }
      if (offerPrice === null) {
        const message = role === "buyer"
          ? "请填写你准备出的价格"
          : (hasImage && !VISION_READY ? "当前图片识别未配置，请手动填写买家报价" : "请上传清晰截图或填写有效的买家报价");
        return send(res, 400, { error:message });
      }
      if (role === "buyer" && offerPrice <= 0) return send(res, 400, { error:"准备出价必须大于0" });
      if (originalPrice !== null && originalPrice <= 0) return send(res, 400, { error:"商品原价必须大于0" });
      if (floorPrice !== null && floorPrice <= 0) return send(res, 400, { error:role === "buyer" ? "预算必须大于0" : "心理底价必须大于0" });
      if (role === "buyer" && floorPrice !== null && offerPrice > floorPrice) {
        return send(res, 400, { error:"准备出价不能超过最高预算" });
      }

      const cutAmount = Math.max(0, Math.round((listingPrice - offerPrice) * 100) / 100);
      const cutPercent = Math.round(Math.max(0, cutAmount / listingPrice * 100) * 10) / 10;

      let research;
      let searchNotice = "";
      try {
        research = await researchMarket({ itemName,category,condition,usageDetails,originalPrice });
      } catch (error) {
        research = unavailableResearch("unavailable", "联网查价暂时没有成功，本次先按砍价幅度和你提供的信息判断。");
        searchNotice = "联网查价暂时不可用，稍后可以再试。";
        console.error("[刀刀联网查价失败]", error.message || error);
      }

      if (role === "buyer") {
        const guidance = buyerPriceGuidance({ listingPrice, offerPrice, budget:floorPrice, suggestion:research.suggestion });
        const level = buyerBargainLevel(cutPercent, guidance);
        const reasoning = buyerAnalysis({ itemName, listingPrice, offerPrice, floorPrice, condition, cutAmount, cutPercent, level, research, guidance });
        const recommendedScript = recommendedScriptForTone(counterpartyTone, "buyer", urgency);

        return send(res, 200, {
          role:"buyer",
          itemName:itemName || "这款商品",
          listingPrice,offerPrice,originalPrice,floorPrice,counterpartyTone,cutAmount,cutPercent,
          level:level.label,tone:level.tone,
          ...reasoning,
          research,
          scripts:buyerScripts({ listingPrice,offerPrice,suggestion:research.suggestion,guidance,counterpartyTone }),
          recommendedScript,
          screenshotFacts:cleanStringArray(extracted.visibleFacts,[]),
          analysisMode:research.status === "ready" && research.suggestion ? "联网查价判断" : "价格规则判断",
          notice:[visionNotice,textNotice,searchNotice].filter(Boolean).join(" "),
          disclaimer:"结果只用于议价参考，不代表平台真实成交价。",
        });
      }

      const level = bargainLevel(cutPercent);
      const comparison = comparablePrices.length ? {
        source:"你提供的同款参考价",
        count:comparablePrices.length,
        min:Math.min(...comparablePrices),
        max:Math.max(...comparablePrices),
        median:median(comparablePrices),
      } : null;
      const researchEvidence = { ...research,sources:research.sources.map((source) => source.title) };
      const evidence = { itemName,listingPrice,offerPrice,originalPrice,floorPrice,category,condition,usageDetails,negotiationPreference,counterpartyTone,urgency,
        description,note,comparablePrices,cutAmount,cutPercent,level:level.label,research:researchEvidence,
        screenshotFacts:cleanStringArray(extracted.visibleFacts,[]),chatSummary:shortText(extracted.chatSummary,120) };
      const fallback = fallbackBargain({ ...evidence,level,research });
      let reasoning = fallback;
      let aiUsed = false;
      let aiNotice = "";

      if (LLM_READY) {
        try {
          const ai = await askJSON(BARGAIN_REASON_SYS, `请基于以下证据判断，数字和事实都不得自行补充：\n${JSON.stringify(evidence)}`);
          reasoning = {
            verdict: shortText(ai.verdict, 100) || fallback.verdict,
            boundary: research.status === "ready" ? fallback.boundary : shortText(ai.boundary, 140) || fallback.boundary,
            factors: cleanStringArray(ai.factors, fallback.factors),
            missing: actionableMissingArray(ai.missing, fallback.missing, evidence),
            actionText: shortText(ai.actionText, 100) || fallback.actionText,
          };
          aiUsed = true;
        } catch (error) {
          aiNotice = "智能分析暂时不可用，已用价格规则完成判断。";
          console.error("[刀刀分析失败]", error.message || error);
        }
      }

      return send(res, 200, {
        role:"seller",
        itemName:itemName || "这件商品",
        listingPrice,offerPrice,originalPrice,floorPrice,counterpartyTone,cutAmount,cutPercent,
        listingToOriginalPercent:originalPrice ? Math.round(listingPrice / originalPrice * 1000) / 10 : null,
        level:level.label,tone:level.tone,comparison,
        ...reasoning,
        research,
        scripts:sellerScripts({ listingPrice,offerPrice,floorPrice,urgency,negotiationPreference,counterpartyTone }),
        recommendedScript:recommendedScriptForTone(counterpartyTone, "seller", urgency),
        screenshotFacts:evidence.screenshotFacts,
        analysisMode:research.status === "ready" ? "联网查价判断" : aiUsed ? "AI辅助判断" : "价格规则判断",
        notice:[visionNotice,textNotice,searchNotice,aiNotice].filter(Boolean).join(" "),
        disclaimer:"结果只用于议价参考，不代表平台真实成交价。",
      });
    } catch (error) {
      return send(res, 500, { error:String(error.message || error) });
    }
  }

  if (req.method === "POST" && req.url === "/api/challenges") {
    const body = await readBody(req);
    const mode = body.mode === "blind" ? "blind" : "teaching";
    const scenario = mode === "blind"
      ? BLIND_SCENARIO_IDS[crypto.randomInt(BLIND_SCENARIO_IDS.length)]
      : body.scenario;
    if (!DRILL_SCENARIOS_SERVER[scenario]) return send(res, 400, { error:"unknown scenario" });
    if (FAMILY_CHALLENGES.size >= 500) FAMILY_CHALLENGES.delete(FAMILY_CHALLENGES.keys().next().value);
    const id = crypto.randomBytes(9).toString("base64url");
    const challenge = { id,scenario,mode,sender:String(body.sender||"家人").slice(0,12),
      target:String(body.target||"长辈").slice(0,12),status:"pending",createdAt:Date.now(),result:null };
    FAMILY_CHALLENGES.set(id,challenge);
    return send(res, 201, publicChallenge(challenge));
  }

  const challengeRoute = req.url.match(/^\/api\/challenges\/([A-Za-z0-9_-]+)(?:\/(complete|start))?$/);
  if (challengeRoute && req.method === "GET" && !challengeRoute[2]) {
    const challenge = FAMILY_CHALLENGES.get(challengeRoute[1]);
    if (!challenge || Date.now()-challenge.createdAt > 30*86400000) return send(res, 404, { error:"challenge not found" });
    return send(res, 200, publicChallenge(challenge));
  }
  if (challengeRoute && req.method === "POST" && challengeRoute[2] === "start") {
    const challenge = FAMILY_CHALLENGES.get(challengeRoute[1]);
    if (!challenge || Date.now()-challenge.createdAt > 30*86400000) return send(res, 404, { error:"challenge not found" });
    challenge.startedAt = challenge.startedAt || Date.now();
    return send(res, 200, { id:challenge.id,scenario:challenge.scenario,mode:challenge.mode||"teaching" });
  }
  if (challengeRoute && req.method === "POST" && challengeRoute[2] === "complete") {
    const challenge = FAMILY_CHALLENGES.get(challengeRoute[1]);
    if (!challenge) return send(res, 404, { error:"challenge not found" });
    const body = await readBody(req);
    const score = Math.max(0,Math.min(100,Math.round(Number(body.score)||0)));
    const flags = Array.isArray(body.flags)?body.flags.slice(0,4).map(x=>String(x).slice(0,80)):[];
    const answer = scenarioAnswer(challenge.scenario);
    const riskProfile = score >= 85
      ? ["已掌握：" + answer.focus]
      : (flags.length ? flags.slice(0,2) : ["需要加强：" + answer.focus]);
    challenge.status="completed";challenge.completedAt=Date.now();
    challenge.result={score,verdict:String(body.verdict||"练习完成").slice(0,120),
      flags,wellDone:Array.isArray(body.wellDone)?body.wellDone.slice(0,3).map(x=>String(x).slice(0,80)):[],
      answer,riskProfile};
    return send(res, 200, publicChallenge(challenge));
  }

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
      const scenarioMeta = DRILL_SCENARIOS_SERVER[scenario];
      if (!scenarioMeta) return send(res, 400, { error:"unknown scenario" });
      const scenarioDesc = scenarioMeta.description;

      if (phase === "chat") {
        const transcript = (history || []).map(m => (m.role === "assistant" ? "来电人" : m.role === "system" ? "练习系统" : "用户") + "：" + m.content).join("\n");
        const callerSystem = scenarioMeta.kind === "scam" ? DRILL_SCAMMER_SYS : scenarioMeta.kind === "low_risk" ? DRILL_LOW_RISK_SYS : DRILL_VERIFY_SYS;
        const userMsg = `场景：${scenarioDesc}\n\n${transcript ? "对话历史：\n" + transcript + "\n\n" : ""}请${transcript ? "继续扮演来电人，说下一句" : "说来电人的开场白（第一句话）"}。`;
        const out = await askJSONChat(callerSystem, userMsg);
        return send(res, 200, { reply: out.reply || "...", shouldEnd: !!out.shouldEnd });
      }

      if (phase === "score") {
        const transcript = (history || []).map(m => (m.role === "assistant" ? "来电人" : m.role === "system" ? "练习系统" : "用户") + "：" + m.content).join("\n");
        const scoreSystem = scenarioMeta.kind === "scam" ? DRILL_SCORE_SYS : scenarioMeta.kind === "low_risk" ? DRILL_SCORE_LOW_RISK_SYS : DRILL_SCORE_VERIFY_SYS;
        const scored = await askJSON(scoreSystem, `场景：${scenarioDesc}\n\n完整对话：\n${transcript}`);
        const out = scenarioMeta.kind === "scam" ? enforceMockCodeSafety(history, scored) : scored;
        return send(res, 200, { ...out,answer:scenarioAnswer(scenario) });
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
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;
  let f = pathname;
  if (pathname === "/") f = requestUrl.searchParams.has("challenge") ? "/index.html" : "/daodao.html";
  if (pathname === "/legacy") f = "/index.html";
  const fp = path.join(__dirname, f);
  if (fp.startsWith(__dirname) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
    const ext = path.extname(fp);
    const ct = ext === ".html" ? "text/html; charset=utf-8" : ext === ".js" ? "text/javascript" : ext === ".css" ? "text/css" : "text/plain; charset=utf-8";
    return send(res, 200, fs.readFileSync(fp), ct);
  }
  send(res, 404, "not found", "text/plain");
});

const DEFAULT_MENU = `【老李家饭馆·超值特惠】招牌爆款！西红柿鸡蛋盖浇饭￥18元（赠例汤）| 主厨推荐★清炒时令蔬菜￥12 | 老火慢炖·紫菜蛋花汤￥6 | 招牌红烧肉盖饭￥26（大份加3元）| 香辣鸡腿堡套餐￥22 | 现磨豆浆￥4/杯 | 米饭￥2/碗`;

server.listen(PORT, () => console.log(`刀刀 on :${PORT} (model ${MODEL})`));
