/**
 * Turns raw CLI output (Codex, Claude Code, Antigravity) into activity items, skipping prompts and command output:
 * "💬 what the agent says" · "🔧 tool target" · "▶ command" · "✏️ editing files" · "🔎 query" · "💭 thinking…".
 * Telegram's status message keeps a few short lines; the VS Code panel keeps the whole turn, with what the agent
 * says merged into full paragraphs (`merge`) so long messages read as written.
 */
export class ActivityParser {
  items: string[] = [];
  private buf = '';
  /** say: narration · skip: the echoed prompt / command output · cmd: the next line is a command. */
  private mode: 'say' | 'skip' | 'cmd' = 'say';
  /** The last item is narration still being written (merge mode appends to it). */
  private saying = false;

  constructor(
    private maxLen = 110,
    private maxItems = 6,
    private merge = false,
  ) {}

  feed(text: string): void {
    this.buf += text;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop() ?? '';
    for (const raw of lines) this.line(raw);
  }

  /** Takes the last unfinished line too (end of a run). */
  flush(): void {
    if (this.buf) this.line(this.buf);
    this.buf = '';
  }

  private line(raw: string): void {
    const line = raw.trim();
    if (!line) {
      if (this.merge && this.saying) this.items[this.items.length - 1] += '\n'; // paragraph break
      return;
    }
    // Codex block headers.
    if (line === 'user' || line === 'tokens used') return void (this.mode = 'skip');
    if (line === 'codex') return void ((this.mode = 'say'), (this.saying = false));
    if (line === 'exec') return void (this.mode = 'cmd');
    if (line === 'thinking') return this.push('💭 thinking…'), void (this.mode = 'skip');
    if (/^(apply_patch|file update)/.test(line)) return this.push('✏️ editing files'), void (this.mode = 'skip');
    const mcp = /^mcp: ([^ ]+) started/.exec(line);
    if (mcp) return this.push(`🔧 ${mcp[1]}`);
    if (/^mcp: /.test(line)) return;
    const web = /^web search:\s*(.*)$/.exec(line);
    if (web) return web[1] ? this.push(`🔎 ${web[1]}`) : undefined;
    // Claude Code / Antigravity tool actions ("→ Read file.ts").
    if (line.startsWith('→')) return this.push(`🔧 ${line.replace(/^→\s*/, '')}`), void (this.mode = 'say');
    // Banners and our own markers.
    if (/^(\$ |\[super-agent\]|OpenAI Codex|-{4,}|workdir:|model:|provider:|approval:|sandbox:|reasoning |session id:)/.test(line)) return;
    if (this.mode === 'cmd') {
      this.push(`▶ ${command(line)}`);
      this.mode = 'skip';
      return;
    }
    if (this.mode !== 'say' || /^\d[\d,]*$/.test(line)) return;
    if (!this.merge) return this.push(`💬 ${line.replace(/[*_`#>]/g, '')}`);
    // Panel: keep the agent's words (Markdown) whole, as one item per message.
    if (this.saying) {
      const i = this.items.length - 1;
      this.items[i] = clip(`${this.items[i]}\n${raw.trimEnd()}`, this.maxLen);
    } else {
      this.push(`💬 ${raw.trimEnd()}`);
      this.saying = true;
    }
  }

  private push(item: string): void {
    this.saying = false;
    const short = clip(item, this.maxLen);
    if (this.items.at(-1) === short) return;
    this.items.push(short);
    if (this.items.length > this.maxItems) this.items.shift();
  }
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Shows the command itself, not the PowerShell wrapper Codex runs it in. */
function command(line: string): string {
  const m = /powershell(?:\.exe)?"?\s+-Command\s+(.*)$/i.exec(line);
  const cmd = m ? m[1] : line;
  return cmd.replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\');
}
