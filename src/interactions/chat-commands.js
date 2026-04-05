const { Events } = require("discord.js");
const { reply, isCustomIdMatch } = require("../core/discord-helpers");

function resolveHandler(registry, customId) {
  for (const handler of registry.values()) {
    if (isCustomIdMatch(customId, handler.customId)) {
      return handler;
    }
  }
  return null;
}

function wireInteractionHandlers(client) {
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) {
          return reply(interaction, { content: `Unknown command: ${interaction.commandName}`, ephemeral: true });
        }
        return command.execute(interaction, { client });
      }

      if (interaction.isButton()) {
        const button = resolveHandler(client.buttons, interaction.customId);
        if (!button) return;
        return button.execute(interaction, { client });
      }

      if (interaction.isStringSelectMenu()) {
        const menu = resolveHandler(client.selectMenus, interaction.customId);
        if (!menu) return;
        return menu.execute(interaction, { client });
      }

      if (interaction.isModalSubmit()) {
        const modal = resolveHandler(client.modals, interaction.customId);
        if (!modal) return;
        return modal.execute(interaction, { client });
      }
    } catch (error) {
      console.error("[interaction] Unhandled error:", error);
      return reply(interaction, {
        content: "Something went wrong while handling that interaction.",
        ephemeral: true
      });
    }
  });
}

module.exports = { wireInteractionHandlers };
