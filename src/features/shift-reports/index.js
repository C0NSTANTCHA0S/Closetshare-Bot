const { SlashCommandBuilder } = require("discord.js");
const { makeEmbed, reply } = require("../../core/discord-helpers");

function createFeature({ featureName, featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "shift-reports.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insertStmt = db.prepare(`
    INSERT INTO reports (guild_id, user_id, summary)
    VALUES (?, ?, ?)
  `);

  const latestStmt = db.prepare(`
    SELECT id, user_id, summary, created_at
    FROM reports
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT 5
  `);

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("shift-report")
          .setDescription("Submit a quick shift report.")
          .addStringOption((option) =>
            option.setName("summary").setDescription("What happened on your shift?").setRequired(true)
          ),
        async execute(interaction) {
          const summary = interaction.options.getString("summary", true).trim();
          insertStmt.run(interaction.guildId || "dm", interaction.user.id, summary);
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Shift report saved", description: summary })],
            ephemeral: true
          });
        }
      },
      {
        data: new SlashCommandBuilder()
          .setName("shift-report-list")
          .setDescription("List the latest shift reports."),
        async execute(interaction) {
          const rows = latestStmt.all(interaction.guildId || "dm");
          if (!rows.length) {
            return reply(interaction, { content: "No reports yet.", ephemeral: true });
          }
          const description = rows
            .map((row) => `**#${row.id}** • <@${row.user_id}>\n${row.summary}`)
            .join("\n\n");
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Latest shift reports", description })],
            ephemeral: true
          });
        }
      }
    ]
  };
}

module.exports = { createFeature };
