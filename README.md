# worker_baileys (newzelador)

A WhatsApp worker built on [Baileys](https://github.com/WhiskeySockets/Baileys), written in TypeScript.

This service processes Redis queues to:

- add members to groups/communities
- remove members
- moderate messages containing links, and optionally moderate content with OpenAI
- maintain phone-based authorizations

## Architecture

The project uses one operational database connection:

- **Operational database (`PG_DB_*`)**: business tables such as workers, authorizations, add/remove requests, and related data.

It also uses:

- **Redis** for the `addQueue` and `removeQueue` queues
- **Telegram Bot API** for failure alerts and moderation logs
- local Baileys auth files in the ignored `auth/` directory

## Requirements

- Node.js 20+ (recomendado)
- pnpm 10+
- Redis 6+
- PostgreSQL 14+
- A WhatsApp account to connect via QR code or pairing code

## Quick Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create the environment file:

```bash
cp .env.example .env
```

3. Fill in the variables in `.env`.

4. Build and run:

```bash
pnpm start
```

## Execution Modes

The worker accepts these flags:

- `--add`
- `--remove`
- `--moderation`
- `--auth`
- `--pairing`

Behavior:

- Without mode flags (`--add|--remove|--moderation|--auth`), it runs in full mode: `add + remove + moderation + auth`.
- `--pairing` only enables pairing code generation; combine it with the modes you want.

Examples:

```bash
# full mode (default)
pnpm start

# add + auth only
pnpm start -- --add --auth

# remove + auth only
pnpm start -- --remove --auth

# moderation + auth only
pnpm start -- --moderation --auth

# auth with pairing code (requires PAIRING_PHONE)
pnpm start -- --auth --pairing
```

There is also an interactive helper:

```bash
./run-interactive.sh
```

## Environment Variables

Based on `.env.example`:

### Operational Database (`PG_DB_*`)

- `PG_DB_HOST`
- `PG_DB_PORT`
- `PG_DB_NAME`
- `PG_DB_USER`
- `PG_DB_PASSWORD`

### Redis

- `REDIS_HOST`
- `REDIS_PORT` (defaults to `6379` if omitted)
- `REDIS_PASSWORD` (optional, depends on your infrastructure)

### Execution Flow

- `MIN_DELAY` (required)
- `MAX_DELAY` (required)
- `DELAY_JITTER` (optional, default `0`)
- `CALL_TIMEOUT_MS` (optional, default `15000`)

### Logging and Observability

- `LOG_LEVEL` (`trace|debug|info|warn|error|fatal`)
- `BAILEYS_LOG_LEVEL` (optional; Baileys internal log level, default `fatal`)
- `NODE_ENV` (`production` enables JSON logs)
- `UPTIME_URL` (optional; receives a periodic ping)

### Telegram

- `TELEGRAM_BOT_TOKEN` (optional; required to send notifications)
- `TELEGRAM_FAILURES_CHAT_ID` (optional; used for add/remove failure alerts)
- `TELEGRAM_MODERATIONS_CHAT_ID` (optional; used for moderation logs)

### Moderation

- `ENABLE_LINK_MODERATION` (`true|false`)
- `ENABLE_CONTENT_MODERATION` (`true|false`)
- `OPENAI_API_KEY` (required if `ENABLE_CONTENT_MODERATION=true`)

### First Contact and Pairing

- `FIRST_CONTACT_GROUP_NAME` (optional; exact group name that receives the first-contact message and audio)
- `PAIRING_PHONE` (required for `--pairing`, digits only, e.g. `5511999999999`)

### Helper Tools

- `PROMOTE_DELAY_SECONDS` (optional; default `2`, used by `addAdminToAllGroups`)
- `RECONNECT_RETRIES` (optional; default `2`, used by `addAdminToAllGroups`)
- `RECONNECT_DELAY_SECONDS` (optional; default `3`, used by `addAdminToAllGroups`)

## Expected Redis Queues

### `addQueue`

```json
{
  "type": "string",
  "request_id": 123,
  "registration_id": "456",
  "group_id": "551199999999-123456@g.us or without suffix",
  "group_type": "MB|JB|RJB|..."
}
```

### `removeQueue`

```json
{
  "type": "string",
  "registration_id": "456",
  "groupId": "group id",
  "phone": "5511999999999",
  "reason": "removal reason",
  "communityId": "community id or null"
}
```

## Expected Tables

### Expected in the operational database (`PG_DB_*`)

These tables are read and written by the code and are **not** created by this repository's migrations:

- `whatsapp_workers`
- `whatsapp_authorization`
- `group_requests`
- `member_groups`
- `phones`
- `legal_representatives`
- `registration`
- `whatsapp_moderation`
- `whatsapp_lid_mappings`

## Useful Scripts

### Build, Check, and Quality

- `pnpm build`
- `pnpm check`
- `pnpm lint`
- `pnpm lint:fix`
- `pnpm fmt`
- `pnpm fmt:write`

### Execution

- `pnpm start` (build + run)
- `pnpm run-prod` (runs `dist/index.js`)

### Operational Tools (generate files in `tools_results/`)

- `pnpm get-queues -- --add|--remove|--all`
- `pnpm getAdmins -- --ids 123,456`
- `pnpm getJBAdmins`
- `pnpm reportUnderageGroups`
- `pnpm addAdminToAllGroups -- --jid 5511999999999@s.whatsapp.net`

## Important Behaviors

- The WhatsApp session and Signal keys are stored locally in `auth/`.
- On logout (`DisconnectReason.loggedOut`), the process exits and the device must be linked again.
- There is a special welcome rule for a group named `Mensampa Regional`.
- The welcome audio uses the local file `primeiro_contato.mp3`.

## Contributions

### Fix for a Possible Auth State Serialization Error

- Renato Cunha - MB 6456
