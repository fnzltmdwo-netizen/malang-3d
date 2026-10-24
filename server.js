// 말랑 스튜디오 서버 (외부 패키지 없음, Node 18+)
// 새 변환 기능은 presets-v숫자.json, 새 화면은 public/page-v숫자.html 로 추가 → server.js 수정 없이 업데이트 가능
// 실행: node server.js   /   관리자: http://localhost:3000/admin
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, "config.json");
const PUBLIC = path.join(__dirname, "public");
const MAX_UPLOAD = 12 * 1024 * 1024;

// ---------- 설정 저장 (파일) ----------
let cfg = { apiKey: "", dailyLimit: 50, perIpLimit: 5, quality: "medium", total: 0, today: "", todayCount: 0 };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) }; } catch {}
if (!cfg.apiKey && process.env.OPENAI_API_KEY) cfg.apiKey = process.env.OPENAI_API_KEY;
const save = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(cfg, null, 2)); } catch (e) { console.error("설정 저장 실패:", e.message); } };

const ipHits = new Map(); // ip -> [timestamps]
const keepHits = new Map();
const RESULTS = path.join(require("os").tmpdir(), "malang-results"); fs.mkdirSync(RESULTS, { recursive: true });
setInterval(() => { try { for (const f of fs.readdirSync(RESULTS)) { const fp = path.join(RESULTS, f); if (Date.now() - fs.statSync(fp).mtimeMs > 2 * 3600e3) fs.unlinkSync(fp); } } catch {} }, 10 * 60e3); // 2시간 뒤 자동 삭제
function todayStr() { return new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }); }
function rollDay() { const t = todayStr(); if (cfg.today !== t) { cfg.today = t; cfg.todayCount = 0; save(); } }

const PROMPT = `Re-render this exact photo as a high-quality 3D animated movie still (Pixar / Disney-style 3D CGI look).
IDENTITY MUST BE PRESERVED: this must be clearly recognizable as the SAME PERSON. Keep the same face shape, facial proportions, eyes, eyebrows, nose, mouth, skin tone, age, hairstyle and hair color, glasses, facial hair, and expression. Keep the same pose, framing, clothing and background composition.
IMPORTANT: keep the eyes at their natural, realistic size and spacing exactly as in the photo. Do NOT enlarge the eyes, do NOT exaggerate or cartoonify any facial feature, keep all facial proportions realistic.
Only change the rendering style: smooth stylized 3D skin with subtle subsurface scattering, soft cinematic studio lighting, shallow depth of field, polished CGI materials. Do not change who the person is.`;

// ---------- 헤어 변경 ----------
const HAIR = {
  dandy:    { name: "댄디컷",   desc: "a Korean dandy cut: soft natural fringe brushed down over the forehead, neat rounded shape, tidy tapered sides, natural black hair" },
  twoblock: { name: "투블럭",   desc: "a Korean two-block cut: short clipped sides and back, longer textured top with fringe falling forward, natural black hair" },
  gareuma:  { name: "가르마펌", desc: "a Korean side-part perm (6:4 gareuma perm): hair parted on one side with soft C-curl waves sweeping away from the part, forehead partly visible, natural dark brown hair" },
  ash:      { name: "애즈펌",   desc: "a Korean 'as' perm: medium-length fringe with gentle inward C-curls at the tips framing the forehead and eyebrows, soft volume, natural dark hair" },
  leaf:     { name: "리프컷",   desc: "a Korean leaf cut: fringe split in the middle and swept outward to both sides like leaves, light layered volume, natural dark hair" },
  shadow:   { name: "쉐도우펌", desc: "a Korean shadow perm: medium-length hair with subtle loose waves and airy texture, fringe slightly covering the forehead, natural dark hair" },
  slick:    { name: "슬릭백",   desc: "a slicked-back pomade style: all hair combed straight back with a clean glossy finish, short faded sides, forehead fully visible" },
  crop:     { name: "크롭컷",   desc: "a textured crop cut: very short sides with skin fade, short choppy textured top with a short blunt fringe" },
  hippie:   { name: "히피펌",   desc: "a hippie perm: shoulder-skimming medium-long hair with lots of loose curly waves and big natural volume" },
  buzz:     { name: "반삭",     desc: "a clean buzz cut: hair evenly clipped very short all over the head" },
};
const hairPrompt = (k) => `Edit this photo: change ONLY the man's hairstyle to ${HAIR[k].desc}.
This must stay a real, photorealistic photograph of the EXACT SAME PERSON. Do not change the face at all: same face shape, eyes and eye size, eyebrows, nose, mouth, ears, skin tone and skin texture, facial hair, age and expression. Keep the same head angle, pose, framing, clothing, background, lighting and camera quality.
The new hair must look natural and realistic on his head, with correct hairline, realistic strands and believable lighting that matches the original photo. No beauty filter, no retouching, no cartoon or 3D style.`;

