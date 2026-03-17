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

// ===== Discord =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const ADMIN_CHANNEL_ID = process.env.ADMIN_CHANNEL_ID;
const WEBHOOK_KEY = process.env.WEBHOOK_KEY || "";

// Apps Script (doPost) para Sesiones
const SESSIONS_POST_URL = (process.env.SESSIONS_POST_URL || "").trim();

// ===== Redis (persistencia) =====
let redis = null;
const REDIS_URL = (process.env.REDIS_URL || "").trim();
const REDIS_SESSIONS_KEY = "rur:sessions:active:v1";

if (REDIS_URL) {
  try {
    const Redis = require("ioredis");
    redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2 });
    redis.on("error", (e) => console.warn("⚠️ Redis error:", e?.message || e));
    console.log("🧠 Redis habilitado");
  } catch (e) {
    console.warn("⚠️ Redis deshabilitado:", e?.message || e);
    redis = null;
  }
} else {
  console.log("🧠 Redis NO configurado (sin persistencia).");
}

// ===== Estado =====
const sessions = new Map(); // uid -> session
const recentEvents = new Map();
const DEDUPE_WINDOW_MS = 15_000;

setInterval(() => {
  const now = Date.now();
  for (const [k, t] of recentEvents.entries()) {
    if (now - t > DEDUPE_WINDOW_MS) recentEvents.delete(k);
  }
}, 10_000).unref();

// ===== Helpers =====
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
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
  if (!ch) return console.warn("⚠️ No pude obtener canal logs (LOG_CHANNEL_ID/permisos).");
  await ch.send({ embeds: [embed] }).catch(e => console.warn("⚠️ send embed:", e?.message || e));
}

// ===== Sheets doPost =====
async function postSessionToSheets(payload) {
  if (!SESSIONS_POST_URL) return;
  try {
    const r = await fetch(SESSIONS_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow",
    });
    const t = await r.text();
    if (!r.ok) console.warn("⚠️ Sheets doPost fail:", r.status, t);
  } catch (e) {
    console.warn("⚠️ Sheets doPost error:", e?.message || e);
  }
}

// ===== Redis persistence =====
function sessionToStorable(s) {
  return {
    uid: s.uid,
    nombre: s.nombre || "",
    matricula: s.matricula || "",
    discordId: s.discordId || "",
    startMs: Number(s.startMs || Date.now()),
    lastMs: Number(s.lastMs || Date.now()),
  };
}

async function persistOne(uid) {
  if (!redis) return;
  const s = sessions.get(uid);
  if (!s) return;
  await redis.hset(REDIS_SESSIONS_KEY, uid, JSON.stringify(sessionToStorable(s))).catch(() => {});
}

async function removePersisted(uid) {
  if (!redis) return;
  await redis.hdel(REDIS_SESSIONS_KEY, uid).catch(() => {});
}

async function restoreSessionsFromRedis() {
  if (!redis) return;
  const data = await redis.hgetall(REDIS_SESSIONS_KEY).catch(() => ({}));
  const uids = Object.keys(data || {});
  if (!uids.length) return console.log("🧠 Redis: no había sesiones guardadas.");

  for (const uid of uids) {
    try {
      const p = JSON.parse(data[uid]);
      sessions.set(uid, { ...p });
    } catch {}
  }
  console.log(`🧠 Redis: sesiones restauradas: ${sessions.size}`);
}

// ===== Session logic =====
async function openSession({ uid, nombre, matricula, discordId, timestampMs, fecha, hora }) {
  sessions.set(uid, {
    uid, nombre, matricula, discordId,
    startMs: timestampMs,
    lastMs: timestampMs
  });

  await persistOne(uid);

  // escribir Sesiones (Activa=TRUE)
  await postSessionToSheets({
    uid, nombre, matricula, discordId,
    startMs: timestampMs,
    endMs: 0,
    active: true,
    closedBy: "",
    reason: ""
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

  const endMs = s.lastMs || Date.now();
  const dur = fmtDuration(endMs - s.startMs);

  // escribir Sesiones (Activa=FALSE)
  await postSessionToSheets({
    uid,
    nombre: s.nombre || "",
    matricula: s.matricula || "",
    discordId: s.discordId || "",
    startMs: s.startMs,
    endMs: endMs,
    active: false,
    closedBy,
    reason: reason || ""
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
  await removePersisted(uid);
}

// ===== HTTP endpoints =====
app.get("/health", (req, res) => {
  res.json({ ok: true, sessions: sessions.size, redis: !!redis, time: new Date().toISOString() });
});

app.post("/webhook", async (req, res) => {
  const key = String(req.query.key || "");
  if (WEBHOOK_KEY && key !== WEBHOOK_KEY) return res.status(403).send("Forbidden");

  const body = req.body || {};
  const uid = body.uid ? String(body.uid).trim().toUpperCase() : "";
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
      await persistOne(uid);
      await closeSession(uid, "user");
    }
    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ webhook error:", e?.message || e);
    return res.status(500).send("Error");
  }
});

// ===== Discord Admin UI (/sesiones cerrar) =====
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === "sesiones") {
      if (interaction.channelId !== ADMIN_CHANNEL_ID) {
        return interaction.reply({ content: "Usa este comando en el canal admin.", flags: 64 });
      }
      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "No tienes permisos.", flags: 64 });
      }

      const items = Array.from(sessions.entries()).slice(0, 25);
      if (!items.length) return interaction.reply({ content: "No hay sesiones activas.", flags: 64 });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("close_session_select")
        .setPlaceholder("Selecciona una sesión activa…")
        .addOptions(
          items.map(([uid, s]) => ({
            label: `${s.nombre || "Sin nombre"} / ${s.matricula || "Sin matrícula"}`.slice(0, 100),
            description: `UID: ${uid}`.slice(0, 100),
            value: uid,
          }))
        );

      const row = new ActionRowBuilder().addComponents(menu);
      const embed = new EmbedBuilder()
        .setTitle("Sesiones activas")
        .setDescription("Selecciona una sesión para cerrarla (admin).");

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
        return interaction.reply({ content: "No tienes permisos.", flags: 64 });
      }

      const s = sessions.get(uid);
      if (s) s.lastMs = Date.now();

      await closeSession(uid, "admin", reason);
      return interaction.reply({ content: `Sesión cerrada (UID ${uid}).`, flags: 64 });
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: "Error interno.", flags: 64 }).catch(() => {});
    }
  }
});

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot listo: ${client.user.tag}`);
  await restoreSessionsFromRedis();
});
client.login(process.env.DISCORD_TOKEN);

// ===== Listen (Railway uses PORT) =====
const port = Number(process.env.PORT || 3000);
app.listen(port, "0.0.0.0", () => console.log(`✅ HTTP listo en :${port}`));