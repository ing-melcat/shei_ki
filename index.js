require("dotenv").config();
const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  PermissionsBitField,
  Events,
} = require("discord.js");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "";

// Apps Script doPost endpoint to update the "Sesiones" sheet (optional but recommended)
// Example: https://script.google.com/macros/s/XXXXX/exec?key=mi_clave_secreta
const SESSIONS_POST_URL = (process.env.SESSIONS_POST_URL || "").trim();

// Redis persistence (optional). In Railway, add a Redis DB and set REDIS_URL from it.
const REDIS_URL = (process.env.REDIS_URL || "").trim();
const REDIS_KEY = "rur:sessions:v1";
let redis = null;
if (REDIS_URL) {
  try {
    const Redis = require("ioredis");
    redis = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
    });
    redis.on("error", (e) => console.warn("⚠️ Redis error:", e?.message || e));
    console.log("🧠 Redis habilitado");
  } catch (e) {
    console.warn("⚠️ Redis NO disponible:", e?.message || e);
    redis = null;
  }
} else {
  console.log("🧠 Redis NO configurado (sin persistencia)." );
}

// ===== Estado =====
const sessions = new Map(); // uid -> session
const recentEvents = new Map(); // dedupe
const DEDUPE_WINDOW_MS = 15_000;

function cleanupDedupe() {
  const now = Date.now();
  for (const [k, t] of recentEvents.entries()) {
    if (now - t > DEDUPE_WINDOW_MS) recentEvents.delete(k);
  }
}
setInterval(cleanupDedupe, 10_000).unref();