// ---------- 애니 주인공 변신 ----------
const ANIME = {
  retro:   { name: "90년대 셀애니", desc: "a 1990s Japanese TV cel animation frame: hand-painted cel shading with hard shadow edges, slightly muted retro colour palette, soft film grain and subtle VHS warmth, classic 90s anime eyes and hair shapes" },
  theater: { name: "극장판 감성",   desc: "a warm hand-drawn feature-film anime still: soft painterly watercolour backgrounds, gentle rounded character design, cozy natural light, calm nostalgic summer-day mood" },
  sky:     { name: "하늘 로맨스",   desc: "a modern romantic anime film still: ultra-detailed glowing sky and clouds, golden-hour light with lens flare and light particles, crisp clean line art, luminous saturated colours, emotional cinematic composition" },
  shonen:  { name: "소년만화 주인공", desc: "a bold shonen battle-manga hero illustration: thick confident ink lines, sharp determined eyes, dynamic dramatic shading, energy aura and speed lines in the background, high-contrast colours" },
  shojo:   { name: "순정만화",      desc: "a classic shojo manga illustration: large sparkling eyes with many highlights, delicate fine line art, floating flower petals and sparkles, soft pastel screentone background" },
  chibi:   { name: "SD 귀요미",     desc: "a cute chibi / super-deformed anime character: big head and tiny body (about 2.5 heads tall), round cheeks with blush, simple shiny eyes, playful pose, clean pastel background" },
  webtoon: { name: "웹툰 주인공",   desc: "a polished Korean webtoon panel: clean digital line art, soft cel shading with smooth gradients, attractive modern character design, bright clean colours, slice-of-life setting" },
  idol:    { name: "아이돌 애니",   desc: "a bright idol anime key visual: glossy colourful stage lighting, sparkling highlights, cheerful dynamic pose, vivid candy colours, star and light effects" },
};
const animePrompt = (k) => `Redraw this photo as a 2D anime illustration in this style: ${ANIME[k].desc}.
Make the person clearly recognizable as an anime version of THEMSELVES: keep the same hairstyle, hair colour and length, face shape, glasses and accessories, facial hair, skin tone, expression, pose, clothing and clothing colours, and the overall background composition.
Create an original character design in this art style. Do not draw or resemble any existing anime or cartoon character, and do not add text, logos, signatures or watermarks.`;

