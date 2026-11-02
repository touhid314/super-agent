// A stand-in for `claude -p --input-format stream-json --replay-user-messages`: echoes each message as it starts on
// it and answers it. After the first one, its "background task" (like a Monitor) wakes it up once, so it carries
// on by itself and replies again. A message containing "[queued-notice]" first gets a queued turn of its own (like
// the notice about a background command cut off by a restart), which ends before the message is even started.
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const say = (text) => out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
let n = 0;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line).message;
    const text = msg.content;
    n++;
    if (text.includes('[queued-notice]')) {
      out({ type: 'user', message: { role: 'user', content: '<task-notification>Background shell command did not finish before the previous session ended</task-notification>' } });
      say('No response requested.');
      out({ type: 'result', subtype: 'success', is_error: false, result: '' });
    }
    out({ type: 'user', message: msg, isReplay: true });
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Monitor', input: { command: 'tail -f run.log' } }] } });
    say(`Started (${text}). I'll report as events arrive.`);
    out({ type: 'result', subtype: 'success', is_error: false, result: `Started (${text}). I'll report as events arrive.` });
    if (n === 1)
      setTimeout(() => {
        out({ type: 'user', message: { role: 'user', content: '<task-notification>Monitor event: run finished</task-notification>' } });
        say('The run finished: all 5 courses downloaded.');
        out({ type: 'result', subtype: 'success', is_error: false, result: 'Done: all 5 courses downloaded.' });
      }, 300);
  }
});
