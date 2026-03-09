# Loss Control API

API do sistema **Loss Control**, construída com **Node.js + Express + Prisma + PostgreSQL**.

## Requisitos

- Node.js 20+
- npm 10+
- PostgreSQL acessível (local ou remoto)

## 1. Instalação

```bash
npm install
```

## 2. Configuração de ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No Windows (PowerShell):

```powershell
Copy-Item .env.example .env
```

Preencha o `.env`:

- `DATABASE_URL`: conexão PostgreSQL.
- `DEFAULT_USER_EMAIL`: usuário padrão usado no modo sem autenticação.
- `ADMIN_BOOTSTRAP_EMAIL`: email do primeiro usuário SUPER_ADMIN criado no seed.
- `ADMIN_BOOTSTRAP_NAME`: nome do SUPER_ADMIN de bootstrap.
- `AUTH_EMAIL_MODE`: `console` (default, loga código OTP no terminal) ou `off` (desabilita OTP por e-mail e exige criar senha).
- `AUTH_OTP_TTL_MINUTES`: tempo de expiração do código de login.
- `AUTH_SESSION_TTL_DAYS`: validade da sessão (token bearer).
- `ALLOW_LEGACY_AUTH`: `true` para aceitar fallback antigo com `x-user-email`/`DEFAULT_USER_EMAIL` (default recomendado: `false`).
- `FRONTEND_URL`: base URL usada para montar link de convite.
- `INVITE_TTL_HOURS`: expiração do link de convite (em horas).
- `MANAGER_MAX_SUBORDINATES`: limite de operadores vinculados a um gerente.
- `INVITE_EMAIL_MODE`: `console` (loga link no terminal) ou `resend` (envia e-mail real via Resend).
- `EMAIL_FROM`: remetente usado no envio real de convite.
- `RESEND_API_KEY`: chave da API Resend para envio de convites.
- `STORAGE_IMAGE`: nome do bucket GCS (se vazio, salva local em `/uploads`).
- `STORAGE_PUBLIC_BASE_URL`: URL pública base do bucket (opcional).
- `GOOGLE_APPLICATION_CREDENTIALS`: caminho da chave JSON da service account (quando usar GCS).
- `JSON_LIMIT`: limite do body JSON (ex: `8mb`).
- `RATE_LIMIT_WINDOW_MS`: janela do rate limit (ms).
- `RATE_LIMIT_MAX`: máximo de requests por IP na janela.
- `FRONTEND_ORIGINS`: lista separada por vírgula de origens liberadas no CORS (opcional).

Exemplo:

```env
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/losscontrol?schema=public"
DEFAULT_USER_EMAIL="admin@empresa.com"
ADMIN_BOOTSTRAP_EMAIL="gerencial@abm-tecnologia.com"
ADMIN_BOOTSTRAP_NAME="Administrador ABM"
AUTH_EMAIL_MODE="console"
AUTH_OTP_TTL_MINUTES="10"
AUTH_SESSION_TTL_DAYS="30"
ALLOW_LEGACY_AUTH="false"
FRONTEND_URL="http://localhost:5173"
INVITE_TTL_HOURS="48"
MANAGER_MAX_SUBORDINATES="5"
INVITE_EMAIL_MODE="console"
EMAIL_FROM="Loss Control <noreply@abm-tecnologia.com>"
RESEND_API_KEY=""
STORAGE_IMAGE=""
STORAGE_PUBLIC_BASE_URL=""
GOOGLE_APPLICATION_CREDENTIALS="C:/caminho/gcp-key.json"
JSON_LIMIT="8mb"
RATE_LIMIT_WINDOW_MS="60000"
RATE_LIMIT_MAX="120"
FRONTEND_ORIGINS="http://localhost:5173,http://192.168.18.48:5173"
```

## 3. Banco de dados (Prisma)

Gerar client Prisma:

```bash
npm run db:generate
```

Aplicar migrations em desenvolvimento:

```bash
npm run db:migrate
```

Aplicar migrations em ambiente já provisionado:

```bash
npm run db:deploy
```

Popular dados iniciais (quando necessário):

```bash
npm run db:seed
```

Abrir Prisma Studio:

```bash
npm run db:studio
```

## 4. Executar API

Modo desenvolvimento:

```bash
npm run dev
```

Build:

```bash
npm run build
```

Executar build:

```bash
npm run start
```

Typecheck:

```bash
npm run check
```

API padrão: `http://localhost:3001`

## 5. Endpoints úteis

- Healthcheck: `GET /health`
- OpenAPI JSON: `GET /api/docs/openapi.json`
- Docs simples: `GET /api/docs`

## 6. Upload de imagens

### Local (sem bucket)

Se `STORAGE_IMAGE=""`, imagens vão para:

`/uploads/{companyId}/{userId}/loss-events/{lossEventId}/...`

### GCS (bucket)

Se `STORAGE_IMAGE` estiver preenchido, a API envia para GCS com o mesmo padrão de pasta:

`{companyId}/{userId}/loss-events/{lossEventId}/...`

## 7. Observações de desenvolvimento

- Fluxo novo de auth:
  - `POST /api/auth/request-login-code` envia/gera código de 6 dígitos.
  - `POST /api/auth/verify-login-code` valida o código e retorna `accessToken` (Bearer).
  - `POST /api/auth/login-password` login direto por senha.
  - `POST /api/auth/set-password` cria/atualiza senha (primeiro acesso).
  - `GET /api/auth/me` retorna usuário autenticado.
  - `POST /api/auth/logout` revoga sessão.
- Compatibilidade opcional: `x-user-email`/`DEFAULT_USER_EMAIL` só ficam ativos quando `ALLOW_LEGACY_AUTH=true`.
- Convite de usuário:
  - `POST /api/users/invite` cria convite e envia link por e-mail.
  - `GET /api/invites/:token` valida token de convite.
  - `POST /api/invites/:token/accept` aceita convite, cria senha e autentica.
- Erros seguem formato padronizado:

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "Mensagem",
    "details": {}
  }
}
```

## 8. Troubleshooting rápido

- `Category/Item/Sector not found`: confirme IDs e company do usuário atual.
- `TOO_MANY_REQUESTS`: ajuste `RATE_LIMIT_MAX` ou aguarde janela.
- Upload não vai para bucket: confira `STORAGE_IMAGE`, `GOOGLE_APPLICATION_CREDENTIALS` e permissão da service account.
- CORS bloqueando frontend: configure `FRONTEND_ORIGINS`.
