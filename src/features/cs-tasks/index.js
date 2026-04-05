const { SlashCommandBuilder } = require("discord.js");
const { makeEmbed, reply } = require("../../core/discord-helpers");

function createFeature({ featureName, featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "tasks.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const addTaskStmt = db.prepare(`
    INSERT INTO tasks (guild_id, title, created_by)
    VALUES (?, ?, ?)
  `);

  const listTasksStmt = db.prepare(`
    SELECT id, title, status, created_at
    FROM tasks
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT 10
  `);

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("task-add")
          .setDescription("Add a simple Closet Share task.")
          .addStringOption((option) =>
            option.setName("title").setDescription("Task title").setRequired(true)
          ),
        async execute(interaction) {
          const title = interaction.options.getString("title", true).trim();
          addTaskStmt.run(interaction.guildId || "dm", title, interaction.user.id);
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Task added", description: `Saved: **${title}**` })],
            ephemeral: true
          });
        }
      },
      {
        data: new SlashCommandBuilder()
          .setName("task-list")
          .setDescription("List the newest Closet Share tasks."),
        async execute(interaction) {
          const rows = listTasksStmt.all(interaction.guildId || "dm");
          if (!rows.length) {
            return reply(interaction, { content: "No tasks yet.", ephemeral: true });
          }
          const description = rows
            .map((row) => `**#${row.id}** • ${row.title} — ${row.status}`)
            .join("\n");
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Recent tasks", description, footer: `DB: ${featureName}` })],
            ephemeral: true
          });
        }
      }
    ]
  };
}

module.exports = { createFeature };
