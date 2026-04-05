# Closet Share Bot

Discord bot for Closet Share.

## Setup
1. Copy `.env.example` to `.env`
2. Fill in environment variables
3. Install dependencies
4. Register commands
5. Start the bot

## Common commands
- `node register-commands.js`
- `pm2 restart cs-bot --update-env`

## Project structure
- `register-commands.js` — centralized slash command registration
- `src/core/` — shared env, config, helpers, storage
- `src/features/` — feature modules

## Notes
- Do not commit `.env`
- Keep command registration aligned with runtime commands
- Prefer shared helpers over duplicated feature logic

## GitHub auto-deploy
This repo includes a GitHub Actions workflow at `.github/workflows/deploy-main.yml`.
When code is pushed to `main`, it SSHes into your server, updates the repo, installs dependencies, runs `register-commands.js`, and restarts the bot with PM2.
