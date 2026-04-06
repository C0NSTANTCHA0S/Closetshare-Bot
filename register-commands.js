const { REST, Routes } = require("discord.js");
const { loadEnv } = require("./src/core/env");

loadEnv();

const { config } = require("./src/core/config");
const { loadFeatures } = require("./src/core/storage");

function validateOptionList(options, contextLabel) {
  if (!Array.isArray(options) || options.length === 0) return;
  if (options.length > 25) {
    throw new Error(`${contextLabel} has ${options.length} options. Discord allows at most 25.`);
  }

  const seenOptionNames = new Set();
  const hasSubcommands = options.some((option) => option.type === 1 || option.type === 2);
  const hasNonSubcommands = options.some((option) => option.type !== 1 && option.type !== 2);
  if (hasSubcommands && hasNonSubcommands) {
    throw new Error(`${contextLabel} mixes subcommand/group options with regular options, which Discord rejects.`);
  }

  let sawOptional = false;
  for (const option of options) {
    const optionName = option?.name;
    if (!optionName) {
      throw new Error(`${contextLabel} has an option missing a name.`);
    }
    if (seenOptionNames.has(optionName)) {
      throw new Error(`${contextLabel} has duplicate option name "${optionName}".`);
    }
    seenOptionNames.add(optionName);

    const required = option.required === true;
    if (required && sawOptional) {
      throw new Error(
        `${contextLabel} has required option "${optionName}" after an optional option. Required options must come first.`
      );
    }
    if (!required) sawOptional = true;

    if (Array.isArray(option.options) && option.options.length > 0) {
      validateOptionList(option.options, `${contextLabel} > option "${optionName}"`);
    }
  }
}

function validateCommandBuilder(command, featureName) {
  const payload = command.toJSON();
  if (!payload?.name || typeof payload.name !== "string") {
    throw new Error(`Feature "${featureName}" has a command with missing/invalid name.`);
  }
  if (!payload?.description || typeof payload.description !== "string") {
    throw new Error(`Feature "${featureName}" command "${payload.name}" is missing a valid description.`);
  }
  validateOptionList(payload.options || [], `Command "/${payload.name}"`);
}

function collectCommandBuilders(features) {
  const seen = new Map();
  const builders = [];

  for (const feature of features) {
    for (const command of feature.commands || []) {
      if (!command?.data?.name || typeof command.data.toJSON !== "function") {
        throw new Error(`Feature "${feature.name}" has a command without a valid SlashCommandBuilder.`);
      }

      validateCommandBuilder(command.data, feature.name);

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

if (require.main === module) {
  main().catch((error) => {
    console.error("Failed to register commands:", error);
    process.exit(1);
  });
}

module.exports = { collectCommandBuilders, validateCommandBuilder, validateOptionList };
