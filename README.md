# Winning Circle — Task Dashboard

A real-time Kanban task management dashboard with Slack integration for a 15-person team.

## Features

- **Kanban Board** — Drag-and-drop tasks across To Do / In Progress / Review / Done
- **Team Overview** — See each member's task distribution at a glance
- **Activity Feed** — Track all task changes in real time
- **Daily Updates** — Team members submit what they've done, what they're working on, and blockers
- **Slack Bot** — Automated daily reminders + task management via slash commands
- **Dashboard Stats** — Total tasks, in-progress count, completed today, per-member breakdown

---

## Quick Start

```bash
# 1. Install dependencies
cd winning-circle-dashboard
npm install

# 2. Copy env file and configure
cp .env.example .env

# 3. Start the server (Slack is optional — dashboard works without it)
npm start

# 4. Open http://localhost:3000
```

The dashboard works immediately without Slack. Add team members via the sidebar, create tasks, drag them across columns.

---

## Slack Setup (Optional but Recommended)

### Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it "Winning Circle Bot", select your workspace

### Step 2: Configure Permissions

Under **OAuth & Permissions**, add these Bot Token Scopes:

- `chat:write` — Send messages
- `commands` — Slash commands
- `im:write` — DM users
- `users:read` — Look up users

### Step 3: Create Slash Commands

Under **Slash Commands**, create:

| Command | Request URL | Description |
|---------|------------|-------------|
| `/tasks` | `https://your-domain.com/slack/events` | View your active tasks |
| `/newtask` | `https://your-domain.com/slack/events` | Create a new task |
| `/update` | `https://your-domain.com/slack/events` | Submit your daily update |

### Step 4: Enable Interactivity

Under **Interactivity & Shortcuts**:
- Toggle ON
- Request URL: `https://your-domain.com/slack/events`

### Step 5: Install & Configure

1. **Install to Workspace** under OAuth
2. Copy the **Bot User OAuth Token** → paste in `.env` as `SLACK_BOT_TOKEN`
3. Copy the **Signing Secret** (under Basic Information) → paste as `SLACK_SIGNING_SECRET`
4. Get your channel ID (right-click channel → Copy Link → extract ID) → paste as `SLACK_CHANNEL_ID`

### Step 6: Link Team Members

For each team member, add their Slack User ID in the dashboard (Team view) or via the API:

```bash
curl -X PUT http://localhost:3000/api/members/1 \
  -H "Content-Type: application/json" \
  -d '{"slack_id": "U01ABC23DEF"}'
```

To find a Slack User ID: click on a user's profile → More → Copy member ID.

---

## Slack Commands (for team members)

| Command | What it does |
|---------|-------------|
| `/tasks` | Shows your active tasks with dropdown to change status |
| `/newtask Buy supplies` | Creates a new task assigned to you |
| `/update` | Opens a form to submit your daily standup update |

---

## Automated Reminders

Once Slack is connected:

- **9:00 AM weekdays** — Standup reminder sent to the team channel, tagging all members
- **5:00 PM weekdays** — Daily summary posted: tasks completed, in-progress count, update submissions

Change the reminder time in `.env`:
```
REMINDER_CRON=0 9 * * 1-5
```

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/members` | List all team members |
| POST | `/api/members` | Add a member |
| PUT | `/api/members/:id` | Update a member |
| DELETE | `/api/members/:id` | Remove a member |
| GET | `/api/tasks` | List tasks (filter: `?status=`, `?member_id=`) |
| POST | `/api/tasks` | Create a task |
| PUT | `/api/tasks/:id` | Update a task |
| DELETE | `/api/tasks/:id` | Delete a task |
| GET | `/api/stats` | Dashboard statistics |
| GET | `/api/daily-updates` | Get daily updates (filter: `?date=`) |
| POST | `/api/daily-updates` | Submit a daily update |
| GET | `/api/activity` | Activity log (filter: `?limit=`) |

---

## Deployment

For production, consider:

1. **Railway / Render / Fly.io** — Easy Node.js hosting, free tiers available
2. Use a process manager like `pm2`: `pm2 start server.js --name wc-dashboard`
3. Set up HTTPS (required for Slack slash commands)
4. For tunneling during development: `npx ngrok http 3000`

---

## Tech Stack

- **Backend:** Node.js + Express
- **Database:** SQLite (via better-sqlite3) — zero config, single file
- **Frontend:** Vanilla HTML/CSS/JS — no build step needed
- **Slack:** @slack/bolt for bot framework
- **Scheduling:** node-cron for automated reminders
