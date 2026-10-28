/* TourHub — servidor multi-usuário (API + banco de dados SQLite) */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const nodemailer = require("nodemailer");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const IS_PROD = process.env.NODE_ENV === "production";
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@tourhub.app").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SESSION_TTL = 12 * 60 * 60 * 1000; /* 12 horas */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "tourhub.db");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

/* ---------- SEGURANÇA: cabeçalhos HTTP ---------- */
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' 'unsafe-inline' https://accounts.google.com; " +
    "connect-src 'self' https://accounts.google.com https://www.googleapis.com; " +
    "frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'; form-action 'self'");
  if (IS_PROD) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

/* ---------- SEGURANÇA: força HTTPS em produção ---------- */
app.use((req, res, next) => {
  if (IS_PROD && req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"] !== "https")
    return res.redirect(301, "https://" + req.headers.host + req.originalUrl);
  next();
});

/* ---------- SEGURANÇA: limite de requisições ---------- */
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = (req.ip || "x") + ":" + req.path;
    const t = Date.now();
    const arr = (hits.get(key) || []).filter(ts => t - ts < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: "Muitas tentativas. Tente novamente em instantes." });
    arr.push(t); hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    next();
  };
}
const loginLimiter = rateLimit(10, 5 * 60 * 1000);
const writeLimiter = rateLimit(120, 60 * 1000);

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", etag: true }));