// ---------- 조선시대 초상화 ----------
const JOSEON = {
  // 남자
  king:        { name: "임금",        desc: "a Joseon king in a crimson dragon robe (gonryongpo) with gold five-claw dragon roundels on the chest and shoulders, a black ikseongwan crown and a jade belt, seated on a red lacquered throne before a muted Sun-Moon-Five-Peaks folding screen" },
  crownprince: { name: "세자",        desc: "a Joseon crown prince in a deep indigo dragon robe with gold roundels and a black ikseongwan crown, seated upright on a carved wooden chair in a quiet palace hall" },
  minister:    { name: "영의정",      desc: "a high-ranking Joseon prime minister in a dark crimson official robe (danryeongpo) with an embroidered double-crane rank badge on the chest, a black winged samo hat and a rhinoceros-horn belt, seated on a chair draped with a leopard skin, hands folded inside the sleeves" },
  inspector:   { name: "암행어사",    desc: "a secret royal inspector (amhaeng-eosa) in a plain, worn grey travelling robe and a battered black gat hat, proudly holding up a round bronze horse-tablet badge (mapae), standing at a village gate" },
  general:     { name: "대장군",      desc: "a Joseon military general in ornate red-and-gold studded armour and a brass-studded helmet, holding a ceremonial sword, seated upright with a fierce, dignified expression" },
  gwageo:      { name: "장원급제",    desc: "a young scholar who just placed first in the state examination, in a dark green robe and a samo hat with long paper flowers (eosahwa) arching from the hat, holding a rolled royal certificate, beaming proudly" },
  physician:   { name: "어의",        desc: "a royal court physician in a dark blue official robe and a black samo hat, holding fine acupuncture needles beside a wooden medicine chest with many small herb drawers" },
  painter:     { name: "도화서 화원", desc: "a royal court painter in a light blue robe and a black gat hat, holding a fine brush over a silk scroll on a low painting table with an ink stone and small pigment dishes" },
  seonbi:      { name: "선비",        desc: "a Joseon scholar (seonbi) in a white dopo robe with a thin black sash and a tall black horsehair gat hat, holding a folding fan, seated on a straw mat with a few old books and an ink stone beside him" },
  translator:  { name: "역관",        desc: "a Joseon interpreter-official in a light teal robe and a black gat hat, holding a stack of thread-bound foreign-language books, with a rolled map scroll beside him" },
  merchant:    { name: "보부상",      desc: "a travelling peddler (bobusang) in a grey jacket and a straw hat with white cotton tassels, carrying a large wooden A-frame back carrier (jige) loaded with goods, holding a walking stick" },
  pojol:       { name: "포졸",        desc: "a humble Joseon police constable (pojol) in a dark blue jacket with a red sash and a black felt hat, holding a wooden club, standing stiffly at attention with an earnest, slightly comical expression" },
  farmhand:    { name: "머슴",        desc: "a cheerful farmhand (meoseum) in rough beige hemp clothes with rolled-up trousers and a towel tied around the head, holding a hoe at the edge of a rice paddy" },
  yeot:        { name: "엿장수",      desc: "a cheerful taffy seller (yeot-jangsu) in plain hemp clothes and a straw hat, holding big iron taffy scissors and a wooden tray of yeot candy" },
  boatman:     { name: "뱃사공",      desc: "a ferryman in plain hemp clothes and a conical straw hat, standing in a small wooden boat on a misty river, holding a long bamboo pole" },
  // 여자
  queen:         { name: "왕비",        desc: "a Joseon queen in a deep blue ceremonial jeogui robe embroidered with pheasant patterns, a large ornate formal wig with gold hairpins and jade ornaments, seated on a royal chair before a muted Sun-Moon-Five-Peaks screen" },
  princess:      { name: "공주",        desc: "a Joseon princess in a bright green wonsam ceremonial robe with gold-leaf patterns, an elegant formal hairstyle with an ornate jewelled hairpin, seated in a palace pavilion beside blooming peonies" },
  lady:          { name: "정경부인",    desc: "a noble Joseon lady of the highest rank in a rich green wonsam robe with gold patterns, a formal braided wig with a long binyeo hairpin and norigae tassel ornaments, seated gracefully on a patterned mat" },
  royaldoctor:   { name: "의녀",        desc: "a royal female physician (uinyeo) in a neat light blue jeogori and dark chima with a black garima headpiece, holding acupuncture needles beside a wooden medicine chest" },
  warrior:       { name: "여협객",      desc: "a Joseon swordswoman in a dark indigo martial jacket with tied sleeves and a black gat hat with a long bead strap, holding a sword in its scabbard, calm and confident" },
  sanggung:      { name: "상궁",        desc: "a senior palace court lady (sanggung) in a dark green jeogori and deep blue chima with a neat formal braided hairstyle, holding a red lacquered royal food tray, dignified and stern" },
  femalepainter: { name: "여류 화원",   desc: "a gifted woman painter in a pale lavender jeogori and indigo chima, holding a brush over a silk scroll of plum blossoms, with ink stones beside her" },
  maiden:        { name: "규수",        desc: "a young Joseon noble maiden in a pastel yellow jeogori and a crimson chima, hair in a long single braid tied with a red daenggi ribbon, holding a small embroidered pouch, beside a branch of plum blossom" },
  gaekju:        { name: "객주",        desc: "a wealthy merchant-inn owner in a rich brown jeogori and a dark chima, holding an abacus and a thread-bound ledger, with sacks of goods behind her" },
  seamstress:    { name: "침방 나인",   desc: "a palace seamstress in a pale pink jeogori and a green chima, sewing fine silk embroidery at a low wooden table" },
  jumo:          { name: "주모",        desc: "a cheerful tavern keeper (jumo) in a plain white jeogori and a dark chima with an apron, hair in a simple bun with a wooden pin, holding a gourd ladle beside a big earthenware jar of makgeolli" },
  laundry:       { name: "빨래터 아낙", desc: "a village woman in plain white hemp clothes with her sleeves rolled up, beating laundry with a wooden paddle on a flat stone beside a stream" },
  tteok:         { name: "떡장수",      desc: "a cheerful rice-cake seller in plain hemp clothes and a head scarf, carrying a big round basket of colourful tteok on her head" },
  herb:          { name: "나물 처녀",   desc: "a country girl in a faded yellow jeogori and a red chima, holding a small knife and a basket of wild spring greens on a hillside" },
};
const JOSEON_TEMPLATE = `Repaint this photo as an authentic 18th-century Joseon dynasty Korean portrait painting (chosang-hwa): ink and mineral pigments on aged, slightly yellowed silk, extremely fine brush linework, subtle layered shading on the face in the traditional Joseon portrait technique, plain muted silk background, tall vertical hanging-scroll composition, leaving a generous empty area of plain silk in the upper right corner.
Paint the sitter as {desc}.
LIKENESS: the sitter must be clearly recognizable as THIS SAME PERSON from the photo: keep their exact face shape, eyes and eye size, eyebrows, nose, mouth, ears, skin tone, age, facial hair and natural expression, and keep their gender. If they wear glasses, paint them as round Joseon-era spectacles.
NATURAL RESULT: make it look like one real painting made by a Joseon court painter, not a photo pasted onto a painting. Paint the face with the same brushwork, pigments and soft lighting as the clothing and background. Give the body realistic proportions for the pose, draw the hands correctly, and keep the head size natural for the body. Props and background should suit the role but stay simple and uncluttered, as in real Joseon portraits.
Do not write any text, letters, hanja, calligraphy or red seals anywhere in the image. No modern clothing or modern objects.`;

