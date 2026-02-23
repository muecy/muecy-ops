// server/src/index.js
import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { DateTime } from "luxon";

import { prisma } from "./db.js";
import { getOAuthClient, SCOPES } from "./google.js";
import { syncGmailToTasks } from "./jobs.js";

/* =========================
APP
========================= */
const app = express();
app.use(express.json({ limit: "2mb" }));

/* =========================
CONSTS
========================= */
const TZ = "America/New_York";

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

// "mañana 9pm", "tomorrow 10am", "2026-02-23 15:00", "15:30", "3pm", "hoy 6pm"
function parseWhenToNYLocal(whenText) {
  const w = (whenText || "").trim().toLowerCase();
  if (!w) throw new Error("Falta fecha/hora.");

  let base = DateTime.now().setZone(TZ);

  // explicit date YYYY-MM-DD
  const explicitDate = w.match(/(\d{4})-(\d{2})-(\d{2})/);

  // day offset
  if (!explicitDate) {
    if (w.includes("mañana") || w.includes("manana") || w.includes("tomorrow")) {
      base = base.plus({ days: 1 });
    } else if (w.includes("hoy") || w.includes("today")) {
      // keep same day
    }
  }

  // time: 3pm, 3:30pm, 15:00, 15:30
  // IMPORTANT: pick last time-like token to avoid catching years
  const timeMatch = w.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!.*\d)/i) || w.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!timeMatch) {
    throw new Error('No pude leer la hora. Ej: "mañana 9pm" o "2026-02-23 15:00"');
  }

  let hh = parseInt(timeMatch[1], 10);
  let mm = parseInt(timeMatch[2] || "0", 10);
  const ampm = (timeMatch[3] || "").toLowerCase();

  if (Number.isNaN(hh) || Number.isNaN(mm) || hh > 23 || mm > 59) {
    throw new Error("Hora inválida. Usa ej: 6pm, 18:30, 9:00am");
  }

  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;

  let dt;
  if (explicitDate) {
    const [, Y, M, D] = explicitDate;
    dt = DateTime.fromObject(
      { year: Number(Y), month: Number(M), day: Number(D), hour: hh, minute: mm, second: 0 },
      { zone: TZ }
    );
  } else {
    dt = base.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  }

  if (!dt.isValid) {
    throw new Error("No pude interpretar fecha/hora.");
  }

  // Google Calendar API: dateTime + timeZone
  return { tz: TZ, local: dt.toFormat("yyyy-LL-dd'T'HH:mm:ss") };
}

