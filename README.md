# worker_baileys (newzelador)

Worker de WhatsApp baseado em [Baileys](https://github.com/WhiskeySockets/Baileys), escrito em TypeScript.

Este servico processa filas no Redis para:

- adicionar membros em grupos/comunidades
- remover membros
- moderar mensagens com links (e opcionalmente com OpenAI)
- manter autorizacoes por telefone
- persistir mensagens e estado de autenticacao no PostgreSQL

## Arquitetura

O projeto usa dois acessos a banco:

- **Banco operacional (`PG_DB_*`)**: tabelas de negocio (workers, autorizacoes, pedidos de add/remove, etc).
- **Banco Prisma/Auth (`DATABASE_URL`)**: tabelas de mensagens e auth state do Baileys (`WaAuthCreds`, `WaAuthKey`, etc).

Tambem usa:

- **Redis** para filas `addQueue` e `removeQueue`
- **Telegram Bot API** para alertas de falha e logs de moderacao

## Requisitos

- Node.js 20+ (recomendado)
- pnpm 10+
- Redis 6+
- PostgreSQL 14+
- Conta WhatsApp para conectar via QR ou pairing code

## Setup rapido

1. Instale dependencias:

```bash
pnpm install
```

2. Crie o arquivo de ambiente:

```bash
cp .env.example .env
```

3. Preencha as variaveis no `.env`.

4. Aplique as migrations do Prisma no banco de `DATABASE_URL`:

```bash
pnpm prisma migrate deploy
```

5. Build e execucao:

```bash
pnpm start
```

## Modos de execucao

O worker aceita flags:

- `--add`
- `--remove`
- `--moderation`
- `--auth`
- `--pairing`

Comportamento:

- Sem flags de modo (`--add|--remove|--moderation|--auth`), roda em modo completo: `add + remove + moderation + auth`.
- `--pairing` apenas habilita geracao de pairing code; combine com os modos desejados.

Exemplos:

```bash
# modo completo (default)
pnpm start

# somente add + auth
pnpm start -- --add --auth

# somente remove + auth
pnpm start -- --remove --auth

# somente moderation + auth
pnpm start -- --moderation --auth

# auth com pairing code (requer PAIRING_PHONE)
pnpm start -- --auth --pairing
```

Tambem existe um helper interativo:

```bash
./run-interactive.sh
```

## Variaveis de ambiente

Baseado em `.env.example`:

### Banco operacional (`PG_DB_*`)

- `PG_DB_HOST`
- `PG_DB_PORT`
- `PG_DB_NAME`
- `PG_DB_USER`
- `PG_DB_PASSWORD`

### Banco Prisma/Auth (`DATABASE_URL`)

- `DATABASE_URL` (obrigatoria)

### Redis

- `REDIS_HOST`
- `REDIS_PORT` (padrao `6379` se ausente)
- `REDIS_PASSWORD` (opcional, depende da infra)

### Fluxo de execucao

- `MIN_DELAY` (obrigatoria)
- `MAX_DELAY` (obrigatoria)
- `DELAY_JITTER` (opcional, padrao `0`)
- `CALL_TIMEOUT_MS` (opcional, padrao `15000`)

### Logs e observabilidade

- `LOG_LEVEL` (`trace|debug|info|warn|error|fatal`)
- `NODE_ENV` (`production` gera logs JSON)
- `UPTIME_URL` (opcional; recebe ping periodico)

### Telegram

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_FAILURES_CHAT_ID`
- `TELEGRAM_MODERATIONS_CHAT_ID`

### Moderacao

- `ENABLE_LINK_MODERATION` (`true|false`)
- `ENABLE_CONTENT_MODERATION` (`true|false`)
- `OPENAI_API_KEY` (necessaria se `ENABLE_CONTENT_MODERATION=true`)

### Primeiro contato e pairing

- `FIRST_CONTACT_GROUP_NAME` (nome exato do grupo para mensagem de boas-vindas e audio)
- `PAIRING_PHONE` (obrigatoria para `--pairing`, formato so digitos, ex: `5511999999999`)

## Filas Redis esperadas

### `addQueue`

```json
{
  "type": "string",
  "request_id": 123,
  "registration_id": "456",
  "group_id": "551199999999-123456@g.us ou sem sufixo",
  "group_type": "MB|JB|RJB|..."
}
```

### `removeQueue`

```json
{
  "type": "string",
  "registration_id": "456",
  "groupId": "id do grupo",
  "phone": "5511999999999",
  "reason": "motivo da remocao",
  "communityId": "id da comunidade ou null"
}
```

## Tabelas esperadas

### Criadas por migration Prisma (DATABASE_URL)

- `account`
- `contact`
- `conversa`
- `message`
- `account_temp`
- `WaAuthCreds`
- `WaAuthKey`

### Esperadas no banco operacional (PG*DB*\*)

Estas tabelas sao lidas/escritas pelo codigo e **nao** sao criadas pelas migrations deste repo:

- `whatsapp_workers`
- `whatsapp_authorization`
- `group_requests`
- `member_groups`
- `phones`
- `legal_representatives`
- `registration`
- `whatsapp_moderation`
- `whatsapp_lid_mappings`

## Scripts uteis

### Build, check e qualidade

- `pnpm build`
- `pnpm check`
- `pnpm lint`
- `pnpm lint:fix`
- `pnpm fmt`
- `pnpm fmt:write`

### Execucao

- `pnpm start` (build + run)
- `pnpm run-prod` (roda `dist/index.js`)

### Ferramentas operacionais (geram arquivos em `tools_results/`)

- `pnpm get-queues -- --add|--remove|--all`
- `pnpm getAdmins -- --ids 123,456`
- `pnpm getJBAdmins`
- `pnpm reportUnderageGroups`
- `pnpm addAdminToAllGroups -- --jid 5511999999999@s.whatsapp.net`

## Comportamentos importantes

- Sessao do WhatsApp e chaves do Signal ficam no Postgres (`WaAuthCreds` e `WaAuthKey`).
- Em logout (`DisconnectReason.loggedOut`), o processo encerra; e necessario relinkar.
- Existe regra especial de boas-vindas para grupo com nome `Mensampa Regional`.
- O audio de boas-vindas usa o arquivo local `primeiro_contato.mp3`.

## Contribuições

### Fix possível erro de serialização no auth state

- Renato Cunha - MB 6456