// 모드 = { size, template("{desc}" 자리에 스타일 설명), styles }  ※ presets-v숫자.json 으로 덮어쓰기/추가 가능
const BUILTIN_MODES = {
  anim:   { size: "1024x1024", template: "{desc}", styles: { default: { name: "3D 캐릭터", desc: PROMPT } } },
  hair:   { size: "1024x1024", styles: Object.fromEntries(Object.entries(HAIR).map(([k, v]) => [k, { name: v.name, prompt: hairPrompt(k) }])) },
  anime:  { size: "1024x1024", styles: Object.fromEntries(Object.entries(ANIME).map(([k, v]) => [k, { name: v.name, prompt: animePrompt(k) }])) },
  joseon: { size: "1024x1536", fidelity: "low", template: JOSEON_TEMPLATE, styles: JOSEON },
};
function latestFile(dir, re) {
  try {
    const list = fs.readdirSync(dir).map((f) => ({ f, v: +(f.match(re) || [])[1] })).filter((x) => x.v > 0);
    if (list.length) return list.sort((a, b) => b.v - a.v)[0].f;
  } catch {}
  return null;
}
let presetCache = { file: null, modes: BUILTIN_MODES };
function getModes() {
  const f = latestFile(__dirname, /^presets-v(\d+)\.json$/);
  if (!f) return BUILTIN_MODES;
  if (presetCache.file === f) return presetCache.modes;
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8")).modes || {};
    const merged = { ...BUILTIN_MODES };
    for (const [k, m] of Object.entries(extra)) merged[k] = { ...(merged[k] || {}), ...m, styles: { ...((merged[k] || {}).styles || {}), ...(m.styles || {}) } };
    presetCache = { file: f, modes: merged };
    console.log("프리셋 불러옴:", f);
  } catch (e) { console.error("프리셋 오류:", f, e.message); presetCache = { file: f, modes: BUILTIN_MODES }; }
  return presetCache.modes;
}
function buildPrompt(modeKey, styleKey) {
  const m = getModes()[modeKey]; if (!m) return null;
  const st = (m.styles || {})[styleKey]; if (!st) return null;
  return {
    prompt: st.prompt || (m.template || "{desc}").replace("{desc}", st.desc || ""),
    size: st.size || m.size || "1024x1024",
    fidelity: st.fidelity || m.fidelity || "high",   // high = 사진 얼굴을 거의 그대로, low = 생김새만 참고해 새로 그림
    quality: st.quality || m.quality || null,        // 없으면 관리자 페이지 설정
    model: st.model || m.model || null,
    refs: st.refs || m.refs || [],                   // 그림체 참고용 이미지 파일들 (서버 폴더 기준 경로)
  };
}

