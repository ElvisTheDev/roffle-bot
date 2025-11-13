import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

// ----------------- ENV VARS -----------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || "https://roffle.vercel.app";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN env var");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn("⚠️ Supabase env vars missing (SUPABASE_URL / SUPABASE_SERVICE_KEY)");
}

// Supabase client (backend, uses service role key)
const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

// ----------------- EXPRESS APP -----------------
const app = express();

// Allow browser (miniapp) to call this API
app.use(cors()); // you can later restrict origin to your Vercel domain
// Accept JSON and urlencoded just in case a proxy tweaks headers
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ----------------- HEALTH CHECK -----------------
app.get("/", (req, res) => res.send("ROFFLE bot is running."));

// ----------------- TELEGRAM HELPER -----------------
async function sendPlayButton(chatId, name = "") {
  const text = `👋 Hey ${name || "there"}! Tap below to play ROFFLE:`;
  const body = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🚀 Play ROFFLE",
            web_app: { url: APP_URL }
          }
        ]
      ]
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

// ----------------- TELEGRAM WEBHOOK -----------------
app.post("/webhook", async (req, res) => {
  try {
    console.log("Update:", JSON.stringify(req.body));
    const u = req.body;

    // 1) Normal message (DMs, groups)
    if (u.message) {
      const msg = u.message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      const text = msg.text || "";

      // During testing, always reply with Play button
      if (chatId) await sendPlayButton(chatId, name);

      // In production you might switch back to:
      // if (/^\/start\b/i.test(text)) await sendPlayButton(chatId, name);
    }

    // 2) Edited messages
    else if (u.edited_message) {
      const msg = u.edited_message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      if (chatId) await sendPlayButton(chatId, name);
    }

    // 3) Channel posts
    else if (u.channel_post) {
      const post = u.channel_post;
      const chatId = post.chat?.id;
      if (chatId) await sendPlayButton(chatId, "channel");
    }

    // 4) Bot membership updates
    else if (u.my_chat_member) {
      const chatId = u.my_chat_member?.chat?.id;
      const name = u.my_chat_member?.from?.first_name || "";
      if (chatId) await sendPlayButton(chatId, name);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.sendStatus(200); // still ACK so Telegram doesn't retry spam
  }
});

// ----------------- SERVER-AUTHORITATIVE SPIN -----------------
// Payouts per section index (0..24) matching your current wheel:
// Section 1  -> index 0  -> 100
// 2,4,6,...,24 -> 1
// 3,7,11,15,19,23 -> 2
// 5,9,13 -> 5
// 17,25 -> 20
// 21 -> 50
const WHEEL_PAYOUTS = [
  100, // index 0 -> section 1 (MAX)
  1,   // 2
  2,   // 3
  1,   // 4
  5,   // 5
  1,   // 6
  2,   // 7
  1,   // 8
  5,   // 9
  1,   // 10
  2,   // 11
  1,   // 12
  5,   // 13
  1,   // 14
  1,   // 15
  2,   // 16
  20,  // 17
  1,   // 18
  2,   // 19
  1,   // 20
  50,  // 21
  1,   // 22
  2,   // 23
  1,   // 24
  20   // 25
];

// Map tier string to multiplier.
// We’re tolerant about names because you renamed tiers a few times.
function getTierMultiplier(tier) {
  const t = (tier || "").toLowerCase();
  if (t.includes("prem")) return 5;  // Premium⚡️
  if (t.includes("plus")) return 3;  // Plus⭐️
  if (t.includes("pro")) return 2;   // Pro👑
  return 1;                          // No Status / free
}

function randomIndex(max) {
  // crypto RNG for fairness
  return crypto.randomInt(0, max);
}

// POST /spin - main endpoint your miniapp calls
app.post("/spin", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ ok: false, error: "supabase_not_configured" });
    }

    const { tg_id } = req.body;

    if (!tg_id) {
      return res.status(400).json({ ok: false, error: "missing_tg_id" });
    }

    // 1) Load user from Supabase
    const { data: user, error } = await supabase
      .from("roff_users")
      .select("*")
      .eq("tg_id", tg_id)
      .single();

    if (error || !user) {
      console.error("User not found", error);
      return res.status(404).json({ ok: false, error: "user_not_found" });
    }

    const currentSpins = user.spins_left || 0;
    const currentBalance = user.balance || 0;

    // 2) Check spins
    if (currentSpins <= 0) {
      return res.json({
        ok: false,
        error: "no_spins",
        balance: currentBalance,
        spins_left: currentSpins
      });
    }

    // 3) Choose random segment index
    const index = randomIndex(WHEEL_PAYOUTS.length);
    const basePrize = WHEEL_PAYOUTS[index] || 0;

    // 4) Apply tier multiplier
    const mult = getTierMultiplier(user.tier || "free");
    const prize = basePrize * mult;

    // 5) Update user in Supabase
    const newSpins = currentSpins - 1;
    const newBalance = currentBalance + prize;

    const { error: updateError } = await supabase
      .from("roff_users")
      .update({
        balance: newBalance,
        spins_left: newSpins,
        last_spin_at: new Date().toISOString(),
        last_seen: new Date().toISOString()
      })
      .eq("tg_id", tg_id);

    if (updateError) {
      console.error("Update error", updateError);
      return res.status(500).json({ ok: false, error: "update_failed" });
    }

    // 6) Return spin result to frontend
    return res.json({
      ok: true,
      index,          // wheel segment index [0..24]
      basePrize,      // before multiplier
      prize,          // after multiplier
      balance: newBalance,
      spins_left: newSpins
    });
  } catch (err) {
    console.error("Spin error", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ----------------- START SERVER -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ROFFLE webhook + API listening on ${PORT}`);
});
