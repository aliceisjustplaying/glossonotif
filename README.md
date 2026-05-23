# Glossonotif

Web Push notifications for Glosso.

Glossonotif logs into `glosso.ink`, polls `/notifications`, dedupes notification rows, and sends new items to subscribed browsers. Push clicks open the Glosso post/comment URL when one is present.

## Features

- Polls Glosso notifications on a fixed interval.
- Sends Web Push notifications with VAPID.
- Stores browser subscriptions locally.
- Uses a small web UI for login, subscription, test push, and manual polling.
- Shows install instructions in regular browsers, then enables push controls inside the installed PWA.

## Hosted Instance

The live `glosson.mosphere.at` instance is private and locked to the Glosso user `alice`. Other users should self-host their own instance.

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env`:

```sh
GLOSSO_USER=alice
GLOSSO_PASS=...
ALLOWED_GLOSSO_USER=alice
GATEWAY_TOKEN=...
WEB_PUSH_SUBJECT=mailto:you@example.com
```

Run it:

```sh
npm start
```

Open `http://localhost:3099/`, log in with the Glosso credentials, then click `Enable push`.

## HTTPS

Web Push requires a secure origin, except on `localhost`. For phone use, run Glossonotif behind HTTPS, for example with Caddy:

```caddyfile
glosson.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3099
}
```

## Systemd

Example service:

```ini
[Unit]
Description=Glosso push notification gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=agent
WorkingDirectory=/home/agent/glossonotif
EnvironmentFile=/home/agent/glossonotif/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=10s

[Install]
WantedBy=multi-user.target
```

## Runtime Data

Runtime files are written under `data/`:

- `vapid.json`: generated VAPID key pair
- `state.json`: seen notification IDs, browser subscriptions, latest launch target

These are intentionally ignored by git.

## Checks

```sh
npm run check
node --check public/main.js
node --check public/sw.js
```