// ---------- 유틸 ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function isAdmin(req) {
  const t = req.headers["x-admin-token"] || "";
  return t.length === ADMIN_PASSWORD.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(ADMIN_PASSWORD));
}
const clientIp = (req) => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;

// ---------- 그림체 참고 이미지 ----------
const refCache = new Map();
function loadRef(rel) {
  try {
    const fp = path.join(__dirname, path.normalize(rel));
    if (!fp.startsWith(__dirname)) return null;
    if (!refCache.has(fp)) {
      const ext = path.extname(fp).toLowerCase();
      refCache.set(fp, { buf: fs.readFileSync(fp), type: ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg", name: path.basename(fp) });
    }
    return refCache.get(fp);
  } catch (e) { console.error("참고 이미지 없음:", rel); return null; }
}

// ---------- OpenAI 변환 ----------
const MODELS = ["gpt-image-1.5", "gpt-image-1"]; // 최신 모델 먼저, 없으면 자동으로 다음 모델
async function convert(imageBuf, prompt = PROMPT, size = "1024x1024", model = MODELS[0], opt = {}) {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", prompt);
  form.append("size", size);
  form.append("quality", opt.quality || cfg.quality || "medium");
  form.append("input_fidelity", opt.fidelity || "high"); // high = 얼굴 그대로 보존, low = 자연스럽게 새로 그림
  const refs = (opt.refs || []).map(loadRef).filter(Boolean);
  if (refs.length) {
    form.append("image[]", new Blob([imageBuf], { type: "image/png" }), "photo.png");   // 1번 = 사용자 사진
    for (const r of refs) form.append("image[]", new Blob([r.buf], { type: r.type }), r.name); // 2번~ = 그림체 참고
  } else {
    form.append("image", new Blob([imageBuf], { type: "image/png" }), "photo.png");
  }
  const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
  const text = await r.text(); let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const m = data.error?.message || text.slice(0, 200);
    const next = MODELS[MODELS.indexOf(model) + 1];
    if (next && (r.status === 404 || /model|not found|does not exist|invalid_request/i.test(m) && /model/i.test(m))) { console.log(`${model} 사용 불가 → ${next}로 재시도`); return convert(imageBuf, prompt, size, next, opt); }
    if (r.status === 401) { console.error("OpenAI 401:", m); throw new Error("OpenAI가 API 키를 거절했어요. 관리자에게 알려주세요. (" + m.slice(0, 90) + ")"); }
    if (r.status === 403 && /verif/i.test(m)) throw new Error("OpenAI 조직 인증이 필요해요. (관리자: platform.openai.com → Settings → Organization → Verify)");
    if (r.status === 429) throw new Error("지금 요청이 몰렸거나 크레딧이 부족해요. 잠시 후 다시 시도해 주세요.");
    if (/safety|moderation/i.test(m)) throw new Error("이 사진은 안전 정책으로 변환이 거절됐어요. 다른 사진으로 시도해 주세요.");
    throw new Error("변환 오류: " + m);
  }
  return data.data[0].b64_json;
}

// 메인 페이지 = public/page-v숫자.html 중 가장 높은 번호 (없으면 index.html)
// ---------- 사진 분석 (얼굴 보고 JSON으로 답하기) ----------
const VISION_MODELS = ["gpt-4.1-mini", "gpt-4o-mini", "gpt-5-mini"];
async function analyzeImage(imageBuf, system, userText, models = VISION_MODELS, idx = 0) {
  const model = models[idx];
  const body = {
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: [
        { type: "text", text: userText },
        { type: "image_url", image_url: { url: "data:image/png;base64," + imageBuf.toString("base64"), detail: "low" } },
      ] },
    ],
  };
  const r = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text(); let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const m = data.error?.message || text.slice(0, 200);
    if (models[idx + 1] && (r.status === 404 || /model/i.test(m))) { console.log(`${model} 분석 불가 → ${models[idx + 1]}`); return analyzeImage(imageBuf, system, userText, models, idx + 1); }
    if (r.status === 401) throw new Error("OpenAI가 API 키를 거절했어요. 관리자에게 알려주세요. (" + m.slice(0, 90) + ")");
    if (r.status === 429) throw new Error("지금 요청이 몰렸거나 크레딧이 부족해요. 잠시 후 다시 시도해 주세요.");
    throw new Error("분석 오류: " + m);
  }
  try { return JSON.parse(data.choices[0].message.content); } catch { throw new Error("분석 결과를 읽지 못했어요. 다시 시도해 주세요."); }
}
const analyzeHits = new Map();

