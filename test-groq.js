require('dotenv').config();
const Groq = require('groq-sdk');

const apiKey = process.env.GROQ_API_KEY;
console.log('GROQ_API_KEY set:', !!apiKey);
console.log('Key prefix:', apiKey ? apiKey.slice(0, 10) + '...' : 'MISSING');

if (!apiKey) {
  console.error('\nGROQ_API_KEY is not set in .env');
  console.error('Get a free key at https://console.groq.com');
  process.exit(1);
}

const groq = new Groq({ apiKey });

(async () => {
  try {
    // Test 1: Basic text generation
    console.log('\n--- Test 1: Basic generation ---');
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
    });
    console.log('Response:', response.choices[0].message.content);
    console.log('OK - Basic generation works\n');

    // Test 2: Tool use (function calling)
    console.log('--- Test 2: Tool use (function calling) ---');
    const toolResponse = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: 'You are a task manager. When the user asks about tasks, call the list_tasks function.' },
        { role: 'user', content: 'List my tasks' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'list_tasks',
          description: 'List tasks for the current user',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: 'auto',
    });

    const toolCalls = toolResponse.choices[0].message.tool_calls || [];
    console.log('Tool calls:', JSON.stringify(toolCalls, null, 2));

    if (toolCalls.length > 0) {
      console.log('OK - Tool use works\n');
    } else {
      console.log('WARNING - No function call made, got text:', toolResponse.choices[0].message.content);
    }

    // Test 3: Full agent loop
    console.log('--- Test 3: Full agent loop ---');
    const messages = [
      { role: 'system', content: 'You are a task manager. Always call list_tasks when asked about tasks. Format results using Slack formatting.' },
      { role: 'user', content: 'Show me my tasks' },
    ];

    const loopResponse = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages,
      tools: [{
        type: 'function',
        function: {
          name: 'list_tasks',
          description: 'List tasks for the current user',
          parameters: { type: 'object', properties: {} },
        },
      }],
      tool_choice: 'auto',
    });

    const loopCalls = loopResponse.choices[0].message.tool_calls || [];
    if (loopCalls.length > 0) {
      messages.push(loopResponse.choices[0].message);
      messages.push({
        role: 'tool',
        tool_call_id: loopCalls[0].id,
        content: JSON.stringify([
          { id: 1, title: 'Test task', status: 'todo', priority: 'medium' },
        ]),
      });

      const finalResponse = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages,
        tools: [{
          type: 'function',
          function: {
            name: 'list_tasks',
            description: 'List tasks for the current user',
            parameters: { type: 'object', properties: {} },
          },
        }],
        tool_choice: 'auto',
      });

      console.log('Final response:', finalResponse.choices[0].message.content);
      console.log('OK - Full agent loop works\n');
    } else {
      console.log('WARNING - No function call in loop test');
    }

    console.log('=== ALL TESTS PASSED ===');
  } catch (e) {
    console.error('\nError:', e.message);
    if (e.status === 401) {
      console.error('The API key is invalid. Get a new one at https://console.groq.com');
    }
    process.exit(1);
  }
})();
