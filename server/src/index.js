// server/src/index.js
import "dotenv/config";
import express from "express";
import cron from "node-cron";

import { prisma } from "./db.js";
import { getOAuthClient, SCOPES } from "./google.js";
import { syncGmailToTasks } from "./jobs.js";

/* =========================
APP
========================= */
const app = express();

// Important on Railway/Proxies so req.protocol becomes https
app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));

/* =========================
UTILS
========================= */
function getBaseUrl(req) {
  // Prefer APP_BASE_URL (Railway) but fallback to request host
  return process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
}

async function telegramSend(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { ok: false, skipped: true };

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

// Parse commands like:
// "done: 7" | "done 7" | "Done:7" | "doing 12"
function parseCommandWithId(msg, cmd) {
  const s = (msg || "").trim();

  // acepta números o UUID
  const re = new RegExp(`^${cmd}\\s*:?\\s*([a-zA-Z0-9-]+)\\s*$`, "i");
  const m = s.match(re);
  if (!m) return null;

  return m[1]; // devuelve string (UUID o número)
}

/* =========================
SINGLE OWNER (MVP)
========================= */
async function ensureOwner() {
  const email = process.env.OWNER_EMAIL || "owner@muecy.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) user = await prisma.user.create({ data: { email } });
  return user;
}

let owner = null;

async function boot() {
  owner = await ensureOwner();
  console.log("✅ Boot OK");
  console.log(`👤 Owner: ${owner.email} (${owner.id})`);
}

/* =========================
ROUTES
========================= */
// Health / Root
app.get("/", (req, res) => res.status(200).send("Muëcy Ops is running ✅"));
app.get("/health", (req, res) =>
  res.status(200).json({ ok: true, service: "muecy-ops" })
);

/* -------------------------
GOOGLE OAUTH
------------------------- */
app.get("/auth/google", async (req, res) => {
  const oauth2 = getOAuthClient();

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  return res.redirect(url);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing ?code");

    const oauth2 = getOAuthClient();
    const { tokens } = await oauth2.getToken(code);
    oauth2.setCredentials(tokens);

    const ownerEmail = process.env.OWNER_EMAIL || "owner@muecy.local";
    await prisma.user.update({
      where: { email: ownerEmail },
      data: {
        accessToken: tokens.access_token || null,
        refreshToken: tokens.refresh_token || null,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
      },
    });

    return res.send("✅ Google conectado. Ya puedes cerrar esta ventana.");
  } catch (err) {
    console.error("OAuth callback error:", err);
    return res.status(500).send("OAuth callback error. Revisa logs.");
  }
});

