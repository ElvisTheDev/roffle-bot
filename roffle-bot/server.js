import express from "express";
import fetch from "node-fetch";

const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = "https://roffle.vercel.app";

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.send("ROFFLE bot is running."));

app.post(`/webhook`, async (req, res) => {
  try {
    const msg = req.body.message;
    if (msg && msg.text && msg.text.startsWith("/start")) {
      const chatId = msg.chat.id;
      const name = msg.from?.first_name || "there";
      const text = `👋 Hey ${name}! Tap below to play ROFFLE:`;

      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          reply_markup: {
            inline_keyboard: [[{ text: "🚀 Play ROFFLE", web_app: { url: APP_URL } }]]
          }
        })
      });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Bot running on port", PORT));
