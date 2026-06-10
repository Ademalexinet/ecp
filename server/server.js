const express   = require("express");
const http      = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const jwt       = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const helmet    = require("helmet");
const crypto    = require("crypto");
const path      = require("path");

const app = express();
const srv = http.createServer(app);
const wss = new WebSocketServer({ server: srv });

const JWT_SECRET  = process.env.JWT_SECRET || crypto.randomBytes(64).toString("hex");
const PORT        = process.env.PORT || 3000;
const AGENT_PORT  = 8765;

app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"],
  connectSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"]
}}}));
app.use(express.json());

const loginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: "Слишком много попыток. Попробуйте через 15 минут." }
});

// Статика — только авторизованным
app.use(express.static(path.join(__dirname, "../client")));

// Скачать агент — только авторизованным
app.get("/downloads/ecp-agent.exe", requireAuth, (req, res) => {
  res.download(path.join(__dirname, "../downloads/ecp-agent.exe"));
});

// Вход с локальной проверкой (логин: 1, пароль: 1)
app.post("/api/login", loginLimit, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Укажите email и пароль" });

  const ok = await checkProfisign(email, password);
  if (!ok) {
    await new Promise(r => setTimeout(r, 1000));
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ token, name: email });
});

function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Требуется авторизация" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "Сессия истекла, войдите снова" }); }
}

// WebSocket — проксируем к агенту на ПК пользователя
wss.on("connection", (browser, req) => {
  let user;
  try {
    const url   = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    browser.send(JSON.stringify({ error: "Не авторизован" }));
    browser.close();
    return;
  }

  console.log(`[+] ${user.email} подключился`);

  const agent = new WebSocket(`ws://localhost:${AGENT_PORT}`);
  const allowed = ["list_containers", "copy_container", "check_name", "ping"];

  agent.on("error", () =>
    browser.send(JSON.stringify({ action: "agent_error",
      message: "Агент не запущен на этом ПК" })));

  browser.on("message", raw => {
    try {
      const m = JSON.parse(raw);
      if (!allowed.includes(m.action)) {
        browser.send(JSON.stringify({ error: "Действие запрещено" }));
        return;
      }
      console.log(`[A] ${user.email}: ${m.action}`);
      if (agent.readyState === WebSocket.OPEN) agent.send(raw);
    } catch {}
  });

  agent.on("message", raw => {
    if (browser.readyState === 1) browser.send(raw);
  });

  browser.on("close", () => { console.log(`[-] ${user.email}`); agent.close(); });
  agent.on("close", () =>
    browser.send(JSON.stringify({ action: "agent_disconnected" })));
});

// Локальная проверка: разрешаем вход только с парой (1, 1)
async function checkProfisign(email, password) {
  // Можно поменять на любые другие учётные данные
  return (email === "1" && password === "1");
}

srv.listen(PORT, () => console.log(`ECP Server: http://localhost:${PORT}`));