function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s
    .toString()
    .padStart(2, "0")}`;
}

function parseFechaHoraToMs(fecha, hora) {
  try {
    const [dd, mm, yyyy] = String(fecha).split("/").map(Number);
    const [HH, MM, SS] = String(hora).split(":").map(Number);
    if (!dd || !mm || !yyyy) return null;
    return new Date(yyyy, mm - 1, dd, HH || 0, MM || 0, SS || 0).getTime();
  } catch {
    return null;
  }
}

async function getLogChannel() {
  return await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
}

async function postLog(embed) {
  const ch = await getLogChannel();
  if (!ch) {
    console.warn("⚠️ No pude obtener canal logs. Revisa LOG_CHANNEL_ID y permisos.");
    return;
  }
  await ch.send({ embeds: [embed] }).catch((e) => console.error("❌ send error:", e?.message || e));
}

async function dm(discordId, text) {
  if (!discordId) return;
  const user = await client.users.fetch(discordId).catch(() => null);
  if (user) await user.send(text).catch(() => null);
}

function clearTimers(s) {
  if (s.t2h) clearTimeout(s.t2h);
  if (s.t3h) clearTimeout(s.t3h);
  if (s.t30m) clearInterval(s.t30m);
  s.t2h = s.t3h = s.t30m = null;
}

function scheduleReminders(uid) {
  const s = sessions.get(uid);
  if (!s) return;

  clearTimers(s);

  s.t2h = setTimeout(async () => {
    const cur = sessions.get(uid);
    if (!cur) return;
    await dm(
      cur.discordId,
      `⏰ Recordatorio: tu sesión sigue activa desde hace **2 horas**.\n` +
        `Pasa tu tarjeta para cerrar.\n` +
        `Si no puedes pasarla, comunícate con un administrador de la RUR para cerrar tu sesión.`
    );
  }, 2 * 60 * 60 * 1000);

  s.t3h = setTimeout(async () => {
    const cur = sessions.get(uid);
    if (!cur) return;

    await dm(
      cur.discordId,
      `⚠️ Tu sesión sigue activa desde hace **3 horas**.\n` +
        `Pasa tu tarjeta o comunícate con un administrador de la RUR para cerrar tu sesión.`
    );

    s.t30m = setInterval(async () => {
      const again = sessions.get(uid);
      if (!again) return;
      await dm(
        again.discordId,
        `⚠️ Recordatorio (cada 30 min): tu sesión sigue activa.\n` +
          `Comunícate con un administrador de la RUR para cerrar tu sesión si no puedes pasar tu tarjeta.`
      );
    }, 30 * 60 * 1000);
  }, 3 * 60 * 60 * 1000);
}

// ===== Helpers: Sheets (Sesiones) =====
async function postSessionToSheets(payload) {
  if (!SESSIONS_POST_URL) return;
  try {
    const r = await fetch(SESSIONS_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn("⚠️ Sheets update failed:", r.status, t.slice(0, 200));
    }
  } catch (e) {
    console.warn("⚠️ Sheets update error:", e?.message || e);
  }
}

// ===== Helpers: Redis persistence =====
function storableSession(s) {
  return {
    uid: s.uid,
    nombre: s.nombre || "",
    matricula: s.matricula || "",
    discordId: s.discordId || "",
    startMs: Number(s.startMs || Date.now()),
    lastMs: Number(s.lastMs || Date.now()),
  };
}

async function persistSession(uid) {
  if (!redis) return;
  const s = sessions.get(uid);
  if (!s) return;
  await redis.hset(REDIS_KEY, uid, JSON.stringify(storableSession(s))).catch(() => {});
}

async function removePersistedSession(uid) {
  if (!redis) return;
  await redis.hdel(REDIS_KEY, uid).catch(() => {});
}

function scheduleRemindersFromStart(uid) {
  // Re-schedule reminders using remaining time since start
  const s = sessions.get(uid);
  if (!s) return;

  clearTimers(s);
  const now = Date.now();
  const elapsed = Math.max(0, now - (s.startMs || now));
  const t2 = 2 * 60 * 60 * 1000;
  const t3 = 3 * 60 * 60 * 1000;

  const wait2 = Math.max(0, t2 - elapsed);
  const wait3 = Math.max(0, t3 - elapsed);

  s.t2h = setTimeout(async () => {
    const cur = sessions.get(uid);
    if (!cur) return;
    await dm(
      cur.discordId,
      `⏰ Recordatorio: tu sesión sigue activa desde hace **2 horas**.\n` +
        `Pasa tu tarjeta para cerrar.\n` +
        `Si no puedes pasarla, comunícate con un administrador de la RUR para cerrar tu sesión.`
    );
  }, wait2);

  s.t3h = setTimeout(async () => {
    const cur = sessions.get(uid);
    if (!cur) return;

    await dm(
      cur.discordId,
      `⚠️ Tu sesión sigue activa desde hace **3 horas**.\n` +
        `Pasa tu tarjeta o comunícate con un administrador de la RUR para cerrar tu sesión.`
    );

    s.t30m = setInterval(async () => {
      const again = sessions.get(uid);
      if (!again) return;
      await dm(
        again.discordId,
        `⚠️ Recordatorio (cada 30 min): tu sesión sigue activa.\n` +
          `Comunícate con un administrador de la RUR para cerrar tu sesión si no puedes pasar tu tarjeta.`
      );
    }, 30 * 60 * 1000);
  }, wait3);
}

async function restoreSessions() {
  if (!redis) return;
  try {
    const data = await redis.hgetall(REDIS_KEY);
    const uids = Object.keys(data || {});
    if (!uids.length) {
      console.log("🧠 Redis: no había sesiones guardadas.");
      return;
    }
    for (const uid of uids) {
      try {
        const s = JSON.parse(data[uid]);
        sessions.set(uid, {
          uid,
          nombre: s.nombre || "",
          matricula: s.matricula || "",
          discordId: s.discordId || "",
          startMs: Number(s.startMs || Date.now()),
          lastMs: Number(s.lastMs || s.startMs || Date.now()),
          t2h: null,
          t3h: null,
          t30m: null,
        });
        scheduleRemindersFromStart(uid);
      } catch {}
    }
    console.log(`🧠 Redis: sesiones restauradas: ${sessions.size}`);
  } catch (e) {
    console.warn("⚠️ Redis restore error:", e?.message || e);
  }
}

async function openSession({ uid, nombre, matricula, discordId, timestampMs, fecha, hora }) {
  sessions.set(uid, {
    uid,
    nombre,
    matricula,
    discordId,
    startMs: timestampMs,
    lastMs: timestampMs,
    t2h: null,
    t3h: null,
    t30m: null,
  });

  scheduleReminders(uid);
  await persistSession(uid);

  // Update Sheet "Sesiones" (active=TRUE)
  await postSessionToSheets({
    uid,
    nombre: nombre || "",
    matricula: matricula || "",
    discordId: discordId || "",
    startMs: timestampMs,
    endMs: 0,
    active: true,
    closedBy: "",
    reason: "",
  });

  const whenText = fecha && hora ? `${fecha} ${hora}` : `<t:${Math.floor(timestampMs / 1000)}:F>`;
  const embed = new EmbedBuilder()
    .setTitle("🟢 INICIO DE SESIÓN")
    .addFields(
      { name: "UID", value: `\`${uid}\``, inline: true },
      { name: "Nombre / Matrícula", value: `${nombre || "Sin nombre"} / ${matricula || "Sin matrícula"}`, inline: false },
      { name: "Fecha/Hora", value: whenText, inline: false }
    );

  await postLog(embed);
}

