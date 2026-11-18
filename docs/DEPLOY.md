# Running Pursuit 24/7

Pursuit has two parts: the **worker** (finds, tailors, applies, reads your job mail, texts you) and the
**dashboard** (http://localhost:7020). Pick one of three places to run them. Your data moves between them
with `scripts/pack.sh`.

## 1. This Mac (what runs now)

```bash
bash scripts/launchd.sh install     # worker + dashboard + keep-awake, start at login, restart on crash
bash scripts/launchd.sh status
bash scripts/launchd.sh uninstall   # stop everything and restore normal sleep
```

It keeps applying while the Mac is **on and plugged in**. Closing the lid still puts it to sleep, and
nothing runs while it sleeps. For truly 24/7, use option 3.

After changing code: `node_modules/.bin/next build && bash scripts/launchd.sh install`.

## 2. Any other laptop (Docker)

1. Install Docker Desktop and start it.
2. Copy the `pursuit` folder over (or `git clone` your private copy).
3. On the OLD machine: `scripts/pack.sh export` → copy the `.pack.enc` file across.
4. On the NEW machine: `scripts/pack.sh import pursuit-....pack.enc`, then `scripts/setup.sh`.

Only ONE machine should run the worker at a time (two would apply to the same jobs twice). Stop the old one first.

## 3. Free cloud server (always on, even with your Mac closed)

Oracle Cloud "Always Free" gives a permanent free ARM server (4 CPU, 24 GB RAM). You sign up yourself;
it asks for a card to verify identity but the Always Free shapes are not charged.

1. Sign up at cloud.oracle.com (choose a home region near you, e.g. UK South or Germany).
2. Create a Compute instance: image **Ubuntu 24.04**, shape **VM.Standard.A1.Flex** (Ampere), 2-4 OCPU and 12-24 GB.
   Download the SSH key it offers.
3. Connect: `ssh -i key.pem ubuntu@<server-ip>`
4. Install Docker: `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker ubuntu` then log out and back in.
   (That's Docker's official installer; read it first if you like: https://get.docker.com)
5. Copy Pursuit and your pack: from the Mac, `scp -i key.pem -r ~/skill/pursuit ubuntu@<ip>:~/` (skip node_modules and .next:
   `rsync -av --exclude node_modules --exclude .next --exclude data -e "ssh -i key.pem" ~/skill/pursuit ubuntu@<ip>:~/`),
   then `scp -i key.pem pursuit-*.pack.enc ubuntu@<ip>:~/pursuit/`.
6. On the server: `cd pursuit && scripts/pack.sh import pursuit-....pack.enc && scripts/setup.sh`
7. Stop the Mac worker so they don't both apply: `bash scripts/launchd.sh uninstall` on the Mac.
8. Open the dashboard from your Mac through an SSH tunnel: `ssh -i key.pem -L 7020:localhost:7020 ubuntu@<ip>`,
   then visit http://localhost:7020. **Never open port 7020 in Oracle's firewall**: the dashboard has no login.

Telegram works from the server with no open ports, so you'll get your questions and updates on your phone.

Logs: `docker compose logs -f worker`. Update after code changes: `docker compose up -d --build`.
