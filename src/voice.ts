import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { log } from './core/log';
import { MicRecorder } from './core/voice/recorder';
import { Whisper } from './core/voice/whisper';

/** Words Whisper should expect in a prompt here: the agents, and the workspace's own top-level names. */
function voicePrompt(cwd?: string): string {
  const words = ['Super Agent', 'Codex', 'Claude Code', 'Antigravity', 'Gemini'];
  try {
    if (cwd) words.push(...fs.readdirSync(cwd).filter((n) => !n.startsWith('.') && n !== 'node_modules').slice(0, 40));
  } catch {
    /* no folder */
  }
  return words.join(', ');
}

/**
 * The prompt box's mic button: record (in the extension host), transcribe on the local machine with Whisper, and hand the
 * text back to the panel. The first use asks once to download whisper.cpp and the model.
 */
export function createVoice(o: { dataDir: string; model: () => string; cwd: () => string | undefined; post: (m: unknown) => void }) {
  const mic = new MicRecorder();
  const whisper = new Whisper(o.dataDir, o.model);
  const state = (s: 'idle' | 'installing' | 'recording' | 'transcribing', extra: object = {}) => o.post({ type: 'voice', state: s, ...extra });

  async function install(): Promise<boolean> {
    const missing = whisper.missing();
    if (!missing.length) return true;
    const what = missing.map((m) => (m === 'program' ? 'whisper.cpp (about 10 MB)' : `the ${o.model()} speech model (about 150 MB)`)).join(' and ');
    const ok = await vscode.window.showInformationMessage(
      `Voice input turns your speech into text on your local machine with Whisper: your voice is never sent to a server. It needs a one-time download of ${what}.`,
      { modal: true },
      'Download',
    );
    if (ok !== 'Download') return false;
    state('installing');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Setting up voice input' }, (p) =>
        whisper.install((msg, f) => p.report({ message: f === undefined ? msg : `${msg} ${Math.round(f * 100)}%` })),
      );
    } catch (err) {
      log('voice', `install failed: ${(err as Error).message}`);
      void vscode.window.showErrorMessage(`Couldn't set up voice input: ${(err as Error).message}`);
      return false;
    } finally {
      state('idle');
    }
    void vscode.window.showInformationMessage('Voice input is ready: click the mic and talk.');
    return false; // set up now; the next click records (no surprise recording after a long download)
  }

  async function start(): Promise<void> {
    if (mic.recording) return;
    if (!(await install())) return;
    try {
      mic.start(
        (level) => state('recording', { level, startedAt: mic.startedAt }),
        () => void stop(),
      );
      state('recording', { level: 0, startedAt: mic.startedAt });
    } catch (err) {
      log('voice', `mic failed: ${(err as Error).message}`);
      state('idle');
      void vscode.window.showErrorMessage(`Couldn't use the microphone: ${(err as Error).message}`);
    }
  }

  /** `cancel`: drop the recording. */
  async function stop(cancel = false): Promise<void> {
    if (!mic.recording) return;
    const file = path.join(os.tmpdir(), `super-agent-voice-${Date.now()}.wav`);
    if (!(await mic.stop(cancel ? undefined : file))) return state('idle');
    state('transcribing');
    const t0 = Date.now();
    try {
      const text = await whisper.transcribe(file, voicePrompt(o.cwd()));
      log('voice', `transcribed in ${Date.now() - t0} ms (${text.length} chars)`);
      o.post({ type: 'voiceText', text });
    } catch (err) {
      void vscode.window.showErrorMessage(`Couldn't transcribe: ${(err as Error).message}`);
    } finally {
      fs.rmSync(file, { force: true });
      state('idle');
    }
  }

  return { start, stop, dispose: () => void mic.stop() };
}
