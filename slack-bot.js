/**
 * Slack Bot Integration for Winning Circle Dashboard
 *
 * AI-powered task management agent using Groq (Llama).
 * Team members DM the bot naturally and the LLM handles everything
 * via tool use — creating, updating, listing, and managing tasks.
 */

const { App, ExpressReceiver } = require('@slack/bolt');
const GroqModule = require('groq-sdk');
const Groq = GroqModule.default || GroqModule;
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

  // ─────────── Groq AI Agent ───────────
  const groq = process.env.GROQ_API_KEY
    ? new Groq({ apiKey: process.env.GROQ_API_KEY })
    : null;

  const TOOLS = [
    {
      type: 'function',
      function: {
        name: 'list_tasks',
        description: 'List tasks for the current user. Returns active tasks by default, or filter by status.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done', 'all'], description: 'Filter by status. "all" returns everything including done.' },
            include_done: { type: 'boolean', description: 'Whether to include completed tasks. Default false.' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'create_task',
        description: 'Create a new task for the current user.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The task title' },
            description: { type: 'string', description: 'Optional task description' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Task priority. Default medium.' },
            due_date: { type: 'string', description: 'Optional due date in YYYY-MM-DD format' }
          },
          required: ['title']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'update_task',
        description: "Update a task's status, priority, title, description, or due date.",
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'integer', description: 'The task ID to update' },
            status: { type: 'string', enum: ['todo', 'in_progress', 'review', 'done'] },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
            title: { type: 'string', description: 'New title' },
            description: { type: 'string', description: 'New description' },
            due_date: { type: 'string', description: 'New due date (YYYY-MM-DD)' }
          },
          required: ['task_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'delete_task',
        description: 'Delete a task permanently.',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'integer', description: 'The task ID to delete' }
          },
          required: ['task_id']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_team_stats',
        description: 'Get dashboard statistics — tasks by status, tasks by member, and recent activity.',
        parameters: { type: 'object', properties: {} }
      }
    },
    {
      type: 'function',
      function: {
        name: 'submit_daily_update',
        description: 'Submit a daily standup update for the current user.',
        parameters: {
          type: 'object',
          properties: {
            done_summary: { type: 'string', description: 'What was completed' },
            working_on_summary: { type: 'string', description: 'What is being worked on' },
            blockers: { type: 'string', description: 'Any blockers' }
          }
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'list_team_members',
        description: 'List all team members with their IDs and task counts.',
        parameters: { type: 'object', properties: {} }
      }
    }
  ];

  // ── Tool execution ──
  async function executeTool(name, input, member) {
    switch (name) {
      case 'list_tasks': {
        // Enforce: can only list your own tasks
        let sql = `SELECT t.*, m.name as member_name FROM tasks t
                    LEFT JOIN members m ON t.member_id = m.id
                    WHERE t.member_id = ?`;
        const params = [member.id];
        if (input.status && input.status !== 'all') {
          sql += ' AND t.status = ?';
          params.push(input.status);
        } else if (!input.include_done && input.status !== 'all') {
          sql += " AND t.status != 'done'";
        }
        sql += ` ORDER BY CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.updated_at DESC`;
        const tasks = await db.all(sql, params);
        return JSON.stringify(tasks);
      }

      case 'create_task': {
        // Enforce: always assign to current user
        const info = await db.run(
          'INSERT INTO tasks (title, description, status, priority, member_id, due_date) VALUES (?, ?, ?, ?, ?, ?)',
          [input.title, input.description || '', 'todo', input.priority || 'medium', member.id, input.due_date || null]
        );
        await db.run(
          'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [info.lastInsertRowid, member.id, 'created', `Task "${input.title}" created via Slack agent`]
        );
        const task = await db.get('SELECT * FROM tasks WHERE id = ?', [info.lastInsertRowid]);
        return JSON.stringify(task);
      }

      case 'update_task': {
        const existing = await db.get('SELECT * FROM tasks WHERE id = ?', [input.task_id]);
        if (!existing) return JSON.stringify({ error: 'Task not found' });
        if (existing.member_id !== member.id) return JSON.stringify({ error: 'You can only update your own tasks.' });

        const newStatus = input.status || existing.status;
        const completedAt = newStatus === 'done' && existing.status !== 'done'
          ? new Date().toISOString() : existing.completed_at;

        await db.run(`UPDATE tasks SET
          title = COALESCE(?, title),
          description = COALESCE(?, description),
          status = COALESCE(?, status),
          priority = COALESCE(?, priority),
          due_date = COALESCE(?, due_date),
          completed_at = ?,
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
          [input.title || null, input.description || null, input.status || null,
           input.priority || null, input.due_date || null, completedAt, input.task_id]
        );

        if (input.status && input.status !== existing.status) {
          await db.run(
            'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
            [input.task_id, existing.member_id, 'status_change',
             `Status: ${existing.status} → ${input.status} (via Slack agent)`]
          );
        }

        const updated = await db.get('SELECT * FROM tasks WHERE id = ?', [input.task_id]);
        return JSON.stringify(updated);
      }

      case 'delete_task': {
        const task = await db.get('SELECT * FROM tasks WHERE id = ?', [input.task_id]);
        if (!task) return JSON.stringify({ error: 'Task not found' });
        if (task.member_id !== member.id) return JSON.stringify({ error: 'You can only delete your own tasks.' });
        await db.run('DELETE FROM tasks WHERE id = ?', [input.task_id]);
        await db.run(
          'INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [input.task_id, task.member_id, 'deleted', `Task "${task.title}" deleted via Slack agent`]
        );
        return JSON.stringify({ success: true, deleted: task.title });
      }

      case 'get_team_stats': {
        const byStatus = await db.all('SELECT status, COUNT(*) as count FROM tasks GROUP BY status');
        const byMember = await db.all(`
          SELECT m.name, COUNT(t.id) as total,
            SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) as done,
            SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END) as active
          FROM members m LEFT JOIN tasks t ON m.id = t.member_id
          GROUP BY m.id ORDER BY m.name`);
        const completedToday = await db.get(
          "SELECT COUNT(*) as count FROM tasks WHERE completed_at >= date('now')");
        return JSON.stringify({ byStatus, byMember, completedToday: completedToday?.count || 0 });
      }

      case 'submit_daily_update': {
        const date = new Date().toISOString().split('T')[0];
        // Enforce: can only submit your own daily update
        await db.run(`INSERT OR REPLACE INTO daily_updates (member_id, date, done_summary, working_on_summary, blockers)
          VALUES (?, ?, ?, ?, ?)`,
          [member.id, date, input.done_summary || '', input.working_on_summary || '', input.blockers || '']);
        return JSON.stringify({ success: true, date });
      }

      case 'list_team_members': {
        const members = await db.all(`
          SELECT m.*, COUNT(t.id) as task_count,
            SUM(CASE WHEN t.status != 'done' THEN 1 ELSE 0 END) as active_tasks
          FROM members m LEFT JOIN tasks t ON m.id = t.member_id
          GROUP BY m.id ORDER BY m.name`);
        return JSON.stringify(members);
      }

      default:
        return JSON.stringify({ error: 'Unknown tool' });
    }
  }

  // ── Run Groq agent loop (call tools until done) ──
  async function runAgent(userMessage, member) {
    const today = new Date().toISOString().split('T')[0];

    const systemPrompt = `You are the Winning Circle task management bot on Slack. You MUST use the provided tools to help users manage tasks. NEVER respond with just text when a tool call would be appropriate.

Current user: ${member.name} (member_id: ${member.id})
Today's date: ${today}

CRITICAL INSTRUCTIONS — follow these strictly:
1. When the user mentions ANYTHING about tasks, you MUST call a tool. Do NOT just reply with text.
2. "show tasks", "my tasks", "list tasks", "what am I working on" → call list_tasks
3. "create X", "new task X", "add X", or any text that looks like a task to create → call create_task with the title
4. "X is done", "finished X", "complete X", "mark X as done" → FIRST call list_tasks to find the task, THEN call update_task with status "done"
5. "X in progress", "working on X", "start X", "move X to in progress" → FIRST call list_tasks to find the task, THEN call update_task with status "in_progress"
6. "X in review", "review X" → FIRST call list_tasks, THEN call update_task with status "review"
7. "delete X", "remove X" → FIRST call list_tasks to find the task ID, THEN call delete_task
8. "stats", "team stats", "how's the team" → call get_team_stats
9. "standup", "daily update" → call submit_daily_update

When matching task names: the user might use partial names. Call list_tasks first, find the closest match by title, then use that task's ID for update/delete.

Formatting:
- Be concise — this is Slack. 1-3 sentences max.
- Use Slack formatting: *bold*, _italic_
- Always confirm what you did after taking an action.

IMPORTANT ownership rules:
- Users can ONLY manage their own tasks.
- They can VIEW team stats but cannot modify other people's tasks.`;

    let messages = [{ role: 'user', content: userMessage }];

    // Agent loop — keep calling tools until LLM gives a final text response
    for (let i = 0; i < 5; i++) {
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0,
        max_tokens: 1024,
      });

      const choice = response.choices?.[0];
      if (!choice) return "Something went wrong — try again.";

      const msg = choice.message;
      messages.push(msg);

      // If no tool calls, return the text
      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        return msg.content || 'Done!';
      }

      // Execute each tool call and add results
      for (const toolCall of msg.tool_calls) {
        const args = JSON.parse(toolCall.function.arguments || '{}') || {};
        const result = await executeTool(toolCall.function.name, args, member);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result,
        });
      }
    }

    return "I got a bit stuck — try rephrasing your request.";
  }

  // ─────────── DM Handler — AI-powered task management ───────────
  slackApp.message(async ({ message, say }) => {
    if (message.channel_type !== 'im' || message.bot_id) return;

    let member = await db.get('SELECT * FROM members WHERE slack_id = ?', [message.user]);

    // Auto-link: if no member found by slack_id, try matching by Slack display name
    if (!member) {
      try {
        const userInfo = await slackApp.client.users.info({ user: message.user });
        const slackName = userInfo.user?.real_name || userInfo.user?.profile?.display_name || '';
        if (slackName) {
          // Try case-insensitive match against existing members
          const allMembers = await db.all('SELECT * FROM members');
          member = allMembers.find(m =>
            m.name.localeCompare(slackName, undefined, { sensitivity: 'accent' }) === 0 ||
            m.name.localeCompare(slackName.split(' ')[0], undefined, { sensitivity: 'accent' }) === 0
          );
          if (member) {
            // Link this Slack ID to the matched member
            await db.run('UPDATE members SET slack_id = ? WHERE id = ?', [message.user, member.id]);
            await say(`Linked you to *${member.name}* on the dashboard. You're all set!`);
          }
        }
      } catch (e) {
        console.error('Auto-link error:', e.message);
      }

      if (!member) {
        await say(`Hi! I couldn't match your Slack profile to a dashboard member.\nYour Slack ID: \`${message.user}\`\n\nEither log in to the dashboard first (your name must match), or ask an admin to link your Slack ID.`);
        return;
      }
    }

    const text = (message.text || '').trim();
    if (!text || text.length > 2000) return;

    // If Groq is not configured, fall back to simple regex handling
    if (!groq) {
      await handleLegacyMessage(text, member, say);
      return;
    }

    try {
      const response = await runAgent(text, member);
      await say(response);
    } catch (e) {
      console.error('Agent error:', e.message, e.stack);
      // Retry once after a short delay (handles rate limits)
      try {
        await new Promise(r => setTimeout(r, 1500));
        const response = await runAgent(text, member);
        await say(response);
      } catch (e2) {
        console.error('Agent retry failed:', e2.message);
        await say(`_AI is temporarily unavailable — using basic mode._`);
        await handleLegacyMessage(text, member, say);
      }
    }
  });

  // ── Legacy regex handler (fallback when no API key or Groq fails) ──
  async function handleLegacyMessage(text, member, say) {
    const lower = text.toLowerCase().trim();

    // ── List tasks ──
    if (lower.match(/^(my\s+)?tasks$|^show\s+(my\s+)?tasks$|^what.*(do|doing|work)/)) {
      const tasks = await db.all(
        `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        [member.id]
      );
      if (!tasks.length) {
        await say("You have no active tasks. Send me `create <task name>` to add one!");
        return;
      }
      const lines = tasks.map((t, i) => {
        const emoji = { todo: ':white_circle:', in_progress: ':arrow_forward:', review: ':eyes:' }[t.status] || ':white_circle:';
        return `${emoji} *${i + 1}. ${t.title}* — _${statusLabel(t.status)}_`;
      });
      await say(`*Your Active Tasks (${tasks.length}):*\n\n${lines.join('\n')}\n\n_Say "task name is done", "1 done", or "start task name" to update._`);
      return;
    }

    // ── Helper: find task by numbered index or fuzzy name match ──
    async function findTask(query) {
      const tasks = await db.all(
        `SELECT * FROM tasks WHERE member_id = ? AND status != 'done' ORDER BY
         CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
        [member.id]
      );
      // numbered: "1", "2", ...
      const numMatch = query.match(/^(\d+)$/);
      if (numMatch) {
        const idx = parseInt(numMatch[1]) - 1;
        return idx >= 0 && idx < tasks.length ? tasks[idx] : null;
      }
      // exact title match (case-insensitive)
      const q = query.toLowerCase();
      return tasks.find(t => t.title.toLowerCase() === q) ||
             tasks.find(t => t.title.toLowerCase().includes(q)) ||
             null;
    }

    // ── Mark done: "X is done", "X done", "finished X", "complete X", "1 done" ──
    const doneMatch = lower.match(/^(.+?)\s+(?:is\s+)?(?:done|complete|finished|finish)$/) ||
                      lower.match(/^(?:done|complete|finished|finish)\s+(.+)$/) ||
                      lower.match(/^(\d+)\s+(?:done|complete|finished|finish)$/);
    if (doneMatch) {
      const query = doneMatch[1].trim();
      const task = await findTask(query);
      if (task) {
        await db.run('UPDATE tasks SET status = ?, completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          ['done', new Date().toISOString(), task.id]);
        await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [task.id, member.id, 'status_change', `Status: ${task.status} → done (via DM)`]);
        await say(`:white_check_mark: Marked *${task.title}* as done!`);
      } else {
        await say(`Couldn't find a task matching "${query}". Send *tasks* to see your list.`);
      }
      return;
    }

    // ── Move to In Progress: "start X", "X in progress", "working on X", "2 in progress" ──
    const progressMatch = lower.match(/^(?:start|working on|begin)\s+(.+)$/) ||
                          lower.match(/^(.+?)\s+in\s+progress$/) ||
                          lower.match(/^(\d+)\s+(?:in\s+progress|start|working)/);
    if (progressMatch) {
      const query = (progressMatch[1] || '').trim();
      const task = await findTask(query);
      if (task) {
        await db.run('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['in_progress', task.id]);
        await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [task.id, member.id, 'status_change', `Status: ${task.status} → in_progress (via DM)`]);
        await say(`:arrow_forward: Moved *${task.title}* to In Progress!`);
      } else {
        await say(`Couldn't find a task matching "${query}". Send *tasks* to see your list.`);
      }
      return;
    }

    // ── Move to Review: "review X", "X in review" ──
    const reviewMatch = lower.match(/^(?:review)\s+(.+)$/) ||
                        lower.match(/^(.+?)\s+(?:in\s+)?review$/) ||
                        lower.match(/^(\d+)\s+review/);
    if (reviewMatch) {
      const query = (reviewMatch[1] || '').trim();
      const task = await findTask(query);
      if (task) {
        await db.run('UPDATE tasks SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['review', task.id]);
        await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
          [task.id, member.id, 'status_change', `Status: ${task.status} → review (via DM)`]);
        await say(`:eyes: Moved *${task.title}* to Review!`);
      } else {
        await say(`Couldn't find a task matching "${query}". Send *tasks* to see your list.`);
      }
      return;
    }

    // ── Help ──
    if (lower === 'help') {
      await say(
        `*Winning Circle Bot commands:*\n\n` +
        `• *tasks* — see your active tasks\n` +
        `• *task name is done* — mark a task done by name\n` +
        `• *1 done* — mark task #1 done by number\n` +
        `• *start task name* — move to In Progress\n` +
        `• *review task name* — move to Review\n` +
        `• *create <task name>* — create a new task\n` +
        `\nSlash commands: \`/tasks\`, \`/newtask\`, \`/update\``
      );
      return;
    }

    // ── Create task explicitly ──
    const createMatch = lower.match(/^(?:create|new|add)\s+(?:a\s+)?(?:task\s+)?(.+)/);
    if (createMatch && createMatch[1].length > 1 && createMatch[1].length < 200) {
      const title = text.replace(/^(?:create|new|add)\s+(?:a\s+)?(?:task\s+)?/i, '').trim();
      const info = await db.run('INSERT INTO tasks (title, status, member_id) VALUES (?, ?, ?)',
        [title, 'todo', member.id]);
      await db.run('INSERT INTO activity_log (task_id, member_id, action, details) VALUES (?, ?, ?, ?)',
        [info.lastInsertRowid, member.id, 'created', `Task "${title}" created via DM`]);
      await say(`:white_circle: Created task: *${title}*\n_Send *tasks* to see your list._`);
      return;
    }

    await say(
      `I didn't understand that. Try:\n` +
      `• *tasks* — see your task list\n` +
      `• *task name is done* — mark a task as done\n` +
      `• *1 done* — mark task #1 as done\n` +
      `• *create <task name>* — create a new task\n` +
      `• *help* — see all commands`
    );
  }

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
        const today = new Date().toISOString().split('T')[0];

        for (const member of membersList) {
          try {
            const tasks = await db.all(
              `SELECT * FROM tasks WHERE member_id = ? AND status != 'done'
               ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
              [member.id]
            );

            const overdue = tasks.filter(t => t.due_date && t.due_date < today);
            const statusEmoji = { todo: ':white_circle:', in_progress: ':arrow_forward:', review: ':eyes:' };
            const priorityEmoji = { urgent: ':red_circle:', high: ':large_orange_circle:', medium: ':large_blue_circle:', low: ':white_circle:' };

            const blocks = [
              { type: 'header', text: { type: 'plain_text', text: `Good morning, ${member.name}!` } },
            ];

            if (!tasks.length) {
              blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: "You have no active tasks today. Just DM me to create one!" }
              });
            } else {
              if (overdue.length > 0) {
                blocks.push({
                  type: 'section',
                  text: { type: 'mrkdwn', text: `:warning: *${overdue.length} overdue task${overdue.length > 1 ? 's' : ''}:*` }
                });
                overdue.forEach(t => {
                  blocks.push({
                    type: 'section',
                    text: { type: 'mrkdwn', text: `:warning: *${t.title}* — Due: ~${t.due_date}~ _overdue_` }
                  });
                });
                blocks.push({ type: 'divider' });
              }

              const activeTasks = tasks.filter(t => !overdue.includes(t));
              if (activeTasks.length > 0) {
                blocks.push({
                  type: 'section',
                  text: { type: 'mrkdwn', text: `*Your tasks (${activeTasks.length}):*` }
                });
                activeTasks.forEach(t => {
                  const due = t.due_date ? ` | Due: ${t.due_date}` : '';
                  blocks.push({
                    type: 'section',
                    text: {
                      type: 'mrkdwn',
                      text: `${statusEmoji[t.status] || ':white_circle:'} *${t.title}*\n${priorityEmoji[t.priority] || ''} ${t.priority} | ${statusLabel(t.status)}${due}`
                    }
                  });
                });
              }

              blocks.push({ type: 'divider' });
              blocks.push({
                type: 'section',
                text: { type: 'mrkdwn', text: `_Just tell me what you need — I understand natural language now!_` }
              });
            }

            await slackApp.client.chat.postMessage({ channel: member.slack_id, blocks });
          } catch (e) {
            console.error(`Failed to DM ${member.name}:`, e.message);
          }
        }

        const mentions = membersList.map(m => `<@${m.slack_id}>`).join(' ');
        await slackApp.client.chat.postMessage({
          channel: CHANNEL_ID,
          text: `:wave: Good morning ${mentions}! Check your DMs for your personal task reminders.`
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
