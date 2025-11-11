import express from "express";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL   = process.env.APP_URL || "https://roffle.vercel.app";
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env var");
  process.exit(1);
}

const app = express();
// Accept JSON and urlencoded just in case a proxy tweaks headers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get("/", (req, res) => res.send("ROFFLE bot is running."));

// Helper to send the Play button
async function sendPlayButton(chatId, name = "") {
  const text = `👋 Hey ${name || "there"}! Tap below to play ROFFLE:`;
  const body = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [[{ text: "🚀 Play ROFFLE", web_app: { url: APP_URL } }]]
    }
  };
  const r = await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) console.error("sendMessage error:", j);
}

// Webhook endpoint (must match what you set in setWebhook URL)
app.post("/webhook", async (req, res) => {
  try {
    // 🔎 Log the update so we can see what's arriving
    console.log("Update:", JSON.stringify(req.body));

    const u = req.body;

    // 1) Normal message (DMs, groups)
    if (u.message) {
      const msg = u.message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      const text = msg.text || "";

      // Always reply with the Play button while testing
      if (chatId) await sendPlayButton(chatId, name);

      // If you only want /start in production, use:
      // if (/^\/start\b/i.test(text)) await sendPlayButton(chatId, name);
    }

    // 2) Edited message (rare but handle it)
    else if (u.edited_message) {
      const msg = u.edited_message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      if (chatId) await sendPlayButton(chatId, name);
    }

    // 3) Channel posts (if you test in a channel)
    else if (u.channel_post) {
      const post = u.channel_post;
      const chatId = post.chat?.id;
      if (chatId) await sendPlayButton(chatId, "channel");
    }

    // 4) Bot membership updates (when you start/stop the bot)
    else if (u.my_chat_member) {
      const chatId = u.my_chat_member?.chat?.id;
      const name = u.my_chat_member?.from?.first_name || "";
      if (chatId) await sendPlayButton(chatId, name);
    }

    // Always ACK fast so Telegram doesn’t retry
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.sendStatus(200);
  }
});

// Render provides PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ROFFLE webhook listening on ${PORT}`);
});
