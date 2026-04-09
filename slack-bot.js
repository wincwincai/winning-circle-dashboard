/**
 * Slack Bot Integration for Winning Circle Dashboard
 *
 * Features:
 * - Daily standup reminders (configurable time via CRON)
 * - Interactive task status updates via Slack
 * - DM the bot to manage tasks conversationally
 * - Team members can view, update, and create tasks from Slack
 * - Daily summary posts to a channel
 */

const { App, ExpressReceiver } = require('@slack/bolt');
const cron = require('node-cron');

function initSlackBot(expressApp, db) {
  const receiver = new ExpressReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    endpoints: '/slack/events',
    app: expressApp
  });

  const slackApp = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver,
  });

  const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '';
  const REMINDER_CRON = process.env.REMINDER_CRON || '0 9 * * 1-5';

  // ─────────── DM Handler — Natural task management ───────────
  slackApp.message(async ({ message, say }) => {
    // Only handle DMs (im channel type)
    if (message.channel_type !== 'im' || message.bot_id) return;

    const member = await db.get('SELECT * FROM members WHERE slack_id = ?', [message.user]);
    if (!member) {
      await say(`Hi! You're not linked to the dashboard yet. Ask your admin to add your Slack ID: \`${message.user}\``);
      return;
    }

    const text = (message.text || '').trim().toLowerCase();

    // ── "my tasks" / "tasks" / "show tasks" ──
    if (text.match(/^(my\s+)?tasks$|^show\s+(my\s+)?tasks$|^what.*(do|doing|work)/)) {
      const tasks = await db.all(
        `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        [member.id]
      );
      if (!tasks.length) {
        await say("You have no active tasks. Send me a task name to create one!");
        return;
      }
      const lines = tasks.map(t => {
        const emoji = { todo: ':white_circle:', in_progress: ':arrow_forward:', review: ':eyes:' }[t.status];
        return `${emoji} *${t.title}* — _${statusLabel(t.status)}_`;
      });
      await say(`*Your Active Tasks (${tasks.length}):*\n\n${lines.join('\n')}\n\n_Reply with a task number action like "1 done" or "2 in progress" to update._`);
      return;
    }

    // ── "done" / "finish" / "complete" + task reference ──
    if (text.match(/^(\d+)\s+(done|complete|finished|finish)$/)) {
      const idx = parseInt(text.match(/^(\d+)/)[1]) - 1;
      const tasks = await db.all(
        `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        [member.id]
      );
      if (idx >= 0 && idx < tasks.length) {
        const task = tasks[idx];
        await db.run('UPDATE tasks SET status = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['done', new Date().toISOString(), task.id]);
        await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [task.id, member.id, 'status_change', `Status: ${task.status} → done (via DM)`]);
        await say(`Done! Marked *${task.title}* as complete.`);
      } else {
        await say("Couldn't find that task. Send *tasks* to see your list.");
      }
      return;
    }

    // ── "<number> <status>" pattern ──
    const statusMatch = text.match(/^(\d+)\s+(todo|in\s*progress|review|working|start)/);
    if (statusMatch) {
      const idx = parseInt(statusMatch[1]) - 1;
      let newStatus = statusMatch[2].replace(/\s+/g, '_');
      if (newStatus === 'working' || newStatus === 'start') newStatus = 'in_progress';
      if (newStatus === 'in_progress' || newStatus === 'todo' || newStatus === 'review') {
        const tasks = await db.all(
          `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
           CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
          [member.id]
        );
        if (idx >= 0 && idx < tasks.length) {
          const task = tasks[idx];
          await db.run('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [newStatus, task.id]);
          await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
            [task.id, member.id, 'status_change', `Status: ${task.status} → ${newStatus} (via DM)`]);
          await say(`Moved *${task.title}* to ${statusLabel(newStatus)}.`);
        } else {
          await say("Couldn't find that task. Send *tasks* to see your list.");
        }
        return;
      }
    }

    // ── "help" ──
    if (text === 'help') {
      await say(`*How to use the Winning Circle Bot:*\n\n` +
        `Send me any of these:\n` +
        `• *tasks* — see your active tasks\n` +
        `• *1 done* — mark task #1 as done\n` +
        `• *2 in progress* — move task #2 to In Progress\n` +
        `• *3 review* — move task #3 to Review\n` +
        `• Any text — creates a new task for you\n` +
        `\nOr use slash commands: \`/tasks\`, \`/newtask\`, \`/update\``
      );
      return;
    }

    // ── Default: create a new task from the message ──
    if (text.length > 2 && text.length < 200) {
      const title = message.text.trim(); // use original casing
      const info = await db.run('INSERT INTO tasks (title, status, member_id) VALUES (?, ?, ?)',
        [title, 'todo', member.id]);
      await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
        [info.lastInsertRowid, member.id, 'created', `Task "${title}" created via DM`]);
      await say(`Created task: *${title}* (To Do)\n_Send "tasks" to see your list._`);
    }
  });

  // ─────────── /tasks — View your tasks ───────────
  slackApp.command('/tasks', async ({ command, ack, respond }) => {
    await ack();
    const member = await db.get('SELECT * FROM members WHERE slack_id = ?', [command.user_id]);
    if (!member) {
      await respond({ text: `You're not linked to the dashboard yet. Ask your admin to add your Slack ID: \`${command.user_id}\`` });
      return;
    }

    const tasks = await db.all(
      `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
       CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
      [member.id]
    );

    if (!tasks.length) {
      await respond({ text: 'You have no active tasks. Create one with `/newtask [title]`' });
      return;
    }

    const blocks = [
      { type: 'header', text: { type: 'plain_text', text: `Your Active Tasks (${tasks.length})` } },
      { type: 'divider' }
    ];

    tasks.forEach(t => {
      const statusEmoji = { todo: ':white_circle:', in_progress: ':arrow_forward:', review: ':eyes:' }[t.status] || ':white_circle:';
      const priorityEmoji = { urgent: ':red_circle:', high: ':large_orange_circle:', medium: ':large_blue_circle:', low: ':white_circle:' }[t.priority];

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${statusEmoji} *${t.title}*\n${priorityEmoji} ${t.priority} | ${statusLabel(t.status)}${t.due_date ? ` | Due: ${t.due_date}` : ''}`
        },
        accessory: {
          type: 'static_select',
          placeholder: { type: 'plain_text', text: 'Move to...' },
          action_id: `move_task_${t.id}`,
          options: [
            { text: { type: 'plain_text', text: 'To Do' }, value: `${t.id}:todo` },
            { text: { type: 'plain_text', text: 'In Progress' }, value: `${t.id}:in_progress` },
            { text: { type: 'plain_text', text: 'Review' }, value: `${t.id}:review` },
            { text: { type: 'plain_text', text: 'Done' }, value: `${t.id}:done` }
          ]
        }
      });
    });

    await respond({ blocks });
  });

  // ─────────── /newtask — Create a task ───────────
  slackApp.command('/newtask', async ({ command, ack, respond }) => {
    await ack();
    const member = await db.get('SELECT * FROM members WHERE slack_id = ?', [command.user_id]);
    if (!member) {
      await respond({ text: `You're not linked. Your Slack ID: \`${command.user_id}\`` });
      return;
    }
    const title = command.text.trim();
    if (!title) {
      await respond({ text: 'Usage: `/newtask Buy team lunch for Friday`' });
      return;
    }
    const info = await db.run('INSERT INTO tasks (title, status, member_id) VALUES (?, ?, ?)',
      [title, 'todo', member.id]);
    await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
      [info.lastInsertRowid, member.id, 'created', `Task "${title}" created via Slack`]);
    await respond({ text: `Task created: *${title}* (To Do)` });
  });

  // ─────────── /update — Daily standup form ───────────
  slackApp.command('/update', async ({ command, ack, respond }) => {
    await ack();
    const member = await db.get('SELECT * FROM members WHERE slack_id = ?', [command.user_id]);
    if (!member) {
      await respond({ text: `You're not linked. Your Slack ID: \`${command.user_id}\`` });
      return;
    }

    try {
      await slackApp.client.views.open({
        trigger_id: command.trigger_id,
        view: {
          type: 'modal',
          callback_id: 'daily_update_modal',
          title: { type: 'plain_text', text: 'Daily Update' },
          submit: { type: 'plain_text', text: 'Submit' },
          blocks: [
            {
              type: 'input', block_id: 'done_block',
              element: { type: 'plain_text_input', action_id: 'done_input', multiline: true, placeholder: { type: 'plain_text', text: 'What did you finish today?' } },
              label: { type: 'plain_text', text: 'Done' }, optional: true
            },
            {
              type: 'input', block_id: 'working_block',
              element: { type: 'plain_text_input', action_id: 'working_input', multiline: true, placeholder: { type: 'plain_text', text: 'What are you working on?' } },
              label: { type: 'plain_text', text: 'Working On' }, optional: true
            },
            {
              type: 'input', block_id: 'blockers_block',
              element: { type: 'plain_text_input', action_id: 'blockers_input', multiline: true, placeholder: { type: 'plain_text', text: 'Any blockers?' } },
              label: { type: 'plain_text', text: 'Blockers' }, optional: true
            }
          ]
        }
      });
    } catch (e) {
      await respond({ text: 'Could not open update form. Try again.' });
    }
  });

  // ─────────── Handle task move dropdown ───────────
  slackApp.action(/^move_task_/, async ({ action, ack, respond }) => {
    await ack();
    const [taskId, newStatus] = action.selected_option.value.split(':');
    const task = await db.get('SELECT * FROM tasks WHERE id = ?', [parseInt(taskId)]);
    if (!task) return;

    const completedAt = newStatus === 'done' ? new Date().toISOString() : null;
    await db.run('UPDATE tasks SET status = ?, completed_at = COALESCE(?, completed_at), updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, completedAt, parseInt(taskId)]);
    await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
      [parseInt(taskId), task.member_id, 'status_change', `Status: ${task.status} → ${newStatus} (via Slack)`]);
    await respond({ text: `Moved *${task.title}* to ${statusLabel(newStatus)}`, replace_original: false });
  });

  // ─────────── Handle daily update modal ───────────
  slackApp.view('daily_update_modal', async ({ ack, body, view }) => {
    await ack();
    const userId = body.user.id;
    const member = await db.get('SELECT * FROM members WHERE slack_id = ?', [userId]);
    if (!member) return;

    const vals = view.state.values;
    const done = vals.done_block?.done_input?.value || '';
    const working = vals.working_block?.working_input?.value || '';
    const blockers = vals.blockers_block?.blockers_input?.value || '';
    const date = new Date().toISOString().split('T')[0];

    await db.run(`INSERT OR REPLACE INTO daily_updates (member_id, date, done_summary, working_on_summary, blockers)
      VALUES (?, ?, ?, ?, ?)`, [member.id, date, done, working, blockers]);

    try {
      await slackApp.client.chat.postMessage({
        channel: userId,
        text: `Your daily update has been saved!`
      });
    } catch (e) { /* ignore DM errors */ }
  });

  // ─────────── Scheduled Reminders ───────────
  if (CHANNEL_ID) {
    cron.schedule(REMINDER_CRON, async () => {
      try {
        const membersList = await db.all('SELECT * FROM members WHERE slack_id IS NOT NULL');
        const mentions = membersList.map(m => `<@${m.slack_id}>`).join(' ');
        await slackApp.client.chat.postMessage({
          channel: CHANNEL_ID,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: 'Daily Standup Reminder' } },
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `Hey team! ${mentions}\n\nTime to share your daily update:\n` +
                  `• DM me directly to manage tasks\n` +
                  `• Use \`/update\` to submit your standup\n` +
                  `• Use \`/tasks\` to view and update statuses`
              }
            }
          ]
        });
      } catch (e) {
        console.error('Failed to send reminder:', e.message);
      }
    });

    cron.schedule('0 17 * * 1-5', async () => {
      try {
        const today = new Date().toISOString().split('T')[0];
        const completed = await db.all(
          "SELECT t.title, m.name FROM tasks t JOIN members m ON t.member_id = m.id WHERE t.completed_at >= ?", [today]);
        const inProgress = await db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'");
        const updates = await db.get('SELECT COUNT(*) as count FROM daily_updates WHERE date = ?', [today]);
        const totalMembers = await db.get('SELECT COUNT(*) as count FROM members');

        let summary = `*Daily Summary — ${today}*\n\n`;
        summary += `Tasks completed: *${completed.length}*\n`;
        summary += `In progress: *${inProgress?.count || 0}*\n`;
        summary += `Updates submitted: *${updates?.count || 0}/${totalMembers?.count || 0}*\n`;
        if (completed.length > 0) {
          summary += '\n*Completed:*\n';
          completed.forEach(c => { summary += `• ${c.title} (${c.name})\n`; });
        }
        await slackApp.client.chat.postMessage({ channel: CHANNEL_ID, text: summary });
      } catch (e) {
        console.error('Failed to send summary:', e.message);
      }
    });
  }

  function statusLabel(s) {
    return { todo: 'To Do', in_progress: 'In Progress', review: 'Review', done: 'Done' }[s] || s;
  }
}

module.exports = { initSlackBot };
