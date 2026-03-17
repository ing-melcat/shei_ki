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
  const appId = process.env.APPLICATION_ID || process.env.APP_ID;
  const guildId = process.env.GUILD_ID;
  if (!process.env.DISCORD_TOKEN || !appId || !guildId) {
    console.error("❌ Missing env. Need DISCORD_TOKEN, APPLICATION_ID (or APP_ID), GUILD_ID");
    process.exit(1);
  }
  await rest.put(
    Routes.applicationGuildCommands(appId, guildId),
    { body: commands }
  );
  console.log("✅ Comandos registrados (/sesiones).");
})();