# GitHub deployment secrets to add

Add these in GitHub:
Repo -> Settings -> Secrets and variables -> Actions -> New repository secret

Required secrets:
- DEPLOY_HOST = your server IP or hostname
- DEPLOY_USER = the SSH user, likely root
- DEPLOY_SSH_KEY = your private SSH key contents
- DEPLOY_PORT = usually 22

## How deployment works
When a change is merged or pushed to `main`, GitHub Actions will:
1. SSH into the server
2. `cd /root/CS-Bot`
3. `git fetch origin main`
4. `git reset --hard origin/main`
5. install dependencies
6. run `node register-commands.js`
7. restart `cs-bot` with PM2

## Important
- The server repo remote should use GitHub access that works non-interactively.
- SSH key auth for GitHub Actions is separate from GitHub repo push auth.
- `.env` stays on the server and is not overwritten by the deployment workflow.
