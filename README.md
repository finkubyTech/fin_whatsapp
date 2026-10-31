# fin_whatsapp

Finkuby's WhatsApp gateway. Staff link company WhatsApp numbers by QR code. The CRM and other fin_ services then send and read messages through this API. Port **5109** (dev server 6109). Routes live under **`/api/whatsapp`**. The `wa_*` tables come from `fin_migrations` (`1791000000900-create_whatsapp_gateway_tables`), in the same `loan_management` database as every other service.

It connects as a linked device (WhatsApp Web), through [Baileys](https://github.com/WhiskeySockets/Baileys). This is **not** the official WhatsApp Business API. WhatsApp can ban a number that sends bulk or unsolicited messages. The throttle, broadcast delays and opt-out list exist to keep numbers safe; keep them on.

It is a rewrite of [WA-AKG](https://github.com/mrifqidaffaaditya/WA-AKG) v1.6.4 (MIT, see `LICENSE-WA-AKG`) in the fin_ service structure. The Next.js dashboard is gone: the CRM gets WhatsApp screens instead.

## What it does

| Area | Details |
| --- | --- |
| Numbers | Add, start (QR or pairing code), stop, restart, log out, delete. Connected numbers reconnect when the service restarts. |
| Messages | Text, media (upload or URL), location, contact card, reply, mention, react, delete for everyone, mark read. Incoming and outgoing messages are stored with their media. |
| Chats | Chat list (newest first, unread counts, search, labels), message history, delete the stored copy of a chat. |
| Contacts and groups | Contacts, check which numbers are on WhatsApp, `@lid` → phone number, block. Groups: create, edit, participants, invite links, join, leave. |
| Automations | Welcome message for new chats, auto-reply rules (exact, contains, regex), auto-read. |
| Opt-out | A customer who sends STOP, UNSUBSCRIBE or OPT OUT is added to the opt-out list. After that, nothing goes to them: API sends get a 409, and auto-replies, schedules and broadcasts skip them. Staff can add and remove entries. |
| Scheduler | One-off or recurring (cron, IST) messages. |
| Broadcasts | One message to many numbers, 10–30 s apart by default. Runs from the database, so it survives a restart. |
| Webhooks | Events POSTed to other services, signed `X-Webhook-Signature: sha256=<hmac>`, with a delivery log. |

## Who can call it

| Caller | How | Allowed |
| --- | --- | --- |
| Staff (CRM) | `Authorization: Bearer <fin_crm_app token>`, backed by an ACTIVE login | by permission, below |
| Other fin_ services | `x-internal-key: INTERNAL_API_KEY` | everything |
| Customers | – | nothing (403) |

| Permission | Allows |
| --- | --- |
| `whatsapp_read` | numbers, chats, messages, contacts, groups, labels, media |
| `whatsapp_send` | read + send, react, delete, mark read, labels, check numbers |
| `whatsapp_admin` | send + manage numbers and settings, automations, opt-outs, schedules, broadcasts, webhooks, groups, blocking, deleting stored chats |

`SUPER_ADMIN` has all three. The permissions come from the migration (module `WHATSAPP`).

Responses use the usual `{ error, status, message, data }` envelope. `data` is encrypted unless the request sends `x-api-encrypt: false`. Media files (`/media/<name>`) are sent as they are.

## API

Every route except `/health`, `/check/*` and `/media/*` is under `/api/whatsapp/sessions`. `:session` is the number's `session_key`, for example `sales`.

| Method | Path | Permission |
| --- | --- | --- |
| GET, POST | `/sessions` | read, admin |
| GET, PATCH, DELETE | `/sessions/:session` | read, admin, admin |
| GET | `/sessions/:session/qr` | admin |
| POST | `/sessions/:session/{start,stop,restart,logout,pairing-code}` | admin |
| GET, PUT | `/sessions/:session/settings` | admin |
| POST | `/sessions/:session/messages/{text,media,location,contact}` | send |
| POST, DELETE | `/sessions/:session/messages/:keyId/react`, `/sessions/:session/messages/:keyId` | send |
| GET | `/sessions/:session/chats`, `/chats/:jid/messages` | read |
| POST | `/sessions/:session/chats/:jid/read` | send |
| DELETE | `/sessions/:session/chats/:jid/stored` | admin |
| GET, PUT | `/sessions/:session/chats/:jid/labels` | read, send |
| CRUD | `/sessions/:session/labels` | read / send |
| GET | `/sessions/:session/contacts`, `/contacts/:jid`, `/contacts/lid/:lid` | read |
| POST | `/sessions/:session/contacts/check` | send |
| POST | `/sessions/:session/contacts/:jid/{block,unblock}` | admin |
| GET | `/sessions/:session/groups`, `/groups/:jid` | read |
| POST, PATCH | groups: create, `join`, edit, `participants`, `invite-code`, `invite-code/revoke`, `leave` | admin |
| CRUD | `/sessions/:session/{auto-replies,opt-outs,schedules,broadcasts,webhooks}` (+ `/opt-outs/:id/remove`, `/schedules/:id/cancel`, `/broadcasts/:id/cancel`, `/webhooks/:id/logs`, `/webhooks/:id/test`) | admin |
| GET | `/media/:name` | read |
| GET | `/health` (no auth), `/check/health`, `/check/ready` | – |

**Recipients** (`to`): a phone number or a WhatsApp address. A 10-digit number gets `91`. Group addresses end in `@g.us`.

Sending a text from another service:

```http
POST /api/whatsapp/sessions/sales/messages/text
x-internal-key: <INTERNAL_API_KEY>
Content-Type: application/json

{ "to": "9876543210", "text": "Your loan is approved", "reply_to": "<optional key id>" }
```

The result is `{ key_id, jid }`. A 409 means the number isn't connected, or the recipient opted out.

## Webhooks

The body is `{ event, sessionId, timestamp, data }`, where `sessionId` is the `session_key`. The events are:

- `message.received` and `message.sent`
- `message.status` (SENT, DELIVERED, READ)
- `message.deleted` and `message.edited`
- `contact.update`
- `group.update` and `group.participants`
- `opt_out`

A webhook can subscribe to `["*"]` or to a list of these.

To verify a delivery, compute HMAC-SHA256 of the raw body with the webhook's secret and compare it with `X-Webhook-Signature`.

Webhook URLs must be public `https`. A fin_ service on the Docker network needs its host in `WHATSAPP_WEBHOOK_ALLOWED_HOSTS`: the deploy files allow `fin_rm_inbox-dev` / `fin_rm_inbox-prod`, whose webhook fin_rm_inbox registers itself.

## Things to know

- **One instance.** Each number has exactly one live connection. Running two containers against the same database would fight over the numbers, so the compose files run one.
- **`WHATSAPP_ENCRYPTION_KEY`** encrypts the stored logins and webhook secrets. If it is lost or changed, every number has to be linked again.
- **Media** is stored in `WHATSAPP_MEDIA_DIR`, a Docker volume on the servers. The database keeps only the file name.
- **History:** when a number is linked, WhatsApp sends recent chats. They are stored without unread counts, webhooks or auto-replies. Full history: `WHATSAPP_SYNC_FULL_HISTORY=true`.

## Fixed from WA-AKG

| WA-AKG | Here |
| --- | --- |
| Two schedulers over the same rows: a message could go out twice | One job; rows claimed with `FOR UPDATE SKIP LOCKED` |
| Delivery receipts read one step off (delivered showed as read) | Mapped from Baileys' status codes; status only moves forward |
| Broadcasts in memory, lost on restart; 2 s between messages | In the database, resumed after a restart; 10–30 s apart |
| STOP was logged, sending continued | Opt-out list enforced on every send path |
| 4 queries per webhook event, one query per login key | Cached webhooks, batched login-key reads and writes |
| Every history message processed one by one, with media downloads | Batched inserts, no downloads |
| URL checks resolved DNS once and fetched again (DNS rebinding) | The checked address is the one connected to |
| Socket.IO without auth, telemetry heartbeat | Removed |

## Layout

```
config/options.ts            env (fails fast on missing keys)
src/app.ts                   middleware, routes, boot, graceful shutdown
src/controllers/             routes + permission guards
src/schemas/                 AJV request schemas
src/services/                API logic per area
src/whatsapp/                Baileys: connection, manager, ingest, sender, automations, webhooks, auth state, media
src/jobs/                    scheduler, broadcaster, webhook-log pruning
src/helpers/                 jid, message parsing, encryption, safe fetch, pagination
tests/                       unit, routes (supertest), *.db.spec.ts (Postgres)
deploy/                      docker-compose.dev.yml (6109), docker-compose.prod.yml (5109)
```

## Run

```bash
npm ci && cp .env.example .env    # PUBLIC_KEY, RESPONSE_ENCRYPTION_KEY, WHATSAPP_ENCRYPTION_KEY
npm run local
npm test                          # database tests: TEST_DATABASE_URL=postgres://… npm test
```

The database must have the `fin_migrations` migrations applied. In the platform, run `docker compose up -d fin_whatsapp`.