/* -------------------------
API: Calendar (list next 10)
------------------------- */
app.get("/api/calendar/list", async (req, res) => {
  try {
    const ownerEmail = process.env.OWNER_EMAIL || "owner@muecy.local";
    const u = await prisma.user.findUnique({ where: { email: ownerEmail } });

    if (!u?.accessToken) {
      return res.status(401).json({
        ok: false,
        error: "not_connected",
        message: "Not connected to Google yet. Go to /auth/google",
      });
    }

    const auth = getOAuthClient();
    auth.setCredentials({
      access_token: u.accessToken,
      refresh_token: u.refreshToken || undefined,
      expiry_date: u.tokenExpiry ? new Date(u.tokenExpiry).getTime() : undefined,
    });

    const { google } = await import("googleapis");
    const calendar = google.calendar({ version: "v3", auth });

    const now = new Date().toISOString();
    const out = await calendar.events.list({
      calendarId: "primary",
      timeMin: now,
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (out.data.items || []).map((e) => ({
      id: e.id,
      summary: e.summary,
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      location: e.location || null,
    }));

    res.json({ ok: true, count: events.length, events });
  } catch (err) {
    console.error("Calendar fetch failed:", err);
    res.status(500).json({ ok: false, error: "calendar_failed" });
  }
});

/* -------------------------
API: Manual Sync (Gmail -> Tasks)
------------------------- */
app.post("/sync", async (req, res) => {
  try {
    if (!owner?.id) owner = await ensureOwner();
    const r = await syncGmailToTasks(owner.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    console.error("Manual sync error:", e);
    res.status(500).json({ ok: false, error: "sync_failed" });
  }
});

/* -------------------------
Telegram Webhook (Webhook-only)
------------------------- */
app.post("/telegram/webhook", async (req, res) => {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return res.sendStatus(200);

    const raw = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;

    // Telegram expects fast 200
    res.sendStatus(200);
    if (!chatId) return;

    const msg = (raw || "").trim();
    const lower = msg.toLowerCase();

    // /start
    if (msg === "/start") {
      await telegramSend(chatId, "Muëcy Ops conectado en Railway ✅");
      await telegramSend(
        chatId,
        "Comandos: top | hoy | /calendar | tarea: ... | done: ID | doing: ID"
      );
      return;
    }

    // /calendar -> llama tu API interna
    if (msg === "/calendar") {
      const base = getBaseUrl(req);
      const r = await fetch(`${base}/api/calendar/list`);
      const data = await r.json().catch(() => ({}));

      const lines = (data.events || []).map(
        (e) => `• ${e.summary || "(sin título)"} — ${e.start || ""}`
      );
      await telegramSend(chatId, lines.join("\n") || "No hay eventos próximos.");
      return;
    }

    // tarea: ...
    if (lower.startsWith("tarea:")) {
      const title = msg.slice("tarea:".length).trim();

      if (!title) {
        await telegramSend(chatId, "⚠️ Escribe algo después de 'tarea:'");
        return;
      }

      if (!owner?.id) owner = await ensureOwner();

      await prisma.task.create({
        data: {
          title,
          status: "PENDING",
          priority: 2,
          userId: owner.id,
        },
      });

      await telegramSend(chatId, `✅ Tarea creada: ${title}`);
      return;
    }

    // done / doing with flexible formats
    const doneId = parseCommandWithId(msg, "done");
    if (doneId) {
      if (!owner?.id) owner = await ensureOwner();

      const r = await prisma.task.updateMany({
        where: { id: doneId, userId: owner.id },
        data: { status: "DONE" },
      });

      await telegramSend(
        chatId,
        r.count ? `✅ Tarea ${doneId} completada` : `❌ No encontré la tarea ${doneId}`
      );
      return;
    }

    const doingId = parseCommandWithId(msg, "doing");
    if (doingId) {
      if (!owner?.id) owner = await ensureOwner();

      const r = await prisma.task.updateMany({
        where: { id: doingId, userId: owner.id },
        data: { status: "DOING" },
      });

      await telegramSend(
        chatId,
        r.count ? `🟡 Tarea ${doingId} en progreso (DOING)` : `❌ No encontré la tarea ${doingId}`
      );
      return;
    }

    // top
    if (lower === "top") {
      if (!owner?.id) owner = await ensureOwner();

      const tasks = await prisma.task.findMany({
        where: {
          userId: owner.id,
          status: { in: ["PENDING", "DOING", "BLOCKED"] },
        },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 10,
      });

      if (!tasks.length) {
        await telegramSend(chatId, "No hay tareas.");
        return;
      }

      const out = [
        "🔴 Top 10 tareas:",
        ...tasks.map((t) => `- (${t.id}) [P${t.priority}] ${t.title}`),
      ].join("\n");

      await telegramSend(chatId, out);
      return;
    }

    // hoy (placeholder simple)
    if (lower === "hoy") {
      await telegramSend(
        chatId,
        "✅ OK. (Luego conectamos 'hoy' con calendar + tareas)"
      );
      return;
    }
  } catch (e) {
    console.error("Telegram webhook error:", e);
  }
});

/* =========================
DAILY BRIEFING (07:40 NY)
========================= */
cron.schedule(
  "40 7 * * *",
  async () => {
    try {
      if (!owner?.id) owner = await ensureOwner();

      // 1) Sync Gmail -> Tasks
      await syncGmailToTasks(owner.id);

      // 2) Fetch top tasks
      const tasks = await prisma.task.findMany({
        where: {
          userId: owner.id,
          status: { in: ["PENDING", "DOING", "BLOCKED"] },
        },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 10,
      });

      const lines = [
        "🧠 MUËCY OPS — Briefing",
        `📅 ${new Date().toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "short",
          day: "numeric",
        })}`,
        "",
        "🔴 Top tareas:",
        ...tasks.map((t) => `- (${t.id}) [P${t.priority}] ${t.title}`),
        "",
        "Comandos: top | /calendar | tarea: ... | done: ID | doing: ID",
      ].join("\n");

      // 3) Send Telegram (chat id fixed by env)
      if (process.env.TELEGRAM_CHAT_ID) {
        await telegramSend(process.env.TELEGRAM_CHAT_ID, lines);
      } else {
        console.log("ℹ️ Briefing listo (no TELEGRAM_CHAT_ID configurado).");
      }
    } catch (e) {
      console.error("Briefing error:", e);
    }
  },
  { timezone: "America/New_York" }
);

/* =========================
ERROR HANDLERS
========================= */
process.on("unhandledRejection", (err) =>
  console.error("UnhandledRejection:", err)
);
process.on("uncaughtException", (err) =>
  console.error("UncaughtException:", err)
);

/* =========================
START SERVER
========================= */
const port = Number(process.env.PORT || 8080);

boot()
  .then(() => {
    app.listen(port, "0.0.0.0", () => {
      console.log(`Muëcy Ops running on port ${port}`);
      const base = process.env.APP_BASE_URL || `(set APP_BASE_URL)`;
      console.log(`Connect Google: ${base}/auth/google`);
      console.log(`Telegram webhook: ${base}/telegram/webhook`);
    });
  })
  .catch((e) => {
    console.error("❌ Boot failed:", e);
    process.exit(1);
  });
