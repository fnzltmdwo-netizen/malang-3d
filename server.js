// 말랑 3D 스튜디오 서버 (외부 패키지 없음, Node 18+)
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
function todayStr() { return new Date().toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }); }
function rollDay() { const t = todayStr(); if (cfg.today !== t) { cfg.today = t; cfg.todayCount = 0; save(); } }

const STYLES = {
  pixar: "a high-quality 3D animated movie character (Pixar/Disney-style 3D CGI render), big expressive eyes, soft subsurface-scattering skin, cinematic studio lighting, shallow depth of field",
  toy: "a cute 3D vinyl toy figure / collectible figurine, glossy plastic material, clean studio product lighting, simple pastel background",
  clay: "a claymation stop-motion 3D character, handmade clay texture with subtle fingerprints, warm soft lighting",
  game: "a stylized 3D game character render, clean smooth shading, vibrant colors, dynamic rim light",
};
const promptFor = (s) => `Transform this person into ${STYLES[s] || STYLES.pixar}. Keep the same face identity, hairstyle, expression, pose, clothing and background composition so the person is clearly recognizable. Output a polished, finished render.`;

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

// ---------- OpenAI 변환 ----------
async function convert(imageBuf, style) {
  const form = new FormData();
  form.append("model", "gpt-image-1");
  form.append("prompt", promptFor(style));
  form.append("size", "1024x1024");
  form.append("quality", cfg.quality || "medium");
  form.append("image", new Blob([imageBuf], { type: "image/png" }), "photo.png");
  const r = await fetch("https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${cfg.apiKey}` }, body: form });
  const text = await r.text(); let data = {};
  try { data = JSON.parse(text); } catch {}
  if (!r.ok) {
    const m = data.error?.message || text.slice(0, 200);
    if (r.status === 401) throw new Error("관리자가 등록한 API 키가 올바르지 않아요. 관리자에게 알려주세요.");
    if (r.status === 403 && /verif/i.test(m)) throw new Error("OpenAI 조직 인증이 필요해요. (관리자: platform.openai.com → Settings → Organization → Verify)");
    if (r.status === 429) throw new Error("지금 요청이 몰렸거나 크레딧이 부족해요. 잠시 후 다시 시도해 주세요.");
    if (/safety|moderation/i.test(m)) throw new Error("이 사진은 안전 정책으로 변환이 거절됐어요. 다른 사진으로 시도해 주세요.");
    throw new Error("변환 오류: " + m);
  }
  return data.data[0].b64_json;
}

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
      const b64 = await convert(buf, url.searchParams.get("style") || "pixar");
      hits.push(now); ipHits.set(ip, hits);
      cfg.todayCount++; cfg.total++; save();
      return send(res, 200, { image: "data:image/png;base64," + b64 });
    }
    if (p === "/api/status") { rollDay(); return send(res, 200, { ready: !!cfg.apiKey, left: cfg.dailyLimit > 0 ? Math.max(0, cfg.dailyLimit - cfg.todayCount) : null }); }

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
    const file = path.join(PUBLIC, p === "/" ? "index.html" : p === "/admin" ? "admin.html" : path.normalize(p));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e); send(res, 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`▶ 사이트 http://localhost:${PORT}   관리자 http://localhost:${PORT}/admin  (비밀번호: ${ADMIN_PASSWORD === "admin1234" ? "admin1234 ← 꼭 바꾸세요" : "환경변수 설정됨"})`));
