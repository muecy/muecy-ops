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

// Railway / reverse proxy (para req.protocol correcto)
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

function pickField(str, key) {
  // key: loc | addr | desc | invite | task
  // acepta: "loc: Miami" hasta antes del próximo "/"
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
    .replace(/\s+/g, " ")
    .trim();
}

function isExplicitDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test((s || "").trim());
}
function isMinutes(s) {
  return /^\d{1,4}$/.test((s || "").trim());
}

/**
 * Parse "mañana 9pm", "tomorrow 10am", "2026-02-23 15:00", "15:30", "3pm"
 * Devuelve ISO local (YYYY-MM-DDTHH:mm:ss±offset) y tz (America/New_York)
 */
function parseWhenToNYLocal(whenText) {
  const tz = "America/New_York";
  const wRaw = (whenText || "").trim();
  const w = wRaw.toLowerCase();

  if (!wRaw) throw new Error('Falta fecha/hora. Ej: "mañana 9pm"');

  // base = "hoy" en NY
  let base = DateTime.now().setZone(tz);

  // detectar fecha explícita YYYY-MM-DD
  const explicitDateMatch = w.match(/(\d{4})-(\d{2})-(\d{2})/);
  const hasExplicitDate = Boolean(explicitDateMatch);

  if (!hasExplicitDate) {
    if (w.includes("mañana") || w.includes("manana") || w.includes("tomorrow")) {
      base = base.plus({ days: 1 });
    }
  }

  // Extraer hora de forma segura:
  // Preferimos HH:MM (con o sin am/pm), o H am/pm.
  // Evita confundir "2026" con hora.
  let timeMatch =
    w.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?\b/i) ||
    w.match(/\b(\d{1,2})\s*(am|pm)\b/i);

  if (!timeMatch) {
    throw new Error('No pude leer la hora. Ej: "mañana 9pm" o "2026-02-23 15:00"');
  }

  let hh;
  let mm;
  let ampm = "";

  if (timeMatch.length >= 4 && timeMatch[0].includes(":")) {
    hh = parseInt(timeMatch[1], 10);
    mm = parseInt(timeMatch[2], 10);
    ampm = (timeMatch[3] || "").toLowerCase();
  } else {
    hh = parseInt(timeMatch[1], 10);
    mm = 0;
    ampm = (timeMatch[2] || "").toLowerCase();
  }

  if (Number.isNaN(hh) || Number.isNaN(mm)) throw new Error("Hora inválida.");

  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;

  let dt;
  if (hasExplicitDate) {
    const [, Y, M, D] = explicitDateMatch;
    dt = DateTime.fromObject(
      {
        year: Number(Y),
        month: Number(M),
        day: Number(D),
        hour: hh,
        minute: mm,
        second: 0,
        millisecond: 0,
      },
      { zone: tz }
    );
  } else {
    dt = base.set({ hour: hh, minute: mm, second: 0, millisecond: 0 });
  }

  if (!dt.isValid) throw new Error("Fecha/hora inválida.");
  return { tz, localISO: dt.toISO({ suppressMilliseconds: true }) };
}

function addMinutesNY(localISO, minutes) {
  const tz = "America/New_York";
  const dt = DateTime.fromISO(localISO, { zone: tz });
  const end = dt.plus({ minutes: Number.isFinite(minutes) ? minutes : 60 });
  return end.toISO({ suppressMilliseconds: true });
}

function prettyNY(localISO) {
  const tz = "America/New_York";
  const dt = DateTime.fromISO(localISO, { zone: tz });
  return dt.toFormat("ccc '–' LLL d '–' h:mm a");
}

/**
 * Parser de partes para eventos:
 * Soporta:
 * - title / mañana 9pm / 60
 * - title / 2026-03-03 13:00 / 60
 * - title / 13:00 / 2026-03-03 / Miami
 * - title / 2026-03-03 / 13:00 / 60 / Miami
 * - title / 2026-03-03-15:00 / Miami
 */
