# Running Super Agent as an Always-On Linux Server

VS Code Remote SSH runs Super Agent inside the remote extension host, whose lifetime depends on VS Code. To keep Super Agent running after your Windows machine and SSH session disconnect, run the standalone headless server (`dist/server.cjs`) as a `systemd --user` service with lingering enabled. It polls Telegram, so no inbound web port is needed.

## 1. Prerequisites

1. **Node.js 22+**, Git, and at least one agent CLI (`codex`, `claude`, or `agy`) installed on the Linux x64 server. Run as your regular user. Chrome/Chromium or a Playwright browser is needed for agent browsing; microphone dictation is not supported on the Linux server.
2. **Accounts signed in once**: Connect to the Linux server with VS Code Remote SSH and sign in to your agent accounts in the Super Agent panel. This saves your account configuration and isolated CLI profiles under `~/.super-agent/` (`accounts.json` and `accounts/`), which the headless server reuses automatically.
3. **Build the bundle** on the server (or deploy `dist/server.cjs`):
   ```bash
   npm ci
   npm run build
   ```

## 2. Configure the Telegram Token (Private Permissions)

Create a separate Telegram bot with `@BotFather` (`/newbot`) to get a bot token. Do not reuse a token actively polled by your VS Code relay or another server. Store it in a private environment file readable only by your user:

```bash
mkdir -p ~/.config/super-agent
chmod 700 ~/.config/super-agent
umask 077
cat <<'EOF' > ~/.config/super-agent/server.env
SUPER_AGENT_TELEGRAM_TOKEN=123456789:AAH_your_bot_token_here
EOF
chmod 700 ~/.config/super-agent
chmod 600 ~/.config/super-agent/server.env
```

> **Note:** The server reads `SUPER_AGENT_TELEGRAM_TOKEN` from the environment and never logs it.

## 3. Test Manually & Pair Your Phone

Run the server directly first to verify your accounts, workspace, and Telegram pairing:

```bash
set -a && source ~/.config/super-agent/server.env && set +a
node dist/server.cjs --workspace /abs/project
```

- The daemon keeps its own pairing under `~/.super-agent/server/telegram.json`. It does not reuse VS Code's pairing or conversation history.
- The startup log prints a `https://t.me/<bot>?start=<code>` link. Open it on your phone and tap **Start** to pair, or send `/pair CODE` to the bot. Keep the link and logs private.
- Send requests normally. `/team` changes the lead, members and models; `/files` browses the workspace; `/threads` switches conversations; `/stop` stops current work. Approval requests appear with buttons in the paired chat. Your configured autonomy level stays unchanged.

Press `Ctrl+C` (`SIGINT`) to stop the test run cleanly.

## 4. Install as an Always-On `systemd --user` Service

Copy the provided unit template and edit `WorkingDirectory`, `ExecStart` (`--workspace /abs/project` and the path to `dist/server.cjs`), and `PATH`. Use `command -v node` to find the absolute Node executable path; include nvm/npm global binary directories in `PATH` if your CLIs use them. Stop the foreground server before starting the service.

```bash
mkdir -p ~/.config/systemd/user
cp deploy/super-agent.service ~/.config/systemd/user/super-agent.service
$EDITOR ~/.config/systemd/user/super-agent.service
```

Enable and start the service, then enable user lingering so `systemd` keeps your user services running after you log out of SSH and across reboots:

```bash
systemctl --user daemon-reload
systemctl --user enable --now super-agent.service
sudo loginctl enable-linger "$USER"
```

## 5. Managing & Monitoring

- **Check status:** `systemctl --user status super-agent.service`
- **Live logs:** `journalctl --user -u super-agent.service -f`
- **File logs:** `~/.super-agent/server/logs/super-agent-YYYY-MM-DD.log`
- **Restart after updating:** `systemctl --user restart super-agent.service`

## 6. Coexistence with VS Code Remote SSH

- The headless server stores its own engine threads, snapshots, and `server.lock` under `~/.super-agent/server/` so it does not corrupt VS Code's thread state, and it will not kill processes started by an active VS Code session.
- Only one `super-agent` daemon instance can hold `server.lock` at a time.
- Stop all running work in the VS Code team before starting the daemon. They share account settings and project hand-off directories; do not run both teams against the same workspace simultaneously. This initial server mode does not attach the VS Code panel to the running daemon.
- Set `SUPER_AGENT_HOME` to the same absolute configuration directory used by the extension if using a custom account home. Accounts must refer to Linux paths; Windows logins are separate.
- SIGTERM and Ctrl+C stop polling, cancel agent processes, save conversations, and release the lock. Systemd cleans up the service control group after a crash. Interrupted work remains in its conversation: send `continue` after restarting. The server does not blindly rerun interrupted prompts.
- User lingering may require administrator access on your server. Stop the daemon with `systemctl --user stop super-agent.service` before switching back to the VS Code team.