function latestPage() { return latestFile(PUBLIC, /^page-v(\d+)\.html$/) || "index.html"; }

// ---------- 서버 ----------
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    // 사용자: 변환
    if (req.method === "POST" && p === "/api/convert") {
      rollDay();
      if (!cfg.apiKey) return send(res, 503, { error: "아직 관리자가 API 키를 등록하지 않았어요." });
      if (cfg.dailyLimit > 0 && cfg.todayCount >= cfg.dailyLimit) return send(res, 429, { error: "오늘 변환 가능한 횟수를 모두 사용했어요. 내일 다시 와주세요!" });
      const ip = clientIp(req), now = Date.now();
      const hits = (ipHits.get(ip) || []).filter((t) => now - t < 3600e3);
      if (cfg.perIpLimit > 0 && hits.length >= cfg.perIpLimit) return send(res, 429, { error: `한 시간에 ${cfg.perIpLimit}번까지만 변환할 수 있어요. 잠시 후 다시 시도해 주세요.` });
      let buf; try { buf = await readBody(req, MAX_UPLOAD); } catch { return send(res, 413, { error: "사진이 너무 커요 (12MB 이하)" }); }
      const job = buildPrompt(url.searchParams.get("mode") || "anim", url.searchParams.get("style") || "default");
      if (!job) return send(res, 400, { error: "스타일을 다시 골라 주세요." });
      const b64 = await convert(buf, job.prompt, job.size, job.model || MODELS[0], { fidelity: job.fidelity, quality: job.quality, refs: job.refs });
      hits.push(now); ipHits.set(ip, hits);
      cfg.todayCount++; cfg.total++; save();
      const id = crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path.join(RESULTS, id + ".png"), Buffer.from(b64, "base64"));
      return send(res, 200, { image: "data:image/png;base64," + b64, url: `/img/${id}.png` });
    }
    // 화면에서 꾸민 최종 이미지 보관 (폰 저장용 주소 발급)
    if (req.method === "POST" && p === "/api/keep") {
      const ip = clientIp(req), now = Date.now();
      const kh = (keepHits.get(ip) || []).filter((t) => now - t < 3600e3);
      if (kh.length >= 40) return send(res, 429, { error: "잠시 후 다시 시도해 주세요." });
      let buf; try { buf = await readBody(req, 10 * 1024 * 1024); } catch { return send(res, 413, { error: "이미지가 너무 커요" }); }
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return send(res, 400, { error: "PNG 이미지만 가능해요" });
      kh.push(now); keepHits.set(ip, kh);
      const id = crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path.join(RESULTS, id + ".png"), buf);
      return send(res, 200, { url: `/img/${id}.png` });
    }
    // 결과 이미지 (?dl=1 이면 다운로드로)
    const im = p.match(/^\/img\/([a-f0-9]{16})\.png$/);
    if (im) {
      const fp = path.join(RESULTS, im[1] + ".png");
      if (!fs.existsSync(fp)) return send(res, 404, "만료된 이미지예요. 다시 변환해 주세요.", "text/plain; charset=utf-8");
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=7200", ...(url.searchParams.get("dl") ? { "Content-Disposition": 'attachment; filename="malang-' + im[1].slice(0, 6) + '.png"' } : {}) });
      return fs.createReadStream(fp).pipe(res);
    }
    // 사용자: 사진 분석 (예: 동물상) — presets 의 mode.analyze 설정을 사용
    if (req.method === "POST" && p === "/api/analyze") {
      if (!cfg.apiKey) return send(res, 503, { error: "아직 관리자가 API 키를 등록하지 않았어요." });
      const m = getModes()[url.searchParams.get("mode") || ""];
      if (!m || !m.analyze) return send(res, 400, { error: "분석할 수 없는 기능이에요." });
      const ip = clientIp(req), now = Date.now();
      const ah = (analyzeHits.get(ip) || []).filter((t) => now - t < 3600e3);
      if (ah.length >= (m.analyze.perIpLimit || 30)) return send(res, 429, { error: "분석을 너무 많이 했어요. 잠시 후 다시 시도해 주세요." });
      let buf; try { buf = await readBody(req, MAX_UPLOAD); } catch { return send(res, 413, { error: "사진이 너무 커요 (12MB 이하)" }); }
      const list = Object.entries(m.styles || {}).map(([k, v]) => `${k}=${v.name}`).join(", ");
      const out = await analyzeImage(buf, (m.analyze.system || "").replace("{list}", list), (m.analyze.user || "Analyze this photo.").replace("{list}", list), m.analyze.models || VISION_MODELS);
      ah.push(now); analyzeHits.set(ip, ah);
      cfg.analyzeTotal = (cfg.analyzeTotal || 0) + 1; save();
      return send(res, 200, out);
    }
    if (p === "/api/status") { rollDay(); return send(res, 200, { modes: Object.fromEntries(Object.entries(getModes()).map(([mk, m]) => [mk, Object.fromEntries(Object.entries(m.styles || {}).map(([k, v]) => [k, v.name]))])), ready: !!cfg.apiKey, left: cfg.dailyLimit > 0 ? Math.max(0, cfg.dailyLimit - cfg.todayCount) : null }); }

    // 관리자 API
    if (p.startsWith("/api/admin")) {
      if (!isAdmin(req)) return send(res, 401, { error: "비밀번호가 틀렸어요" });
      rollDay();
      if (req.method === "GET") {
        const k = cfg.apiKey;
        return send(res, 200, { keyMasked: k ? k.slice(0, 7) + "…" + k.slice(-4) : "", hasKey: !!k, dailyLimit: cfg.dailyLimit, perIpLimit: cfg.perIpLimit, quality: cfg.quality, total: cfg.total, todayCount: cfg.todayCount, today: cfg.today, defaultPw: ADMIN_PASSWORD === "admin1234", persistent: !!process.env.DATA_DIR });
      }
      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req, 1e5)).toString() || "{}");
        if (typeof body.apiKey === "string") cfg.apiKey = body.apiKey.trim();
        if (body.dailyLimit != null) cfg.dailyLimit = Math.max(0, +body.dailyLimit | 0);
        if (body.perIpLimit != null) cfg.perIpLimit = Math.max(0, +body.perIpLimit | 0);
        if (["low", "medium", "high"].includes(body.quality)) cfg.quality = body.quality;
        if (body.resetToday) cfg.todayCount = 0;
        save();
        return send(res, 200, { ok: true });
      }
    }

    // 정적 파일
    const named = /^\/([a-z][a-z0-9]{1,20})\/?$/.exec(p);
    const sub = named && named[1] !== "admin" ? latestFile(PUBLIC, new RegExp("^" + named[1] + "-v(\\d+)\\.html$")) : null;
    const file = path.join(PUBLIC, p === "/" ? latestPage() : p === "/admin" ? "admin.html" : sub ? sub : path.normalize(p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e); send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`▶ 사이트 http://localhost:${PORT}   관리자 http://localhost:${PORT}/admin  (비밀번호: ${ADMIN_PASSWORD === "admin1234" ? "admin1234 ← 꼭 바꾸세요" : "환경변수 설정됨"})`));
