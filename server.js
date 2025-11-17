import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";

// --- Environment ---
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
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- Express setup ---
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// ✅ allow your miniapp (Vercel) to call this server (Render)
app.use(
  cors({
    origin: APP_URL, // "https://roffle.vercel.app"
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

// Health check
app.get("/", (req, res) => res.send("ROFFLE bot is running."));

// --- Wheel config (must match frontend) ---
const SEGMENTS_TOTAL = 25;
const TIER_MULT = {
  free: 1,
  plus: 2,
  pro: 3,
  prem: 5,
};

function buildSlots() {
  const arr = Array(SEGMENTS_TOTAL).fill(null);
  // Section 1 -> 100 (MAX)
  arr[0] = { amount: 100 };

  const put = (idxs, amt) =>
    idxs.forEach((n) => {
      const i = n - 1;
      if (!arr[i]) arr[i] = { amount: amt };
    });

  // Even positions (2,4,6,...,24) -> 1
  put([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24], 1);
  // 3,7,11,15,19,23 -> 2
  put([3, 7, 11, 15, 19, 23], 2);
  // 5,9,13 -> 5
  put([5, 9, 13], 5);
  // 17,25 -> 20
  put([17, 25], 20);
  // 21 -> 50
  put([21], 50);

  return arr;
}
const slots = buildSlots();

function randInt(min, max) {
  // inclusive
  return crypto.randomInt(min, max + 1);
}

// --- Telegram helper: send Play button ---
async function sendPlayButton(chatId, name = "") {
  const text = `👋 Hey ${name || "there"}! Tap below to play ROFFLE:`;
  const body = {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🚀 Play ROFFLE", web_app: { url: APP_URL } }],
      ],
    },
  };

  try {
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) console.error("sendMessage error:", j);
  } catch (e) {
    console.error("sendMessage fetch error:", e);
  }
}

// --- Supabase helpers ---
async function getOrCreateUser(tg_id) {
  // Try to read existing row
  const { data, error } = await supabase
    .from("roff_users")
    .select("*")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (error) {
    console.error("getOrCreateUser select error", error);
    throw error;
  }
  if (data) return data;

  // Create default row if not exists
  const now = new Date().toISOString();
  const insert = {
    tg_id,
    balance: 0,
    spins_left: 20,
    premium_tier: "free",
    invites: 0,
    last_seen: now,
  };

  const { data: inserted, error: insErr } = await supabase
    .from("roff_users")
    .insert(insert)
    .select("*")
    .single();

  if (insErr) {
    console.error("getOrCreateUser insert error", insErr);
    throw insErr;
  }
  return inserted;
}

// --- Referral handler ---
async function handleReferral(refCode, fromUser) {
  if (!refCode) return;
  const referredId = fromUser.id;

  let referrerId;
  try {
    // We assume refCode is tg_id in base36 (same as frontend)
    referrerId = parseInt(refCode, 36);
  } catch {
    return;
  }
  if (!Number.isFinite(referrerId) || referrerId <= 0) return;
  if (referrerId === referredId) return; // no self-referrals

  try {
    // Check if already recorded
    const { data: existing, error: refErr } = await supabase
      .from("roff_referrals")
      .select("id")
      .eq("referrer_tg_id", referrerId)
      .eq("referred_tg_id", referredId)
      .maybeSingle();

    if (refErr) {
      console.error("refferral check error", refErr);
      return;
    }
    if (existing) return; // already counted, do nothing

    // Insert referral row
    await supabase.from("roff_referrals").insert({
      referrer_tg_id: referrerId,
      referred_tg_id: referredId,
    });

    // Reward both: +200 coins, +20 spins
    const rewardCoins = 200;
    const rewardSpins = 20;

    async function rewardUser(tg_id, addCoins, addSpins, addInvite) {
      const { data: row, error: selErr } = await supabase
        .from("roff_users")
        .select("*")
        .eq("tg_id", tg_id)
        .maybeSingle();

      if (selErr) {
        console.error("rewardUser select error", selErr);
        return;
      }

      const now = new Date().toISOString();
      const balance = (row?.balance ?? 0) + addCoins;
      const spins_left = (row?.spins_left ?? 0) + addSpins;
      const invites = (row?.invites ?? 0) + (addInvite ? 1 : 0);

      if (row) {
        await supabase
          .from("roff_users")
          .update({ balance, spins_left, invites, last_seen: now })
          .eq("tg_id", tg_id);
      } else {
        await supabase.from("roff_users").insert({
          tg_id,
          balance,
          spins_left,
          invites,
          premium_tier: "free",
          last_seen: now,
        });
      }
    }

    await rewardUser(referrerId, rewardCoins, rewardSpins, true);
    await rewardUser(referredId, rewardCoins, rewardSpins, false);
  } catch (e) {
    console.error("handleReferral error", e);
  }
}

// --- Webhook endpoint ---
app.post("/webhook", async (req, res) => {
  try {
    const u = req.body;

    if (u.message) {
      const msg = u.message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      const text = msg.text || "";

      // /start <refCode> → handle referral
      if (typeof text === "string" && text.startsWith("/start")) {
        const parts = text.split(" ");
        const refCode = parts[1];
        if (refCode) {
          await handleReferral(refCode, msg.from);
        }
      }

      if (chatId) {
        await sendPlayButton(chatId, name);
      }
    } else if (u.my_chat_member) {
      const chatId = u.my_chat_member?.chat?.id;
      const name = u.my_chat_member?.from?.first_name || "";
      if (chatId) await sendPlayButton(chatId, name);
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook handler error:", e);
    res.sendStatus(200);
  }
});

// --- Spin endpoint (called by mini app) ---
app.post("/spin", async (req, res) => {
  try {
    const { tg_id } = req.body || {};
    if (!tg_id) {
      return res.status(400).json({ ok: false, error: "missing_tg_id" });
    }

    // Load or create user
    let user = await getOrCreateUser(tg_id);

    if ((user.spins_left ?? 0) <= 0) {
      return res.json({ ok: false, error: "no_spins" });
    }

    const tierKey =
      user.premium_tier && TIER_MULT[user.premium_tier]
        ? user.premium_tier
        : "free";
    const mult = TIER_MULT[tierKey];

    // Pick random segment (0..24)
    const index = randInt(0, SEGMENTS_TOTAL - 1);
    const base = slots[index].amount || 0;
    const prize = base * mult;

    const newBalance = (user.balance ?? 0) + prize;
    const newSpins = (user.spins_left ?? 0) - 1;

    const now = new Date().toISOString();
    const { error: upErr, data: updated } = await supabase
      .from("roff_users")
      .update({
        balance: newBalance,
        spins_left: newSpins,
        last_seen: now,
      })
      .eq("tg_id", tg_id)
      .select("*")
      .maybeSingle();

    if (upErr) {
      console.error("spin update error", upErr);
      return res.status(500).json({ ok: false, error: "db_update_failed" });
    }

    return res.json({
      ok: true,
      index,
      prize,
      balance: newBalance,
      spins_left: newSpins,
    });
  } catch (e) {
    console.error("spin handler error", e);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ROFFLE bot + API running on port ${PORT}`);
});

