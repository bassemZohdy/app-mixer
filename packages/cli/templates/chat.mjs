
const form = document.getElementById('chat-form'),
  input = document.getElementById('chat-input'),
  button = document.getElementById('chat-send'),
  status = document.getElementById('chat-status'),
  log = document.getElementById('chat-log');
const threadId = crypto.randomUUID(),
  history = [];
function line(role, text) {
  const item = document.createElement('p');
  item.textContent = role + ': ' + text;
  log.appendChild(item);
  return item;
}
try {
  const response = await fetch('/api/chat/status');
  const state = await response.json();
  if (state.enabled) {
    input.disabled = false;
    button.disabled = false;
    status.textContent = 'Ready';
  } else status.textContent = 'Agent is not configured.';
} catch {
  status.textContent = 'Agent is unavailable.';
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = input.value.trim();
  if (!value || button.disabled) return;
  input.value = '';
  input.disabled = true;
  button.disabled = true;
  status.textContent = 'Thinking…';
  const user = { id: crypto.randomUUID(), role: 'user', content: value };
  history.push(user);
  const sent = line('You', value);
  let assistant = '',
    complete = false,
    entry,
    started = false;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, runId: crypto.randomUUID(), messages: history, tools: [], context: [], state: {} }),
    });
    if (!response.ok || !response.body) throw Error('Agent unavailable');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value: chunk, done } = await reader.read();
      buffer += decoder.decode(chunk || new Uint8Array(), { stream: !done });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((x) => x.startsWith('data: '))
          .map((x) => x.slice(6))
          .join('\n');
        if (!data) continue;
        const message = JSON.parse(data);
        started = true;
        if (message.type === 'TEXT_MESSAGE_CONTENT') {
          assistant += message.delta;
          if (!entry) entry = line('Agent', '');
          entry.textContent = 'Agent: ' + assistant;
        }
        if (message.type === 'RUN_ERROR') throw Error('Agent could not complete the request');
        if (message.type === 'RUN_FINISHED') complete = true;
      }
      if (done) break;
    }
    if (!complete) throw Error('Agent stream ended unexpectedly');
    history.push({ id: crypto.randomUUID(), role: 'assistant', content: assistant });
    status.textContent = 'Ready';
  } catch (error) {
    history.pop();
    if (!started) {
      input.value = value;
      sent.textContent = 'You: ' + value + ' (not sent)';
    }
    if (entry) entry.textContent += ' (incomplete)';
    status.textContent = error.message || 'Agent unavailable';
  } finally {
    input.disabled = false;
    button.disabled = false;
    input.focus();
  }
});
