import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import cors from "cors";

// --- Environment ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const APP_URL = process.env.APP_URL || "https://roffle.vercel.app";
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_SECRET_TOKEN = process.env.TELEGRAM_SECRET_TOKEN;
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
const TIER_CAP = {
  free: 20,
  plus: 40,
  pro: 60,
  prem: 100,
};


// --- Booster bundles config (MUST match frontend) ---
const BUNDLE_CONFIG = {
  mini: {
    title: "Mini Booster Bundle",
    description: "20,000 $ROF · 100 spins · 1 Golden Ticket",
    stars: 299,
    rof: 20000,
    spins: 100,
    tickets: 1,
  },
  medi: {
    title: "Medi Booster Bundle",
    description: "50,000 $ROF · 250 spins · 2 Golden Tickets",
    stars: 599,
    rof: 50000,
    spins: 250,
    tickets: 2,
  },
  maxi: {
    title: "Maxi Booster Bundle",
    description: "125,000 $ROF · 500 spins · 3 Golden Tickets",
    stars: 1199,
    rof: 125000,
    spins: 500,
    tickets: 3,
  },
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

// ⭐ Common price helper (used by invoice + validation)
function getStarsPrice(item_type, item_id) {
  let amountStars = 0;

  if (item_type === "tier") {
    // Must match TIERS.priceStars in frontend
    if (item_id === "plus") amountStars = 700;
    else if (item_id === "pro") amountStars = 1400;
    else if (item_id === "prem") amountStars = 2100;
  } else if (item_type === "wheel" || item_type === "bg") {
    // All paid skins use 299 ⭐ in your config
    amountStars = 299;
  } else if (item_type === "bundle") {
    // Booster bundles – read price from BUNDLE_CONFIG
    const cfg = BUNDLE_CONFIG[item_id];
    if (cfg) {
      amountStars = cfg.stars;
    }
  }

  return amountStars;
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

// ⭐ Answer pre-checkout queries (MUST be done for payments to succeed)
async function handlePreCheckout(pre) {
  try {
    // Optional: validate price vs payload
    let expectedAmount = 0;
    try {
      const payloadObj = JSON.parse(pre.invoice_payload);
      expectedAmount = getStarsPrice(
        payloadObj.item_type,
        payloadObj.item_id
      );
    } catch {
      // if parsing fails, we can still just approve if you want
    }

    const ok =
      expectedAmount > 0 ? pre.total_amount === expectedAmount : true;

    const body = {
      pre_checkout_query_id: pre.id,
      ok,
      error_message: ok
        ? undefined
        : "Price mismatch, please contact support.",
    };

    const res = await fetch(`${TG_API}/answerPreCheckoutQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!data || !data.ok) {
      console.error("answerPreCheckoutQuery error:", data);
    }
  } catch (e) {
    console.error("handlePreCheckout error:", e);
  }
}

// ⭐ Handle successful Stars payment → grant tier/skin/bundle
async function handleSuccessfulPayment(msg) {
  const sp = msg.successful_payment;
  const from = msg.from;

  let payload;
  try {
    payload = JSON.parse(sp.invoice_payload);
  } catch (e) {
    console.error("Invalid invoice_payload:", sp.invoice_payload);
    return;
  }

  const { tg_id, item_type, item_id } = payload;
  const telegramId = tg_id || from.id;

  console.log("✅ successful_payment:", {
    telegramId,
    item_type,
    item_id,
    total_amount: sp.total_amount,
    currency: sp.currency,
  });

  try {
    if (item_type === "tier") {
      // Upgrade user's premium_tier
      const { error } = await supabase
        .from("roff_users")
        .update({
          premium_tier: item_id,
          last_seen: new Date().toISOString(),
        })
        .eq("tg_id", telegramId);

      if (error) {
        console.error("Update premium_tier error:", error);
      }
    } else if (item_type === "wheel" || item_type === "bg") {
      // Insert to inventory (no duplicate check for simplicity)
      const { error } = await supabase.from("roff_inventory").insert({
        tg_id: telegramId,
        item_type: item_type,
        item_id: item_id,
      });

      if (error) {
        console.error("Insert inventory error:", error);
      }
    } else if (item_type === "bundle") {
      const cfg = BUNDLE_CONFIG[item_id];
      if (!cfg) {
        console.error("Unknown bundle id in payment:", item_id);
      } else {
        // 1) Read current user balances
        const { data: row, error: selErr } = await supabase
          .from("roff_users")
          .select("balance, spins_left, golden_tickets")
          .eq("tg_id", telegramId)
          .maybeSingle();

        if (selErr) {
          console.error("Select user for bundle error:", selErr);
        } else {
          const currentBalance = row?.balance ?? 0;
          const currentSpins = row?.spins_left ?? 0;
          const currentTickets = row?.golden_tickets ?? 0;

          const { error: upErr } = await supabase
            .from("roff_users")
            .update({
              balance: currentBalance + cfg.rof,
              spins_left: currentSpins + cfg.spins,
              golden_tickets: currentTickets + cfg.tickets,
              last_seen: new Date().toISOString(),
            })
            .eq("tg_id", telegramId);

          if (upErr) {
            console.error("Update bundle user error:", upErr);
          } else {
            console.log(
              `Bundle ${item_id} applied to ${telegramId}: +${cfg.rof} ROF, +${cfg.spins} spins, +${cfg.tickets} tickets`
            );
          }
        }
      }
    }

    // Optional confirmation DM
    let confirmationText = `✅ Payment received: ${item_type} "${item_id}" unlocked in ROFFLE!`;
    if (item_type === "bundle") {
      const cfg = BUNDLE_CONFIG[item_id];
      if (cfg) {
        confirmationText = `✅ Booster Bundle purchased: ${cfg.title}\n+${cfg.rof.toLocaleString()} $ROF · +${cfg.spins} spins · +${cfg.tickets} Golden Ticket${cfg.tickets > 1 ? "s" : ""}`;
      }
    }

    await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: confirmationText,
      }),
    });
  } catch (e) {
    console.error("handleSuccessfulPayment error:", e);
  }
}


// --- Webhook endpoint ---
app.post("/webhook", async (req, res) => {
  try {
    const u = req.body;

            // ✅ Security check: only accept requests with our secret token
    if (TELEGRAM_SECRET_TOKEN) {
      const headerToken = req.headers["x-telegram-bot-api-secret-token"];
      if (headerToken !== TELEGRAM_SECRET_TOKEN) {
        console.warn("❌ Webhook called with wrong or missing secret token");
        return res.sendStatus(403);
      }
    }



    // ⭐ payment: pre-checkout
    if (u.pre_checkout_query) {
      await handlePreCheckout(u.pre_checkout_query);
    }

    if (u.message) {
      const msg = u.message;
      const chatId = msg.chat?.id;
      const name = msg.from?.first_name || "";
      const text = msg.text || "";

      // ⭐ payment: successful payment
      if (msg.successful_payment) {
        await handleSuccessfulPayment(msg);
      }

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
    const { tg_id, turboMult } = req.body || {};
    if (!tg_id) {
      return res.status(400).json({ ok: false, error: "missing_tg_id" });
    }

    // Load or create user
    let user = await getOrCreateUser(tg_id);

       const availableSpins = user.spins_left ?? 0;

    // Allowed Turbo multipliers from frontend
    const allowed = [1, 5, 10, 20, 50];
    let turbo = 1;

    if (typeof turboMult === "number") {
      const t = Math.floor(turboMult);
      turbo = allowed.includes(t) ? t : 1;
    }

    if (availableSpins < turbo) {
      return res.json({ ok: false, error: "no_spins" });
    }


    const tierKey =
      user.premium_tier && TIER_MULT[user.premium_tier]
        ? user.premium_tier
        : "free";
    const tierMult = TIER_MULT[tierKey];

    // Pick random segment (0..24) – this is the ONLY source of truth
    const index = randInt(0, SEGMENTS_TOTAL - 1);
    const base = slots[index].amount || 0;

    const perSpinPrize = base * tierMult;
    const prize = perSpinPrize * turbo;

    const newBalance = (user.balance ?? 0) + prize;
    const newSpins = availableSpins - turbo;

    const now = new Date().toISOString();
    const { error: upErr } = await supabase
      .from("roff_users")
      .update({
        balance: newBalance,
        spins_left: newSpins,
        last_seen: now,
      })
      .eq("tg_id", tg_id)
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

// --- Miniapp API: update spins from regen ---
app.post("/spins/update", async (req, res) => {
  try {
    const { tg_id, spins_left } = req.body || {};

    if (!tg_id || typeof spins_left !== "number") {
      return res.status(400).json({ ok: false, error: "bad_args" });
    }

    const { error } = await supabase
      .from("roff_users")
      .update({
        spins_left,
        last_seen: new Date().toISOString(),
      })
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (error) {
      console.error("spins/update DB error", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("spins/update server error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// --- Telegram Stars: create invoice link for miniapp purchases ---
app.post("/stars/create-invoice", async (req, res) => {
  try {
    const { tg_id, item_type, item_id } = req.body || {};

    // 1) Basic validation
    if (!tg_id || !item_type || !item_id) {
      return res.status(400).json({ ok: false, error: "missing_params" });
    }

    // payload we can later verify in webhook
    const payload = JSON.stringify({ tg_id, item_type, item_id });

    // 2) decide price
    const amountStars = getStarsPrice(item_type, item_id);
    if (!amountStars || amountStars <= 0) {
      return res.status(400).json({ ok: false, error: "invalid_price" });
    }

        let title = "ROFFLE item";
    let description = "ROFFLE in-game unlock";

    if (item_type === "tier") {
      if (item_id === "plus") title = "$ROF Premium⚡️";
      else if (item_id === "pro") title = "$ROF Plus⭐️";
      else if (item_id === "prem") title = "$ROF Pro👑";
      description = `Unlock ${title} tier in ROFFLE.`;
    } else if (item_type === "wheel") {
      title = "ROFFLE Wheel Skin";
      description = `Unlock wheel skin "${item_id}" in ROFFLE.`;
    } else if (item_type === "bg") {
      title = "ROFFLE Background Skin";
      description = `Unlock background skin "${item_id}" in ROFFLE.`;
    } else if (item_type === "bundle") {
      const cfg = BUNDLE_CONFIG[item_id];
      if (!cfg) {
        return res
          .status(400)
          .json({ ok: false, error: "unknown_bundle" });
      }
      title = cfg.title;
      description = cfg.description;
    }


    // 3) Call Telegram Bot API: createInvoiceLink
    const tgRes = await fetch(`${TG_API}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description,
        payload, // our custom data (tg_id, item_type, item_id)
        currency: "XTR", // Telegram Stars
        prices: [
          {
            label: title,
            amount: amountStars, // integer amount of Stars
          },
        ],
      }),
    });

    const tgJson = await tgRes.json().catch(() => null);

    if (!tgJson || !tgJson.ok) {
      console.error("createInvoiceLink error:", tgJson);
      return res
        .status(500)
        .json({ ok: false, error: "telegram_invoice_failed" });
    }

    // 4) Success → send the invoice link back to the miniapp
    return res.json({
      ok: true,
      invoice_link: tgJson.result,
    });
  } catch (e) {
    console.error("Stars invoice endpoint error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- Miniapp API: apply bundle rewards (e.g. TON-paid bundle) ---
app.post("/bundle/apply", async (req, res) => {
  try {
    const { tg_id, bundle_id } = req.body || {};

    if (!tg_id || !bundle_id) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    const cfg = BUNDLE_CONFIG[bundle_id];
    if (!cfg) {
      return res.status(400).json({ ok: false, error: "unknown_bundle" });
    }

    const rofAdd = cfg.rof || 0;
    const spinsAdd = cfg.spins || 0;
    const ticketsAdd = cfg.tickets || 0;

    // Load user
    let user = await getOrCreateUser(tg_id);

    const currentBalance = user.balance ?? 0;
    const currentSpins = user.spins_left ?? 0;
    const currentTickets = user.golden_tickets ?? 0;

    const tierKey =
      user.premium_tier && TIER_CAP[user.premium_tier]
        ? user.premium_tier
        : "free";
    const cap = TIER_CAP[tierKey] ?? 20;

    const newBalance = currentBalance + rofAdd;
    const newSpins = currentSpins + spinsAdd;
    const newTickets = currentTickets + ticketsAdd;

    const { error: upErr } = await supabase
      .from("roff_users")
      .update({
        balance: newBalance,
        spins_left: newSpins,
        golden_tickets: newTickets,
        last_seen: new Date().toISOString(),
      })
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (upErr) {
      console.error("bundle/apply DB error", upErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({
      ok: true,
      balance: newBalance,
      spins_left: newSpins,
      golden_tickets: newTickets,
    });
  } catch (e) {
    console.error("bundle/apply error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- Miniapp API: apply generic rewards (tasks, collectibles, etc.) ---
app.post("/reward/apply", async (req, res) => {
  try {
    const { tg_id, rofAdd, spinsAdd, ticketsAdd } = req.body || {};

    if (!tg_id) {
      return res.status(400).json({ ok: false, error: "missing_tg_id" });
    }

    const r = typeof rofAdd === "number" ? rofAdd : 0;
    const s = typeof spinsAdd === "number" ? spinsAdd : 0;
    const t = typeof ticketsAdd === "number" ? ticketsAdd : 0;

    if (!r && !s && !t) {
      return res.json({
        ok: true,
        balance: null,
        spins_left: null,
        golden_tickets: null,
      });
    }

    // Load user
    let user = await getOrCreateUser(tg_id);

    const currentBalance = user.balance ?? 0;
    const currentSpins = user.spins_left ?? 0;
    const currentTickets = user.golden_tickets ?? 0;

    // DO NOT cap spins on rewards
    const newBalance = currentBalance + r;
    const newSpins = currentSpins + s;
    const newTickets = currentTickets + t;

    const { error: upErr } = await supabase
      .from("roff_users")
      .update({
        balance: newBalance,
        spins_left: newSpins,
        golden_tickets: newTickets,
        last_seen: new Date().toISOString(),
      })
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (upErr) {
      console.error("reward/apply DB error", upErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({
      ok: true,
      balance: newBalance,
      spins_left: newSpins,
      golden_tickets: newTickets,
    });
  } catch (e) {
    console.error("reward/apply error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// --- Miniapp API: apply premium tier for a user ---
app.post("/tier/apply", async (req, res) => {
  try {
    const { tg_id, tier_key } = req.body || {};

    if (!tg_id || !tier_key) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Update premium_tier in roff_users
    const { data, error } = await supabase
      .from("roff_users")
      .update({ premium_tier: tier_key })
      .eq("tg_id", tg_id)
      .select("*")
      .maybeSingle();

    if (error) {
      console.error("tier/apply DB error", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true, user: data });
  } catch (e) {
    console.error("tier/apply error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- Miniapp API: unlock inventory item (wheel/bg) ---
app.post("/inventory/unlock", async (req, res) => {
  try {
    const { tg_id, item_type, item_id } = req.body || {};

    if (!tg_id || !item_type || !item_id) {
      return res.status(400).json({ ok: false, error: "missing_fields" });
    }

    // Check if already owned
    const { data: existing, error: selErr } = await supabase
      .from("roff_inventory")
      .select("id")
      .eq("tg_id", tg_id)
      .eq("item_type", item_type)
      .eq("item_id", item_id)
      .maybeSingle();

    if (selErr) {
      console.error("inventory/unlock select error", selErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    if (existing) {
      // Already owned – nothing to insert
      return res.json({ ok: true, alreadyOwned: true });
    }

    const { error: insErr } = await supabase
      .from("roff_inventory")
      .insert({ tg_id, item_type, item_id });

    if (insErr) {
      console.error("inventory/unlock insert error", insErr);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({ ok: true, alreadyOwned: false });
  } catch (e) {
    console.error("inventory/unlock server error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


// --- Miniapp API: sync user from Telegram data ---
app.post("/user/sync", async (req, res) => {
  try {
    const { tg_id, username, full_name, photo_url } = req.body || {};

    if (!tg_id) {
      return res.status(400).json({ ok: false, error: "missing_tg_id" });
    }

    const baseUser = {
      tg_id,
      username: username || null,
      full_name: full_name || null,
      photo_url: photo_url || null,
    };

    const { data, error } = await supabase
      .from("roff_users")
      .upsert(baseUser, { onConflict: "tg_id", ignoreDuplicates: false })
      .select("*")
      .eq("tg_id", tg_id)
      .single();

    if (error) {
      console.error("user/sync upsert error", error);
      return res.status(500).json({ ok: false, error: "db_error" });
    }

    return res.json({
      ok: true,
      user: data,
    });
  } catch (e) {
    console.error("user/sync error", e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ ROFFLE bot + API running on port ${PORT}`);
});