/* ---------- BANCO ---------- */
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, pass TEXT, role TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS agencies(
  id TEXT PRIMARY KEY, user_id TEXT, name TEXT, doc TEXT, city TEXT, phone TEXT,
  status TEXT DEFAULT 'pending', plan_id TEXT
);
CREATE TABLE IF NOT EXISTS payments(
  id TEXT PRIMARY KEY, agency_id TEXT, plan_id TEXT, method TEXT, txid TEXT,
  note TEXT, status TEXT DEFAULT 'pending', reason TEXT, created_at INTEGER
);
CREATE TABLE IF NOT EXISTS plans(
  id TEXT PRIMARY KEY, name TEXT, price REAL, features TEXT, sort INTEGER
);
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tours(
  id TEXT PRIMARY KEY, agency_id TEXT, title TEXT, city TEXT, duration TEXT,
  price REAL, capacity INTEGER, description TEXT, active INTEGER DEFAULT 1,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS bookings(
  id TEXT PRIMARY KEY, tour_id TEXT, agency_id TEXT, client_id TEXT, client_name TEXT,
  date TEXT, people INTEGER, total REAL, status TEXT DEFAULT 'pending', created_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, user_id TEXT, device_id TEXT, user_agent TEXT, created_at INTEGER, last_seen INTEGER, approved INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS resets(token TEXT PRIMARY KEY, user_id TEXT, expires INTEGER);
CREATE TABLE IF NOT EXISTS challenges(token TEXT PRIMARY KEY, user_id TEXT, expires INTEGER);
`);

/* migração: colunas de 2FA (bancos criados antes desta versão) */
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes("totp_secret")) db.exec("ALTER TABLE users ADD COLUMN totp_secret TEXT");
if (!userCols.includes("totp_enabled")) db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0");

const uid = () => crypto.randomBytes(8).toString("hex");
const now = () => Date.now();
const hash = (pass, salt = crypto.randomBytes(16).toString("hex")) =>
  salt + ":" + crypto.scryptSync(String(pass), salt, 64).toString("hex");
const verify = (pass, stored) => {
  const [salt, key] = String(stored).split(":");
  const test = crypto.scryptSync(String(pass), salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(key, "hex"), Buffer.from(test, "hex"));
};

/* ---------- SEED ---------- */
function seed() {
  const hasUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c > 0;
  if (!hasUsers) {
    db.prepare("INSERT INTO users(id,name,email,pass,role,created_at) VALUES(?,?,?,?,?,?)")
      .run(uid(), "Administrador", ADMIN_EMAIL, hash(ADMIN_PASSWORD), "admin", now());
    if (!process.env.ADMIN_PASSWORD && IS_PROD)
      console.warn("[AVISO] ADMIN_PASSWORD não definida — usando a senha padrão. Defina-a antes de publicar!");
    const ins = db.prepare("INSERT INTO plans(id,name,price,features,sort) VALUES(?,?,?,?,?)");
    ins.run("basico", "Básico", 97, JSON.stringify(["Até 5 passeios", "Reservas ilimitadas", "Suporte por e-mail"]), 1);
    ins.run("pro", "Profissional", 197, JSON.stringify(["Passeios ilimitados", "Relatórios de vendas", "Destaque na busca", "Suporte prioritário"]), 2);
    ins.run("premium", "Premium", 397, JSON.stringify(["Tudo do Profissional", "Selo verificado", "Comissão reduzida", "Gerente de conta"]), 3);
  }
  const hasCfg = db.prepare("SELECT COUNT(*) c FROM config").get().c > 0;
  if (!hasCfg) {
    db.prepare("INSERT INTO config(key,value) VALUES(?,?)").run("payment", JSON.stringify({
      pixKey: "pagamentos@tourhub.com.br",
      pixName: "TourHub Plataforma LTDA",
      pixCity: "SAO PAULO",
      methods: { pix: true, cartao: false, boleto: false, transferencia: true },
      instructions: "Envie o comprovante informando o ID da transação. A liberação ocorre em até 24h após a validação."
    }));
  }
}
seed();

/* ---------- HELPERS ---------- */
const getCfg = () => JSON.parse(db.prepare("SELECT value FROM config WHERE key='payment'").get().value);
const setCfg = (v) => db.prepare("UPDATE config SET value=? WHERE key='payment'").run(JSON.stringify(v));
const planRow = (r) => r && { id: r.id, name: r.name, price: r.price, features: JSON.parse(r.features || "[]") };
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role });
const agencyByUser = (uid_) => db.prepare("SELECT * FROM agencies WHERE user_id=?").get(uid_);
const str = (v, max = 200) => String(v == null ? "" : v).slice(0, max);
const num = (v, min, max, def) => { const n = Number(v); if (!isFinite(n)) return def; return Math.min(max, Math.max(min, n)); };
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

/* ---------- BLOQUEIO POR APARELHO ---------- */
function checkDevice(user, deviceId, req) {
  const d = str(deviceId, 100);
  if (!d) return { ok: false, error: "Aparelho não identificado. Ative o armazenamento do navegador." };
  const ua = str(req.headers["user-agent"], 200);
  const devs = db.prepare("SELECT * FROM devices WHERE user_id=? ORDER BY created_at").all(user.id);
  if (!devs.length) {
    db.prepare("INSERT INTO devices(id,user_id,device_id,user_agent,created_at,last_seen,approved) VALUES(?,?,?,?,?,?,1)")
      .run(uid(), user.id, d, ua, now(), now());
    return { ok: true, first: true };
  }
  const found = devs.find((x) => x.device_id === d && x.approved);
  if (!found) return { ok: false, error: "Este aparelho não está autorizado a acessar este painel." };
  db.prepare("UPDATE devices SET last_seen=? WHERE id=?").run(now(), found.id);
  return { ok: true, first: false };
}
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/* ---------- TOTP (2FA do administrador) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function toBase32(buf) {
  let bits = 0, val = 0, out = "";
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function fromBase32(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(str).toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    val = (val << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secret, at) {
  const counter = Math.floor(at / 30000);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac("sha1", fromBase32(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000;
  return String(code).padStart(6, "0");
}
function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const c = String(code).replace(/\D/g, "");
  if (c.length !== 6) return false;
  for (let i = -1; i <= 1; i++) if (totpAt(secret, Date.now() + i * 30000) === c) return true;
  return false;
}

/* ---------- E-MAIL ---------- */
const APP_URL = (process.env.APP_URL || "").replace(/\/$/, "");
const MAIL_FROM = process.env.MAIL_FROM || "TourHub <no-reply@tourhub.app>";
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "") === "true" || Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log("[e-mail] SMTP configurado via", process.env.SMTP_HOST);
} else {
  console.warn("[AVISO] SMTP não configurado — a recuperação de senha não enviará e-mails reais.");
}
async function sendMail(to, subject, html, text) {
  if (!mailer) {
    if (IS_PROD) throw new Error("Envio de e-mail não configurado no servidor.");
    console.log("[E-MAIL modo dev] para=" + to + " | " + subject + " | " + (text || html));
    return;
  }
  await mailer.sendMail({ from: MAIL_FROM, to, subject, html, text });
}

function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Não autenticado" });
  const s = db.prepare("SELECT * FROM sessions WHERE token=?").get(token);
  if (!s) return res.status(401).json({ error: "Sessão inválida" });
  if (!s.created_at || now() - s.created_at > SESSION_TTL) {
    db.prepare("DELETE FROM sessions WHERE token=?").run(token);
    return res.status(401).json({ error: "Sessão expirada. Entre novamente." });
  }
  db.prepare("UPDATE sessions SET created_at=? WHERE token=?").run(now(), token);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(s.user_id);
  if (!u) return res.status(401).json({ error: "Usuário não encontrado" });
  req.user = u;
  next();
}
const admin = (req, res, next) => req.user.role === "admin" ? next() : res.status(403).json({ error: "Acesso restrito" });
const agency = (req, res, next) => req.user.role === "agency" ? next() : res.status(403).json({ error: "Acesso restrito" });

/* ---------- AUTENTICAÇÃO ---------- */
app.post("/api/register", loginLimiter, (req, res) => {
  const { role, name, email, pass, agency: ag } = req.body || {};
  if (!name || !email || !pass || String(pass).length < 6 || String(pass).length > 200)
    return res.status(400).json({ error: "Preencha nome, e-mail e senha (6 a 200 caracteres)." });
  if (!["client", "agency"].includes(role)) return res.status(400).json({ error: "Perfil inválido." });
  const em = String(email).trim().toLowerCase();
  if (!isEmail(em)) return res.status(400).json({ error: "E-mail inválido." });
  if (db.prepare("SELECT id FROM users WHERE lower(email)=?").get(em))
    return res.status(409).json({ error: "Este e-mail já está cadastrado." });
  const id = uid();
  db.prepare("INSERT INTO users(id,name,email,pass,role,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, str(name, 120).trim(), em, hash(pass), role, now());
  if (role === "agency") {
    db.prepare("INSERT INTO agencies(id,user_id,name,doc,city,phone,status) VALUES(?,?,?,?,?,?,?)")
      .run(uid(), id, str((ag && ag.name) || name, 120), str(ag && ag.doc, 40), str(ag && ag.city, 80), str(ag && ag.phone, 40), "pending");
  }
  res.json({ ok: true });
});

function newSession(u) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions(token,user_id,created_at) VALUES(?,?,?)").run(token, u.id, now());
  return token;
}

app.post("/api/login", loginLimiter, (req, res) => {
  const { email, pass, deviceId } = req.body || {};
  const u = db.prepare("SELECT * FROM users WHERE lower(email)=?").get(String(email || "").trim().toLowerCase());
  if (!u || !verify(pass, u.pass)) return res.status(401).json({ error: "E-mail ou senha inválidos." });
  if (u.role === "admin") {
    const chk = checkDevice(u, deviceId, req);
    if (!chk.ok) return res.status(403).json({ error: chk.error });
  }
  /* 2FA do administrador: devolve um desafio em vez da sessão */
  if (u.role === "admin" && u.totp_enabled) {
    const challenge = crypto.randomBytes(24).toString("hex");
    db.prepare("DELETE FROM challenges WHERE user_id=?").run(u.id);
    db.prepare("INSERT INTO challenges(token,user_id,expires) VALUES(?,?,?)").run(challenge, u.id, now() + 5 * 60 * 1000);
    return res.json({ twofa: true, challenge });
  }
  res.json({ token: newSession(u), user: publicUser(u) });
});

app.post("/api/login/2fa", loginLimiter, (req, res) => {
  const { challenge, code, deviceId } = req.body || {};
  const c = db.prepare("SELECT * FROM challenges WHERE token=?").get(String(challenge || ""));
  if (!c || c.expires < now()) return res.status(401).json({ error: "Verificação expirada. Faça login novamente." });
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(c.user_id);
  if (!u || !u.totp_enabled || !verifyTotp(u.totp_secret, code))
    return res.status(401).json({ error: "Código de verificação inválido." });
  const chk = checkDevice(u, deviceId, req);
  if (!chk.ok) return res.status(403).json({ error: chk.error });
  db.prepare("DELETE FROM challenges WHERE user_id=?").run(u.id);
  res.json({ token: newSession(u), user: publicUser(u) });
});

/* ---------- APARELHOS AUTORIZADOS (admin) ---------- */
app.get("/api/devices", auth, admin, (req, res) => {
  const rows = db.prepare("SELECT id,device_id,user_agent,created_at,last_seen,approved FROM devices WHERE user_id=? ORDER BY created_at").all(req.user.id);
  res.json(rows.map((d) => ({ id: d.id, label: d.user_agent, created_at: d.created_at, last_seen: d.last_seen, approved: !!d.approved })));
});
app.delete("/api/devices/:id", auth, admin, (req, res) => {
  db.prepare("DELETE FROM devices WHERE id=? AND user_id=?").run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ---------- RECUPERAÇÃO DE SENHA ---------- */
app.post("/api/forgot", loginLimiter, async (req, res) => {
  const reply = { ok: true, message: "Se este e-mail estiver cadastrado, enviaremos as instruções." };
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!isEmail(email)) return res.json(reply);
  const u = db.prepare("SELECT * FROM users WHERE lower(email)=?").get(email);
  if (!u) return res.json(reply); /* não revela se o e-mail existe */
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("DELETE FROM resets WHERE user_id=?").run(u.id);
  db.prepare("INSERT INTO resets(token,user_id,expires) VALUES(?,?,?)").run(sha256(token), u.id, now() + 30 * 60 * 1000);
  const link = (APP_URL || (req.protocol + "://" + req.get("host"))) + "/?reset=" + token;
  try {
    await sendMail(u.email, "Redefinição de senha — TourHub",
      "<p>Olá, " + str(u.name, 120) + ".</p><p>Recebemos um pedido para redefinir a senha da sua conta TourHub.</p>" +
      "<p><a href=\"" + link + "\">Clique aqui para criar uma nova senha</a> — o link vale por 30 minutos.</p>" +
      "<p>Se não foi você, ignore este e-mail.</p>",
      "Redefina sua senha: " + link + " (válido por 30 minutos)");
  } catch (e) { console.error("Falha ao enviar e-mail:", e.message); }
  res.json(reply);
});

app.post("/api/reset", loginLimiter, (req, res) => {
  const { token, pass } = req.body || {};
  if (!token || !pass || String(pass).length < 6 || String(pass).length > 200)
    return res.status(400).json({ error: "Informe uma senha de 6 a 200 caracteres." });
  const row = db.prepare("SELECT * FROM resets WHERE token=?").get(sha256(token));
  if (!row || row.expires < now()) return res.status(400).json({ error: "Link inválido ou expirado. Solicite novamente." });
  db.prepare("UPDATE users SET pass=? WHERE id=?").run(hash(pass), row.user_id);
  db.prepare("DELETE FROM resets WHERE user_id=?").run(row.user_id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.user_id); /* derruba sessões antigas */
  res.json({ ok: true });
});

/* ---------- 2FA (administrador) ---------- */
app.get("/api/2fa/status", auth, admin, (req, res) => res.json({ enabled: !!req.user.totp_enabled }));

app.post("/api/2fa/setup", auth, admin, (req, res) => {
  const secret = toBase32(crypto.randomBytes(20));
  db.prepare("UPDATE users SET totp_secret=?, totp_enabled=0 WHERE id=?").run(secret, req.user.id);
  const label = encodeURIComponent("TourHub:" + req.user.email);
  const otpauth = "otpauth://totp/" + label + "?secret=" + secret + "&issuer=TourHub&algorithm=SHA1&digits=6&period=30";
  res.json({ secret, otpauth });
});

app.post("/api/2fa/enable", auth, admin, (req, res) => {
  const secret = req.user.totp_secret;
  if (!secret) return res.status(400).json({ error: "Inicie a configuração do 2FA primeiro." });
  if (!verifyTotp(secret, (req.body || {}).code))
    return res.status(400).json({ error: "Código inválido. Confira o relógio do celular e tente de novo." });
  db.prepare("UPDATE users SET totp_enabled=1 WHERE id=?").run(req.user.id);
  res.json({ ok: true });
});

app.post("/api/2fa/disable", auth, admin, (req, res) => {
  const { code, pass } = req.body || {};
  if (!verify(pass, req.user.pass)) return res.status(401).json({ error: "Senha incorreta." });
  if (!verifyTotp(req.user.totp_secret, code)) return res.status(400).json({ error: "Código de verificação inválido." });
  db.prepare("UPDATE users SET totp_enabled=0, totp_secret=NULL WHERE id=?").run(req.user.id);
  res.json({ ok: true });
});

app.post("/api/logout", auth, (req, res) => {
  const h = req.headers.authorization || "";
  db.prepare("DELETE FROM sessions WHERE token=?").run(h.slice(7));
  res.json({ ok: true });
});

app.get("/api/me", auth, (req, res) => {
  const u = publicUser(req.user);
  if (u.role === "agency") {
    const a = agencyByUser(u.id);
    u.agency = a ? { ...a, payment: db.prepare("SELECT * FROM payments WHERE agency_id=? ORDER BY created_at DESC LIMIT 1").get(a.id) || null } : null;
  }
  res.json({ user: u });
});

/* ---------- CONFIG ---------- */
app.get("/api/config", auth, (req, res) => res.json(getCfg()));
app.put("/api/config", auth, admin, (req, res) => {
  const c = getCfg();
  const { pixKey, pixName, pixCity, instructions, methods } = req.body || {};
  const next = {
    pixKey: pixKey != null ? String(pixKey) : c.pixKey,
    pixName: pixName != null ? String(pixName) : c.pixName,
    pixCity: pixCity != null ? String(pixCity) : c.pixCity,
    instructions: instructions != null ? String(instructions) : c.instructions,
    methods: methods && typeof methods === "object" ? methods : c.methods
  };
  if (!Object.values(next.methods).some(Boolean))
    return res.status(400).json({ error: "Habilite ao menos uma forma de pagamento." });
  setCfg(next);
  res.json(next);
});

/* ---------- PLANOS ---------- */
app.get("/api/plans", auth, (req, res) =>
  res.json(db.prepare("SELECT * FROM plans ORDER BY sort").all().map(planRow)));
app.post("/api/plans", auth, admin, (req, res) => {
  const { name, price, features } = req.body || {};
  if (!name || isNaN(+price)) return res.status(400).json({ error: "Informe nome e preço." });
  const id = uid();
  db.prepare("INSERT INTO plans(id,name,price,features,sort) VALUES(?,?,?,?,?)")
    .run(id, name, +price, JSON.stringify(features || []), now());
  res.json({ ok: true, id });
});
app.put("/api/plans/:id", auth, admin, (req, res) => {
  const p = db.prepare("SELECT * FROM plans WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Plano não encontrado." });
  const { name, price, features } = req.body || {};
  db.prepare("UPDATE plans SET name=?,price=?,features=? WHERE id=?")
    .run(name != null ? name : p.name, price != null ? +price : p.price,
      features != null ? JSON.stringify(features) : p.features, p.id);
  res.json({ ok: true });
});

/* ---------- AGÊNCIAS (admin) ---------- */
app.get("/api/agencies", auth, admin, (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name owner_name, u.email owner_email FROM agencies a
    LEFT JOIN users u ON u.id=a.user_id ORDER BY a.name`).all();
  res.json(rows.map(a => ({ ...a, plan: a.plan_id ? planRow(db.prepare("SELECT * FROM plans WHERE id=?").get(a.plan_id)) : null })));
});
app.patch("/api/agencies/:id", auth, admin, (req, res) => {
  const a = db.prepare("SELECT * FROM agencies WHERE id=?").get(req.params.id);
  if (!a) return res.status(404).json({ error: "Agência não encontrada." });
  const status = req.body && req.body.status;
  if (!["active", "suspended", "pending", "rejected"].includes(status))
    return res.status(400).json({ error: "Status inválido." });
  db.prepare("UPDATE agencies SET status=? WHERE id=?").run(status, a.id);
  if (status === "active") db.prepare("UPDATE payments SET status='approved' WHERE agency_id=?").run(a.id);
  res.json({ ok: true });
});

