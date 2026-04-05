const { Client, Collection, GatewayIntentBits, Partials } = require("discord.js");

function createBotClient(features) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  client.commands = new Collection();
  client.buttons = new Collection();
  client.selectMenus = new Collection();
  client.modals = new Collection();
  client.features = features;
  client.commandOwners = new Collection();

  for (const feature of features) {
    for (const command of feature.commands || []) {
      const commandName = command?.data?.name;
      if (!commandName) {
        throw new Error(`Feature "${feature.name}" has a runtime command without a valid name.`);
      }
      if (client.commands.has(commandName)) {
        const existingOwner = client.commandOwners.get(commandName) || "unknown";
        throw new Error(
          `Duplicate runtime command "${commandName}" found in features "${existingOwner}" and "${feature.name}".`
        );
      }
      client.commands.set(commandName, command);
      client.commandOwners.set(commandName, feature.name);
    }
    for (const button of feature.buttons || []) {
      client.buttons.set(button.customId, button);
    }
    for (const menu of feature.selectMenus || []) {
      client.selectMenus.set(menu.customId, menu);
    }
    for (const modal of feature.modals || []) {
      client.modals.set(modal.customId, modal);
    }
  }

  return client;
}

module.exports = { createBotClient };
