# Deploy to Vercel + Turso

Step-by-step guide to get the Winning Circle Dashboard live in ~10 minutes.

---

## Step 1: Create a Turso Database (free)

Turso is cloud-hosted SQLite — same SQL you already know, with a generous free tier (9GB, 500M reads/month).

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Sign up / login
turso auth signup     # or: turso auth login

# Create a database
turso db create winning-circle

# Get your connection URL
turso db show winning-circle --url
# → libsql://winning-circle-yourorg.turso.io

# Create an auth token
turso db tokens create winning-circle
# → eyJhbGci... (save this!)
```

Save both values — you'll need them in Step 3.

---

## Step 2: Push Code to GitHub

```bash
cd winning-circle-dashboard
git init
git add .
git commit -m "Initial commit — Winning Circle Dashboard"

# Create a repo on GitHub, then:
git remote add origin https://github.com/YOUR_USERNAME/winning-circle-dashboard.git
git push -u origin main
```

---

## Step 3: Deploy to Vercel

### Option A: Vercel CLI (fastest)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Set environment variables
vercel env add TURSO_DATABASE_URL     # paste your libsql:// URL
vercel env add TURSO_AUTH_TOKEN       # paste your token

# If using Slack:
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_SIGNING_SECRET
vercel env add SLACK_CHANNEL_ID

# Redeploy with env vars
vercel --prod
```

### Option B: Vercel Dashboard (visual)

1. Go to [vercel.com](https://vercel.com) → **Add New Project**
2. Import your GitHub repo
3. Under **Environment Variables**, add:
   - `TURSO_DATABASE_URL` = your libsql:// URL
   - `TURSO_AUTH_TOKEN` = your token
4. Click **Deploy**

Your dashboard will be live at `https://winning-circle-dashboard.vercel.app` (or your custom domain).

---

## Step 4: Connect Slack (optional)

Once your Vercel URL is live:

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App
2. Under **OAuth & Permissions**, add scopes: `chat:write`, `commands`, `im:write`, `users:read`
3. Create slash commands pointing to your Vercel URL:

| Command | Request URL |
|---------|------------|
| `/tasks` | `https://YOUR-APP.vercel.app/slack/events` |
| `/newtask` | `https://YOUR-APP.vercel.app/slack/events` |
| `/update` | `https://YOUR-APP.vercel.app/slack/events` |

4. Enable **Interactivity** → Request URL: `https://YOUR-APP.vercel.app/slack/events`
5. Install to workspace, copy Bot Token + Signing Secret
6. Add them as Vercel environment variables and redeploy

---

## Step 5: Add Your Team

Open your dashboard URL and click **Add Member** in the sidebar. Add all 15 team members with their names and optional Slack User IDs.

To find a Slack User ID: click on someone's profile in Slack → **More** → **Copy member ID**.

---

## Custom Domain (optional)

In Vercel Dashboard → your project → **Settings** → **Domains** → add your domain (e.g., `tasks.winningcircle.io`).

---

## Local Development

You can run the dashboard locally alongside the cloud database:

```bash
cp .env.example .env
# Fill in your Turso credentials in .env
npm install
npm start
# → http://localhost:3000
```

Or use local SQLite only (no cloud):
```bash
# Just run without Turso env vars — it falls back to local file
npm start
```