/* ---------- PAGAMENTOS ---------- */
app.post("/api/payments", auth, agency, (req, res) => {
  const a = agencyByUser(req.user.id);
  if (!a) return res.status(404).json({ error: "Agência não encontrada." });
  const { planId, method, txid, note } = req.body || {};
  if (!planId || !db.prepare("SELECT id FROM plans WHERE id=?").get(planId))
    return res.status(400).json({ error: "Escolha um plano." });
  if (!txid) return res.status(400).json({ error: "Informe o ID/referência da transação." });
  db.prepare("DELETE FROM payments WHERE agency_id=?").run(a.id);
  db.prepare("INSERT INTO payments(id,agency_id,plan_id,method,txid,note,status,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run(uid(), a.id, planId, method || "pix", txid, note || "", "pending", now());
  db.prepare("UPDATE agencies SET plan_id=?, status='pending' WHERE id=?").run(planId, a.id);
  res.json({ ok: true });
});
app.get("/api/payments", auth, admin, (req, res) => {
  const rows = db.prepare(`SELECT p.*, a.name agency_name, a.status agency_status FROM payments p
    JOIN agencies a ON a.id=p.agency_id ORDER BY p.created_at DESC`).all();
  res.json(rows.map(p => ({ ...p, plan: p.plan_id ? planRow(db.prepare("SELECT * FROM plans WHERE id=?").get(p.plan_id)) : null })));
});
app.patch("/api/payments/:id", auth, admin, (req, res) => {
  const p = db.prepare("SELECT * FROM payments WHERE id=?").get(req.params.id);
  if (!p) return res.status(404).json({ error: "Pagamento não encontrado." });
  const status = req.body && req.body.status;
  if (status === "approved") {
    db.prepare("UPDATE payments SET status='approved' WHERE id=?").run(p.id);
    db.prepare("UPDATE agencies SET status='active' WHERE id=?").run(p.agency_id);
  } else if (status === "rejected") {
    db.prepare("UPDATE payments SET status='rejected', reason=? WHERE id=?").run((req.body && req.body.reason) || "", p.id);
    db.prepare("UPDATE agencies SET status='rejected' WHERE id=?").run(p.agency_id);
  } else return res.status(400).json({ error: "Status inválido." });
  res.json({ ok: true });
});

/* ---------- PASSEIOS ---------- */
app.get("/api/tours", auth, (req, res) => {
  let rows;
  if (req.user.role === "admin") {
    rows = db.prepare(`SELECT t.*, a.name agency_name FROM tours t JOIN agencies a ON a.id=t.agency_id ORDER BY t.created_at DESC`).all();
  } else if (req.user.role === "agency") {
    const a = agencyByUser(req.user.id);
    rows = a ? db.prepare("SELECT * FROM tours WHERE agency_id=? ORDER BY created_at DESC").all(a.id) : [];
  } else {
    rows = db.prepare(`SELECT t.*, a.name agency_name, a.phone agency_phone FROM tours t
      JOIN agencies a ON a.id=t.agency_id WHERE a.status='active' AND t.active=1 ORDER BY t.created_at DESC`).all();
  }
  res.json(rows.map(t => ({ ...t, active: !!t.active })));
});
app.post("/api/tours", auth, agency, (req, res) => {
  const a = agencyByUser(req.user.id);
  if (!a || a.status !== "active") return res.status(403).json({ error: "Assinatura inativa. Regularize para publicar passeios." });
  const b = req.body || {};
  if (!b.title || isNaN(+b.price) || +b.price < 0 || +b.price > 1000000)
    return res.status(400).json({ error: "Informe nome e preço válido do passeio." });
  const id = uid();
  db.prepare("INSERT INTO tours(id,agency_id,title,city,duration,price,capacity,description,active,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, a.id, str(b.title, 140), str(b.city, 80), str(b.duration, 40), num(b.price, 0, 1000000, 0), Math.round(num(b.capacity, 1, 10000, 20)), str(b.description, 2000), 1, now());
  res.json({ ok: true, id });
});
app.put("/api/tours/:id", auth, agency, (req, res) => {
  const a = agencyByUser(req.user.id);
  const t = db.prepare("SELECT * FROM tours WHERE id=?").get(req.params.id);
  if (!t || !a || t.agency_id !== a.id) return res.status(404).json({ error: "Passeio não encontrado." });
  const b = req.body || {};
  db.prepare("UPDATE tours SET title=?,city=?,duration=?,price=?,capacity=?,description=? WHERE id=?")
    .run(b.title ?? t.title, b.city ?? t.city, b.duration ?? t.duration, b.price != null ? +b.price : t.price,
      b.capacity != null ? +b.capacity : t.capacity, b.description ?? t.description, t.id);
  res.json({ ok: true });
});
app.patch("/api/tours/:id/toggle", auth, agency, (req, res) => {
  const a = agencyByUser(req.user.id);
  const t = db.prepare("SELECT * FROM tours WHERE id=?").get(req.params.id);
  if (!t || !a || t.agency_id !== a.id) return res.status(404).json({ error: "Passeio não encontrado." });
  db.prepare("UPDATE tours SET active=? WHERE id=?").run(t.active ? 0 : 1, t.id);
  res.json({ ok: true });
});
app.delete("/api/tours/:id", auth, agency, (req, res) => {
  const a = agencyByUser(req.user.id);
  const t = db.prepare("SELECT * FROM tours WHERE id=?").get(req.params.id);
  if (!t || !a || t.agency_id !== a.id) return res.status(404).json({ error: "Passeio não encontrado." });
  db.prepare("DELETE FROM tours WHERE id=?").run(t.id);
  res.json({ ok: true });
});

/* ---------- RESERVAS ---------- */
app.get("/api/bookings", auth, (req, res) => {
  let rows;
  if (req.user.role === "client") {
    rows = db.prepare(`SELECT b.*, t.title tour_title, a.name agency_name FROM bookings b
      LEFT JOIN tours t ON t.id=b.tour_id LEFT JOIN agencies a ON a.id=b.agency_id
      WHERE b.client_id=? ORDER BY b.created_at DESC`).all(req.user.id);
  } else if (req.user.role === "agency") {
    const a = agencyByUser(req.user.id);
    rows = a ? db.prepare(`SELECT b.*, t.title tour_title FROM bookings b LEFT JOIN tours t ON t.id=b.tour_id
      WHERE b.agency_id=? ORDER BY b.created_at DESC`).all(a.id) : [];
  } else {
    rows = db.prepare(`SELECT b.*, t.title tour_title, a.name agency_name FROM bookings b
      LEFT JOIN tours t ON t.id=b.tour_id LEFT JOIN agencies a ON a.id=b.agency_id ORDER BY b.created_at DESC`).all();
  }
  res.json(rows);
});
app.post("/api/bookings", auth, (req, res) => {
  if (req.user.role !== "client") return res.status(403).json({ error: "Apenas clientes reservam." });
  const { tourId, date, people } = req.body || {};
  const t = db.prepare("SELECT * FROM tours WHERE id=?").get(tourId);
  if (!t || !t.active) return res.status(404).json({ error: "Passeio indisponível." });
  const ag = db.prepare("SELECT * FROM agencies WHERE id=?").get(t.agency_id);
  if (!ag || ag.status !== "active") return res.status(403).json({ error: "Agência indisponível." });
  const p = Math.max(1, Math.min(1000, parseInt(people, 10) || 1));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")))
    return res.status(400).json({ error: "Escolha uma data válida." });
  const taken = db.prepare("SELECT COALESCE(SUM(people),0) s FROM bookings WHERE tour_id=? AND date=? AND status IN ('pending','confirmed')").get(t.id, date).s;
  if (t.capacity && taken + p > t.capacity)
    return res.status(409).json({ error: `Vagas insuficientes nesta data (restam ${Math.max(0, t.capacity - taken)}).` });
  db.prepare("INSERT INTO bookings(id,tour_id,agency_id,client_id,client_name,date,people,total,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(uid(), t.id, t.agency_id, req.user.id, req.user.name, date, p, t.price * p, "pending", now());
  res.json({ ok: true });
});
app.patch("/api/bookings/:id", auth, (req, res) => {
  const b = db.prepare("SELECT * FROM bookings WHERE id=?").get(req.params.id);
  if (!b) return res.status(404).json({ error: "Reserva não encontrada." });
  const status = req.body && req.body.status;
  if (!["confirmed", "cancelled", "pending"].includes(status)) return res.status(400).json({ error: "Status inválido." });
  if (req.user.role === "agency") {
    const a = agencyByUser(req.user.id);
    if (!a || a.id !== b.agency_id) return res.status(403).json({ error: "Acesso restrito." });
  } else if (req.user.role !== "admin") return res.status(403).json({ error: "Acesso restrito." });
  db.prepare("UPDATE bookings SET status=? WHERE id=?").run(status, b.id);
  res.json({ ok: true });
});

/* ---------- ESTATÍSTICAS ---------- */
app.get("/api/stats", auth, (req, res) => {
  const one = (sql, ...p) => db.prepare(sql).get(...p).c;
  if (req.user.role === "admin") {
    const mrr = db.prepare(`SELECT COALESCE(SUM(p.price),0) s FROM agencies a JOIN plans p ON p.id=a.plan_id WHERE a.status='active'`).get().s;
    const rev = db.prepare("SELECT COALESCE(SUM(total),0) s FROM bookings WHERE status='confirmed'").get().s;
    return res.json({
      agencies: one("SELECT COUNT(*) c FROM agencies"),
      activeAgencies: one("SELECT COUNT(*) c FROM agencies WHERE status='active'"),
      pendingPayments: one("SELECT COUNT(*) c FROM payments WHERE status='pending'"),
      mrr, tours: one("SELECT COUNT(*) c FROM tours"),
      bookings: one("SELECT COUNT(*) c FROM bookings"),
      clients: one("SELECT COUNT(*) c FROM users WHERE role='client'"), revenue: rev
    });
  }
  if (req.user.role === "agency") {
    const a = agencyByUser(req.user.id);
    if (!a) return res.json({ tours: 0, bookings: 0, confirmed: 0, revenue: 0 });
    return res.json({
      tours: one("SELECT COUNT(*) c FROM tours WHERE agency_id=?", a.id),
      bookings: one("SELECT COUNT(*) c FROM bookings WHERE agency_id=?", a.id),
      confirmed: one("SELECT COUNT(*) c FROM bookings WHERE agency_id=? AND status='confirmed'", a.id),
      revenue: db.prepare("SELECT COALESCE(SUM(total),0) s FROM bookings WHERE agency_id=? AND status='confirmed'").get(a.id).s
    });
  }
  res.status(403).json({ error: "Acesso restrito." });
});

/* ---------- LIMPEZA PERIÓDICA DE SESSÕES ---------- */
setInterval(() => {
  try {
    db.prepare("DELETE FROM sessions WHERE created_at < ?").run(now() - SESSION_TTL);
    db.prepare("DELETE FROM resets WHERE expires < ?").run(now());
    db.prepare("DELETE FROM challenges WHERE expires < ?").run(now());
  } catch (e) {}
}, 60 * 60 * 1000).unref();

/* ---------- FALLBACK ---------- */
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------- TRATAMENTO DE ERROS (não vaza stack) ---------- */
app.use((err, req, res, next) => {
  console.error(err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Erro interno do servidor." });
});
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.message));

app.listen(PORT, () => console.log(`TourHub rodando na porta ${PORT}${IS_PROD ? " (produção)" : ""}`));