async function closeSession(uid, closedBy, reason = "") {
  const s = sessions.get(uid);
  if (!s) return;

  clearTimers(s);

  const endMs = s.lastMs || Date.now();
  const dur = fmtDuration(endMs - s.startMs);

  // Update Sheet "Sesiones" (active=FALSE)
  await postSessionToSheets({
    uid,
    nombre: s.nombre || "",
    matricula: s.matricula || "",
    discordId: s.discordId || "",
    startMs: s.startMs || 0,
    endMs,
    active: false,
    closedBy,
    reason: closedBy === "admin" ? (reason || "") : "",
  });

  const embed = new EmbedBuilder()
    .setTitle("✅ CIERRE DE SESIÓN")
    .addFields(
      { name: "UID", value: `\`${uid}\``, inline: true },
      { name: "Nombre / Matrícula", value: `${s.nombre || "Sin nombre"} / ${s.matricula || "Sin matrícula"}`, inline: false },
      { name: "Duración", value: `**${dur}**`, inline: true },
      { name: "Inicio", value: `<t:${Math.floor(s.startMs / 1000)}:F>`, inline: false },
      { name: "Fin", value: `<t:${Math.floor(endMs / 1000)}:F>`, inline: false }
    );

  if (closedBy === "admin") {
    embed.addFields({ name: "Cerrada por admin", value: `Motivo: **${reason || "Sin motivo"}**`, inline: false });
  }

  await postLog(embed);
  sessions.delete(uid);
  await removePersistedSession(uid);
}

// ===== Endpoints =====
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => res.json({ ok: true, sessions: sessions.size, time: new Date().toISOString() }));

app.post("/webhook", async (req, res) => {
  const key = String(req.query.key || "");
  if (WEBHOOK_KEY && key !== WEBHOOK_KEY) {
    console.warn("🚫 Webhook Forbidden (bad key) from", req.ip);
    return res.status(403).send("Forbidden");
  }

  const body = req.body || {};
  const uid = body.uid ? String(body.uid).trim().toUpperCase() : "";

  console.log("📩 Webhook recibido:", {
    uid,
    fecha: body.fecha,
    hora: body.hora,
    nombre: body.nombre,
    matricula: body.matricula,
    hasDiscordId: !!body.discordId,
  });

  if (!uid) return res.status(400).send("Missing uid");

  const eventId = `${uid}|${body.fecha || ""}|${body.hora || ""}|${body.nombre || ""}|${body.matricula || ""}`;
  if (recentEvents.has(eventId)) return res.status(200).send("OK (duplicate ignored)");
  recentEvents.set(eventId, Date.now());

  const tsFromSheet = (body.fecha && body.hora) ? parseFechaHoraToMs(body.fecha, body.hora) : null;
  const timestampMs = tsFromSheet ?? Date.now();

  const nombre = body.nombre ? String(body.nombre) : "";
  const matricula = body.matricula ? String(body.matricula) : "";
  const discordId = body.discordId ? String(body.discordId) : "";

  try {
    if (!sessions.has(uid)) {
      await openSession({ uid, nombre, matricula, discordId, timestampMs, fecha: body.fecha, hora: body.hora });
    } else {
      const s = sessions.get(uid);
      s.lastMs = timestampMs;
      await persistSession(uid);
      await closeSession(uid, "user");
    }
    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ Error procesando webhook:", e?.message || e);
    return res.status(500).send("Error");
  }
});

// ===== Admin UI =====
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "sesiones") {
      if (interaction.channelId !== ADMIN_CHANNEL_ID) {
        return interaction.reply({ content: "Usa este comando en el canal admin.", ephemeral: true });
      }
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "No tienes permisos.", ephemeral: true });
      }

      const items = Array.from(sessions.entries()).slice(0, 25);
      if (!items.length) return interaction.reply({ content: "No hay sesiones activas.", ephemeral: true });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("close_session_select")
        .setPlaceholder("Selecciona una sesión activa...")
        .addOptions(
          items.map(([uid, s]) => ({
            label: `${s.nombre || "Sin nombre"} / ${s.matricula || "Sin matrícula"}`.slice(0, 100),
            description: `UID: ${uid}`.slice(0, 100),
            value: uid,
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);
      const embed = new EmbedBuilder().setTitle("Sesiones activas").setDescription("Selecciona una para cerrarla (admin).");
      return interaction.reply({ embeds: [embed], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "close_session_select") {
      const uid = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`close_session_modal:${uid}`)
        .setTitle("Cerrar sesión (Admin)");

      const reasonInput = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Motivo del cierre")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(300);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("close_session_modal:")) {
      const uid = interaction.customId.split(":")[1];
      const reason = interaction.fields.getTextInputValue("reason");

      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "No tienes permisos.", ephemeral: true });
      }

      const s = sessions.get(uid);
      if (s) s.lastMs = Date.now();

      await closeSession(uid, "admin", reason);
      return interaction.reply({ content: `Sesión cerrada (UID ${uid}).`, ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied) interaction.reply({ content: "Error interno.", ephemeral: true }).catch(() => {});
  }
});

// v15-friendly
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot listo: ${client.user.tag}`);
  await restoreSessions();
});
client.login(process.env.DISCORD_TOKEN);

// Railway PORT
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`✅ HTTP listo en :${port} (POST /webhook, GET /health)`)
);

// Graceful shutdown (Railway)
function shutdown() {
  console.log("🛑 Shutting down...");
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);