function addMinutesToLocal(local, minutes) {
  const dt = DateTime.fromFormat(local, "yyyy-LL-dd'T'HH:mm:ss", { zone: TZ });
  if (!dt.isValid) throw new Error("Fecha/hora inválida al calcular duración.");
  return dt.plus({ minutes }).toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

function pickField(str, key) {
  // key: loc | addr | desc | invite | task
  const re = new RegExp(`\\b${key}\\s*:\\s*([^/]+)`, "i");
  const m = str.match(re);
  return m ? m[1].trim() : "";
}

function stripFields(str) {
  return str
    .replace(/\bloc\s*:\s*[^/]+/gi, "")
    .replace(/\baddr\s*:\s*[^/]+/gi, "")
    .replace(/\bdesc\s*:\s*[^/]+/gi, "")
    .replace(/\binvite\s*:\s*[^/]+/gi, "")
    .replace(/\btask\s*:\s*[^/]+/gi, "")
    .trim();
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
GOOGLE HELPERS (OAuth owner)
========================= */
async function getOwnerGoogleAuthOrThrow() {
  const ownerEmail = process.env.OWNER_EMAIL || "owner@muecy.local";
  const u = await prisma.user.findUnique({ where: { email: ownerEmail } });

  if (!u?.accessToken) {
    const e = new Error("not_connected");
    e.code = "not_connected";
    throw e;
  }

  const auth = getOAuthClient();
  auth.setCredentials({
    access_token: u.accessToken,
    refresh_token: u.refreshToken || undefined,
    expiry_date: u.tokenExpiry ? new Date(u.tokenExpiry).getTime() : undefined,
  });

  const { google } = await import("googleapis");
  return { google, auth };
}

/* =========================
ROUTES
========================= */
app.get("/", (req, res) => res.status(200).send("Muëcy Ops is running ✅"));
app.get("/health", (req, res) =>
  res.status(200).json({ ok: true, service: "muecy-ops" })
);

/* -------------------------
GOOGLE OAUTH
------------------------- */
app.get("/auth/google", async (req, res) => {
  // NOTE: redirect_uri is typically configured inside getOAuthClient()
  const oauth2 = getOAuthClient();

  // Optional: small state to help debugging
  const state = Buffer.from(
    JSON.stringify({ ts: Date.now(), from: "muecy-ops" })
  ).toString("base64url");

  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
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
    const { google, auth } = await getOwnerGoogleAuthOrThrow();
    const calendar = google.calendar({ version: "v3", auth });

    const now = DateTime.utc().toISO(); // RFC3339
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
      htmlLink: e.htmlLink || null,
    }));

    res.json({ ok: true, count: events.length, events });
  } catch (err) {
    if (err?.code === "not_connected") {
      return res.status(401).json({
        ok: false,
        error: "not_connected",
        message: "Not connected to Google yet. Go to /auth/google",
      });
    }
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
        "Comandos: top | hoy | /calendar | tarea: ... | done: 1 | event: ... "
      );
      return;
    }

    // /calendar -> tu API interna
    if (msg === "/calendar") {
      const base = getBaseUrl(req);
      const r = await fetch(`${base}/api/calendar/list`);
      const data = await r.json().catch(() => ({}));

      if (!r.ok && data?.error === "not_connected") {
        await telegramSend(chatId, "⚠️ Google no está conectado. Abre: /auth/google");
        return;
      }

      const lines = (data.events || []).map(
        (e) => `• ${e.summary || "(sin título)"} — ${e.start || ""}`
      );
      await telegramSend(chatId, lines.join("\n") || "No hay eventos próximos.");
      return;
    }

    // event: titulo / mañana 9pm / 60 / loc: Miami / addr: 123 ... / desc: ... / task: ...
    if (lower.startsWith("event:") || lower.startsWith("/event")) {
      try {
        const rawEvent = msg.replace(/^\s*\/?event\s*:?\s*/i, "").trim();

        const location = pickField(rawEvent, "loc");
        const address = pickField(rawEvent, "addr");
        const description = pickField(rawEvent, "desc");
        const taskRaw = pickField(rawEvent, "task");

        const cleaned = stripFields(rawEvent);
        const parts = cleaned.split("/").map((s) => s.trim()).filter(Boolean);

        const title = parts[0] || "Evento Muëcy Ops";
        const whenText = parts[1] || "";
        const minutes = parseInt(parts[2] || "60", 10);
        if (!whenText) throw new Error('Falta fecha/hora. Ej: event: Visita / mañana 9pm / 60');

        const { tz, local } = parseWhenToNYLocal(whenText);
        const endLocal = addMinutesToLocal(local, Number.isFinite(minutes) ? minutes : 60);

        const finalLocation =
          location && address ? `${location}\n${address}` : location || address || null;

        const { google, auth } = await getOwnerGoogleAuthOrThrow();
        const calendar = google.calendar({ version: "v3", auth });

        const result = await calendar.events.insert({
          calendarId: "primary",
          requestBody: {
            summary: title,
            start: { dateTime: local, timeZone: tz },
            end: { dateTime: endLocal, timeZone: tz },
            ...(finalLocation ? { location: finalLocation } : {}),
            ...(description ? { description } : {}),
          },
        });

        let linkedTask = null;
        if (taskRaw) {
          if (!owner?.id) owner = await ensureOwner();
          linkedTask = await prisma.task.create({
            data: {
              userId: owner.id,
              title: taskRaw,
              priority: 2,
              status: "PENDING",
              source: "calendar",
            },
          });
        }

        const calendarLink = result?.data?.htmlLink || "";
        const prettyLink = calendarLink ? `🔗 Ver en Google Calendar\n${calendarLink}` : null;

        // Pretty date in NY (Luxon-safe)
        const prettyDate = DateTime.fromFormat(local, "yyyy-LL-dd'T'HH:mm:ss", { zone: TZ })
          .toFormat("ccc – LLL d, h:mm a");

        const lines = [
          "✅ Evento creado:",
          title,
          `🕒 ${prettyDate}`,
          finalLocation ? `📍 ${finalLocation}` : null,
          description ? `📝 ${description}` : null,
          prettyLink,
          linkedTask ? `🔗 Tarea vinculada: ${linkedTask.title}` : null,
        ].filter(Boolean);

        await telegramSend(chatId, lines.join("\n"));
      } catch (e) {
        if (e?.code === "not_connected") {
          await telegramSend(chatId, "⚠️ Google no está conectado. Abre: /auth/google");
          return;
        }
        await telegramSend(chatId, `❌ No pude crear el evento. Detalle: ${e.message}`);
      }
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
          source: "manual",
        },
      });

      await telegramSend(chatId, `✅ Tarea creada: ${title}`);
      return;
    }

    // top (SIN UUID; mostramos índice 1..N fácil)
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
        ...tasks.map((t, i) => `${i + 1}) [P${t.priority}] ${t.title}`),
        "",
        "✅ Para completar: done: 1 (o done: texto)",
      ].join("\n");

      await telegramSend(chatId, out);
      return;
    }

    // done: 1  (por índice del top)  o done: texto (por búsqueda)
    if (lower.startsWith("done:")) {
      if (!owner?.id) owner = await ensureOwner();

      const payload = msg.slice("done:".length).trim();
      if (!payload) {
        await telegramSend(chatId, "⚠️ Usa: done: 1  (o done: texto)");
        return;
      }

      // Caso 1: done: número => Nth tarea del top
      const n = Number(payload);
      if (Number.isFinite(n) && n > 0) {
        const tasks = await prisma.task.findMany({
          where: {
            userId: owner.id,
            status: { in: ["PENDING", "DOING", "BLOCKED"] },
          },
          orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
          take: 10,
        });

        const picked = tasks[n - 1];
        if (!picked) {
          await telegramSend(chatId, `❌ No existe la tarea #${n} en el top actual.`);
          return;
        }

        await prisma.task.update({
          where: { id: picked.id },
          data: { status: "DONE" },
        });

        await telegramSend(chatId, `✅ DONE: ${picked.title}`);
        return;
      }

      // Caso 2: done: texto => match por título (primera que coincida)
      const q = payload.toLowerCase();
      const task = await prisma.task.findFirst({
        where: {
          userId: owner.id,
          status: { in: ["PENDING", "DOING", "BLOCKED"] },
          title: { contains: q, mode: "insensitive" },
        },
        orderBy: { createdAt: "asc" },
      });

      if (!task) {
        await telegramSend(chatId, `❌ No encontré tarea que coincida con: "${payload}"`);
        return;
      }

      await prisma.task.update({
        where: { id: task.id },
        data: { status: "DONE" },
      });

      await telegramSend(chatId, `✅ DONE: ${task.title}`);
      return;
    }

    // hoy (placeholder simple)
    if (lower === "hoy") {
      await telegramSend(chatId, "✅ OK. (Luego conectamos 'hoy' con calendar + tareas)");
      return;
    }

    // fallback help
    await telegramSend(
      chatId,
      [
        "Muëcy Ops 🤖",
        "",
        "Comandos:",
        "• tarea: cortar fillers cocina",
        "• top",
        "• done: 1",
        "• done: fillers",
        "• /calendar",
        "",
        "Evento:",
        "• event: Visita Eddy / mañana 9pm / 60 / loc: Miami / addr: 123 Main St / desc: medir cocina / task: enviar estimate",
      ].join("\n")
    );
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

      const prettyDate = DateTime.now().setZone(TZ).toFormat("cccc, LLL d, yyyy");

      const lines = [
        "🧠 MUËCY OPS — Briefing",
        `📅 ${prettyDate}`,
        "",
        "🔴 Top tareas:",
        ...tasks.map((t, i) => `${i + 1}) [P${t.priority}] ${t.title}`),
        "",
        "Comandos: top | /calendar | tarea: ... | done: 1 | event: ...",
      ].join("\n");

      if (process.env.TELEGRAM_CHAT_ID) {
        await telegramSend(process.env.TELEGRAM_CHAT_ID, lines);
      } else {
        console.log("ℹ️ Briefing listo (no TELEGRAM_CHAT_ID configurado).");
      }
    } catch (e) {
      console.error("Briefing error:", e);
    }
  },
  { timezone: TZ }
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
