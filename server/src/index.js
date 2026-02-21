import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { prisma } from "./db.js";
import { getOAuthClient, SCOPES } from "./google.js";
import { syncGmailToTasks } from "./jobs.js";
import { startBot } from "./bot.js";

const app = express();
app.use(express.json());

// Single-owner MVP
async function ensureOwner() {
  const email = process.env.OWNER_EMAIL || "owner@muecy.local";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) user = await prisma.user.create({ data: { email } });
  return user;
}

const owner = await ensureOwner();
const bot = startBot({ userId: owner.id });

app.get("/", (req, res) => {
  res.send("Muëcy Ops is running ✅");
});

// OAuth start
app.get("/auth/google", (req, res) => {
  const oauth2 = getOAuthClient();
  const url = oauth2.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });
  res.redirect(url);
});

// OAuth callback
app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  await prisma.user.update({
    where: { id: owner.id },
    data: {
      accessToken: tokens.access_token || null,
      refreshToken: tokens.refresh_token || null,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null
    }
  });

  res.send("✅ Google conectado. Ya puedes sincronizar.");
});

// Manual sync endpoint
app.post("/sync", async (req, res) => {
  const r = await syncGmailToTasks(owner.id);
  res.json({ ok: true, ...r });
});

// Daily briefing 07:40 New York
cron.schedule(
  "40 7 * * *",
  async () => {
    try {
      await syncGmailToTasks(owner.id);

      const tasks = await prisma.task.findMany({
        where: { userId: owner.id, status: { in: ["PENDING", "DOING", "BLOCKED"] } },
        orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
        take: 10
      });

      const lines = [
        "🧠 MUËCY OPS — Briefing",
        `📅 ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "short", day: "numeric" })}`,
        "",
        "🔴 Top tareas:",
        ...tasks.map(t => `- [P${t.priority}] ${t.title}`),
        "",
        "Escribe: top | hoy | tarea: ... | done: ..."
      ];

      if (process.env.TELEGRAM_CHAT_ID) {
        await bot.sendMessage(process.env.TELEGRAM_CHAT_ID, lines.join("\n"));
      }
    } catch (e) {
      console.error("Briefing error", e);
    }
  },
  {
    timezone: "America/New_York"
  }
);

const port = process.env.PORT || 8787;
app.listen(port, () => {
  console.log(`Muëcy Ops running on port ${port}`);
  console.log(`Connect Google: ${process.env.APP_BASE_URL || "(set APP_BASE_URL)"}/auth/google`);
});
