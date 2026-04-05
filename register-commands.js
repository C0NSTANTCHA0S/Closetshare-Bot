const { REST, Routes } = require("discord.js");
const { loadEnv } = require("./src/core/env");

loadEnv();

const { config } = require("./src/core/config");
const { loadFeatures } = require("./src/core/storage");

function collectCommandBuilders(features) {
  const seen = new Map();
  const builders = [];

  for (const feature of features) {
    for (const command of feature.commands || []) {
      if (!command?.data?.name || typeof command.data.toJSON !== "function") {
        throw new Error(`Feature "${feature.name}" has a command without a valid SlashCommandBuilder.`);
      }

      const name = command.data.name;
      if (seen.has(name)) {
        throw new Error(
          `Duplicate slash command name "${name}" found in features "${seen.get(name)}" and "${feature.name}".`
        );
      }

      seen.set(name, feature.name);
      builders.push(command.data);
    }
  }

  return builders.sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  const features = loadFeatures();
  const commandBuilders = collectCommandBuilders(features);
  const commands = commandBuilders.map((command) => command.toJSON());

  const rest = new REST({ version: "10" }).setToken(config.token);
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  await rest.put(route, { body: commands });

  console.log(
    `Registered ${commands.length} command(s) ${config.guildId ? `to guild ${config.guildId}` : "globally"}:`
  );
  for (const command of commandBuilders) {
    console.log(`- /${command.name}`);
  }
}

main().catch((error) => {
  console.error("Failed to register commands:", error);
  process.exit(1);
});
