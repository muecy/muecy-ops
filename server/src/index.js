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
app.use(express.json({ limit: "2mb" }));

/* =========================
UTILS
========================= */
function getBaseUrl(req) {
  // Prefer APP_BASE_URL (Railway) but fallback to request host
  return (
    process.env.APP_BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  );
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
app.get("/health", (req, res) => res.status(200).json({ ok: true, service: "muecy-ops" }));

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

    const message = req.body?.message?.text;
    const chatId = req.body?.message?.chat?.id;

    res.sendStatus(200);
    if (!chatId) return;

    const telegramSend = async (text) => {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    };

    if (message === "/start") {
      await telegramSend("Muëcy Ops conectado en Railway ✅");
      await telegramSend("Comandos: top | hoy | /calendar | tarea: ... | done: ...");
      return;
    }

    if (message?.toLowerCase().startsWith("tarea:")) {
      const title = message.slice("tarea:".length).trim();
      if (!title) {
        await telegramSend("⚠️ Escribe algo después de 'tarea:'");
        return;
      }

      if (!owner?.id) owner = await ensureOwner();

      await prisma.task.create({
        data: {
          title,
          status: "PENDING",
          priority: 2,
          userId: owner.id
        }
      });

      await telegramSend(`✅ Tarea creada: ${title}`);
      return;
    }

    if (message?.toLowerCase().startsWith("done:")) {
      const id = Number(message.slice("done:".length).trim());
      if (!id) {
        await telegramSend("⚠️ Usa: done: ID");
        return;
      }

      await prisma.task.update({
        where: { id },
        data: { status: "DONE" }
      });

      await telegramSend(`✅ Tarea ${id} completada`);
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
        ...tasks.map((t) => `- [P${t.priority}] ${t.title}`),
        "",
        "Comandos: top | /calendar | tarea: ... | done: ...",
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
process.on("unhandledRejection", (err) => console.error("UnhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("UncaughtException:", err));

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
