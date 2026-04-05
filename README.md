# Closet Share Bot Starter

This is a stable starter Discord bot scaffold built around **one SQLite database per feature**.

## What is included

- Dynamic feature loading from `src/features/*/index.js`
- Separate SQLite file for each feature under `data/<feature-slug>/`
- Working slash command registration
- Stable command / button / modal / select interaction router
- Starter features for:
  - CS Tasks
  - Economy
  - Leaderboard
  - Shift Reports
  - SpinWheel

## Setup

1. Copy `.env.example` to `.env`
2. Fill in:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DISCORD_GUILD_ID` (recommended for testing)
3. Install packages:
   - `npm install`
4. Register commands:
   - `npm run register`
5. Start the bot:
   - `npm run start`

## Feature pattern

Each feature exports `createFeature()` from its own `index.js` and receives:

- `featureName`
- `featureSlug`
- `createFeatureDb()`

That lets every feature own its own schema and DB file.

## Recommended next build order

1. Finish Economy as your shared reward system
2. Connect SpinWheel rewards into Economy transactions
3. Add volunteer referrals as a dedicated feature with its own DB
4. Add approvals/modals/buttons only after the slash-command flow is stable
5. Add scheduled jobs after core commands are proven stable
