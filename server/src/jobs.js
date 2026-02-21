import { google } from "googleapis";
import { prisma } from "./db.js";
import { getOAuthClient } from "./google.js";
import { classifyEmail } from "./emailRules.js";

async function gmailClientForUser(user) {
  const auth = getOAuthClient();
  auth.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken
  });
  return google.gmail({ version: "v1", auth });
}

export async function syncGmailToTasks(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.refreshToken) return { synced: 0, note: "User not connected to Google yet" };

  const gmail = await gmailClientForUser(user);

  // Read everything RECENT to avoid importing years of history
  const list = await gmail.users.messages.list({
    userId: "me",
    q: "newer_than:7d",
    maxResults: 50
  });

  const messages = list.data.messages || [];
  let created = 0;

  for (const m of messages) {
    // thanks to @@unique([userId, source, externalId]) we can just try create
    const full = await gmail.users.messages.get({ userId: "me", id: m.id, format: "metadata" });
    const headers = full.data.payload?.headers || [];

    const subject = headers.find(h => h.name?.toLowerCase() === "subject")?.value || "(sin asunto)";
    const from = headers.find(h => h.name?.toLowerCase() === "from")?.value || "(sin remitente)";

    const classification = classifyEmail({ subject, from, snippet: full.data.snippet || "" });
    if (!classification.createTask) continue;

    try {
      await prisma.task.create({
        data: {
          userId,
          title: `Responder / Gestionar: ${subject}`,
          description: `From: ${from}`,
          source: "gmail",
          externalId: m.id,
          priority: classification.priority
        }
      });
      created++;
    } catch (e) {
      // duplicate, ignore
    }
  }

  return { synced: created };
}