function parseEventParts(parts) {
  const all = parts.map((x) => (x || "").trim()).filter(Boolean);

  let dateToken = "";
  let timeToken = "";
  let minutes = 60;
  let leftoverLocation = "";

  const extractDate = (s) => {
    const m = (s || "").match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  };

  const extractTime = (s) => {
    const t = (s || "").toLowerCase();
    const m =
      t.match(/(\d{1,2}:\d{2})\s*(am|pm)?/) ||
      t.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (!m) return "";
    return m[0].replace(/\s+/g, "");
  };

  const title = all[0] || "Evento Muëcy Ops";
  const rest = all.slice(1);

  // por si el título trae fecha/hora pegada
  dateToken = extractDate(title) || dateToken;
  timeToken = extractTime(title) || timeToken;

  for (const tokenRaw of rest) {
    const token = (tokenRaw || "").trim();
    if (!token) continue;

    if (!dateToken) {
      const d = extractDate(token);
      if (d) {
        dateToken = d;
        continue;
      }
    }

    if (!timeToken) {
      const t = extractTime(token);
      if (t) {
        timeToken = t;
        continue;
      }
    }

    if (isMinutes(token)) {
      const n = parseInt(token, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 1440) {
        minutes = n;
        continue;
      }
    }

    if (!leftoverLocation) leftoverLocation = token;
  }

  let whenText = "";
  if (dateToken && timeToken) whenText = `${dateToken} ${timeToken}`;
  else if (timeToken) whenText = timeToken;
  else if (dateToken) whenText = dateToken;

  return { title, whenText, minutes, leftoverLocation };
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
    const { google, auth } = await getOwnerGoogleAuthOrThrow();
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
        [
          "Comandos:",
          "• tarea: cortar fillers cocina",
          "• top",
          "• done: 1   (o done: texto)",
          "• /calendar",
          "",
          "Evento:",
          "• event: Visita Eddy / mañana 9pm / 60 / loc: Miami / addr: 123 Main St / desc: medir cocina / task: enviar estimate",
          "• event: revisar Trello / 13:00 / 2026-03-03 / Miami",
          "• event: panel / 2026-03-03-15:00 / Miami",
        ].join("\n")
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

    // event: ...
    if (lower.startsWith("event:") || lower.startsWith("/event")) {
      try {
        const rawEvent = msg.replace(/^\s*\/?event\s*:?\s*/i, "").trim();

        const location = pickField(rawEvent, "loc");
        const address = pickField(rawEvent, "addr");
        const description = pickField(rawEvent, "desc");
        const taskRaw = pickField(rawEvent, "task");

        const cleaned = stripFields(rawEvent);
        const parts = cleaned.split("/").map((s) => s.trim()).filter(Boolean);

        if (!parts.length) throw new Error("Formato vacío. Ej: event: Título / mañana 9pm / 60");

        const parsed = parseEventParts(parts);

        if (!parsed.whenText) {
          throw new Error('Falta fecha/hora. Ej: event: Visita / mañana 9pm / 60');
        }

        // Si pasaron solo fecha sin hora
        if (isExplicitDate(parsed.whenText.trim())) {
          throw new Error('Te faltó la hora. Ej: "2026-03-03 13:00" o "13:00 / 2026-03-03"');
        }

        const { tz, localISO } = parseWhenToNYLocal(parsed.whenText);
        const endISO = addMinutesNY(localISO, Number.isFinite(parsed.minutes) ? parsed.minutes : 60);

        const fallbackLoc = parsed.leftoverLocation;
        const combinedLoc =
          location && address ? `${location}\n${address}` : location || address || fallbackLoc || null;

        const { google, auth } = await getOwnerGoogleAuthOrThrow();
        const calendar = google.calendar({ version: "v3", auth });

        const result = await calendar.events.insert({
          calendarId: "primary",
          requestBody: {
            summary: parsed.title,
            start: { dateTime: localISO, timeZone: tz },
            end: { dateTime: endISO, timeZone: tz },

            // ✅ Alarma 30 minutos antes
            reminders: {
              useDefault: false,
              overrides: [{ method: "popup", minutes: 30 }],
            },

            ...(combinedLoc ? { location: combinedLoc } : {}),
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

        const lines = [
          "✅ Evento creado:",
          parsed.title,
          `🕒 ${prettyNY(localISO)} (NY)`,
          combinedLoc ? `📍 ${combinedLoc}` : null,
          description ? `📝 ${description}` : null,
          "🔔 Recordatorio: 30 min antes",
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
        ...tasks.map((t, i) => `${i + 1}) [P${t.priority}] ${t.title}`),
        "",
        "✅ Para completar: done: 1 (o done: texto)",
      ].join("\n");

      await telegramSend(chatId, out);
      return;
    }

    // done: ...
    if (lower.startsWith("done:")) {
      if (!owner?.id) owner = await ensureOwner();

      const payload = msg.slice("done:".length).trim();
      if (!payload) {
        await telegramSend(chatId, "⚠️ Usa: done: 1  (o done: texto)");
        return;
      }

      // done: número
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

      // done: texto
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

    // hoy
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
        "• event: revisar Trello / 13:00 / 2026-03-03 / Miami",
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

      const lines = [
        "🧠 MUËCY OPS — Briefing",
        `📅 ${DateTime.now().setZone("America/New_York").toFormat("cccc, LLL d, yyyy")}`,
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
