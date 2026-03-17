require("dotenv").config();
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("sesiones")
    .setDescription("Ver y cerrar sesiones activas (Admin)")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    const appId = process.env.APPLICATION_ID;
    const guildId = process.env.GUILD_ID;

    if (!appId || !guildId) throw new Error("Falta APPLICATION_ID o GUILD_ID en .env");

    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    console.log("✅ Comandos desplegados.");
  } catch (e) {
    console.error("❌ Error deploy-commands:", e?.message || e);
    process.exit(1);
  }
})();