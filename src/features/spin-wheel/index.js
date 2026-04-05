const { SlashCommandBuilder } = require("discord.js");
const { makeEmbed, reply } = require("../../core/discord-helpers");
const { applyCoinDelta } = require("../../core/economy-db");

function createFeature({ featureName, featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "spinwheel.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reward INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insertSpinStmt = db.prepare(`
    INSERT INTO spins (guild_id, user_id, reward)
    VALUES (?, ?, ?)
  `);

  const rewards = [0, 5, 10, 15, 20, 25];

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("spin")
          .setDescription("Spin a simple reward wheel."),
        async execute(interaction) {
          const reward = rewards[Math.floor(Math.random() * rewards.length)];
          insertSpinStmt.run(interaction.guildId || "dm", interaction.user.id, reward);

          if (reward > 0) {
            applyCoinDelta({
              guildId: interaction.guildId || "dm",
              userId: interaction.user.id,
              amount: reward,
              reason: "Spin wheel reward",
              createdBy: interaction.user.id,
              source: "spin_wheel"
            });
          }

          return reply(interaction, {
            embeds: [
              makeEmbed({
                title: "Spin result",
                description: reward > 0 ? `You won **${reward}** coins.` : `No coins this time.`,
                footer: "Spin rewards are applied to your persistent coin balance."
              })
            ]
          });
        }
      }
    ]
  };
}

module.exports = { createFeature };
