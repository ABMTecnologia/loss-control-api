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

- O projeto está sem autenticação final por enquanto.
- O usuário é identificado por `x-user-email` (frontend envia automaticamente com `VITE_USER_EMAIL`) ou por `DEFAULT_USER_EMAIL`.
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
