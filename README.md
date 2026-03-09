# Loss Control API

API do sistema **Loss Control**, construída com **Node.js + Express + Prisma + PostgreSQL**.

Este README foi reorganizado para servir como:
- guia de setup local
- referência de variáveis de ambiente
- checklist de banco e Prisma
- guia de deploy em **Cloud Run + Cloud SQL + Secret Manager**
- troubleshooting baseado em problemas reais que já aconteceram no projeto

---

## 1. Visão geral

A API atende o frontend do Loss Control e concentra:
- autenticação por senha e por código
- sessões bearer token
- convites de usuários
- upload de imagens
- persistência em PostgreSQL via Prisma
- envio de convites por e-mail via Resend
- armazenamento local ou em GCS

Stack principal:
- **Node.js 20+**
- **Express**
- **Prisma**
- **PostgreSQL**
- **Cloud Run** para produção
- **Cloud SQL** para banco em produção
- **Secret Manager** para credenciais

---

## 2. Requisitos

### Desenvolvimento local
- Node.js 20+
- npm 10+
- PostgreSQL acessível localmente ou remotamente
- opcional: Cloud SQL Auth Proxy, se quiser acessar uma instância do Cloud SQL do GCP pela sua máquina

### Produção
- projeto GCP configurado
- Cloud Run habilitado
- Cloud Build habilitado
- Artifact Registry habilitado
- Cloud SQL configurado
- Secret Manager configurado

---

## 3. Instalação

```bash
npm install
```

No Windows/PowerShell:

```powershell
npm install
```

---

## 4. Configuração de ambiente

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No PowerShell:

```powershell
Copy-Item .env.example .env
```

### Exemplo de `.env` local

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
FRONTEND_ORIGINS="http://localhost:5173,http://127.0.0.1:5173"
```

### Explicação das variáveis

#### Banco e autenticação
- `DATABASE_URL`: URL de conexão do PostgreSQL.
- `DEFAULT_USER_EMAIL`: usuário padrão para fluxos legados, quando habilitados.
- `ADMIN_BOOTSTRAP_EMAIL`: e-mail do SUPER_ADMIN criado no bootstrap/seed.
- `ADMIN_BOOTSTRAP_NAME`: nome do SUPER_ADMIN de bootstrap.
- `ALLOW_LEGACY_AUTH`: `true` para aceitar fallback antigo com `x-user-email` e `DEFAULT_USER_EMAIL`. Em produção, o recomendado é `false`.

#### Login e sessão
- `AUTH_EMAIL_MODE`:
  - `console`: gera/loga código OTP no terminal/log
  - `off`: desabilita OTP por e-mail
- `AUTH_OTP_TTL_MINUTES`: expiração do código OTP.
- `AUTH_SESSION_TTL_DAYS`: validade da sessão bearer.

#### Frontend e convites
- `FRONTEND_URL`: URL base usada para links de convite.
- `FRONTEND_ORIGINS`: lista separada por vírgula das origens liberadas em CORS.
- `INVITE_TTL_HOURS`: validade do token de convite.
- `MANAGER_MAX_SUBORDINATES`: limite de operadores por gerente.
- `INVITE_EMAIL_MODE`:
  - `console`: loga convite no terminal/log
  - `resend`: envia e-mail real via Resend
- `EMAIL_FROM`: remetente dos e-mails enviados.
- `RESEND_API_KEY`: chave da API Resend.

#### Upload e storage
- `STORAGE_IMAGE`: nome do bucket GCS. Se vazio, usa storage local.
- `STORAGE_PUBLIC_BASE_URL`: base pública do bucket, se aplicável.
- `GOOGLE_APPLICATION_CREDENTIALS`: caminho local da chave JSON, usado apenas em ambiente local quando necessário.

#### Limites e proteção
- `JSON_LIMIT`: limite do body JSON.
- `RATE_LIMIT_WINDOW_MS`: janela do rate limit em milissegundos.
- `RATE_LIMIT_MAX`: máximo de requests por IP dentro da janela.

### Observações importantes

#### Local x produção
A `DATABASE_URL` muda entre local e produção:

**Local com PostgreSQL local:**
```env
DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/losscontrol?schema=public"
```

**Local com Cloud SQL Auth Proxy:**
```env
DATABASE_URL="postgresql://postgres:SENHA@127.0.0.1:5434/losscontrol?schema=public"
```

**Cloud Run com Cloud SQL via socket:**
```env
DATABASE_URL="postgresql://postgres:SENHA@localhost/losscontrol?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME&schema=public"
```

> Não reutilize no Cloud Run a URL local com `127.0.0.1:5434`. Isso funciona na máquina com proxy, mas não no Cloud Run.

---

## 5. Banco de dados e Prisma

### Gerar Prisma Client

```bash
npm run db:generate
```

### Aplicar migrations em desenvolvimento

```bash
npm run db:migrate
```

### Aplicar migrations em ambiente provisionado

```bash
npm run db:deploy
```

### Popular dados iniciais

```bash
npm run db:seed
```

### Abrir Prisma Studio

```bash
npm run db:studio
```

### Checklist de banco

Antes de subir a API, confirme:
- a database correta é `losscontrol`
- as tabelas do schema existem
- a `DATABASE_URL` aponta para a database certa
- o usuário de conexão tem permissão de leitura e escrita

Consultas úteis:

```sql
select current_database(), current_schema();
```

```sql
select table_schema, table_name
from information_schema.tables
where table_schema not in ('pg_catalog', 'information_schema')
order by table_schema, table_name;
```

---

## 6. Executar a API

### Desenvolvimento

```bash
npm run dev
```

### Build

```bash
npm run build
```

### Produção local / container

```bash
npm run start
```

### Typecheck

```bash
npm run check
```

Padrão local:
- API: `http://localhost:3001`
- healthcheck: `http://localhost:3001/health`

---

## 7. Endpoints úteis

### Saúde e documentação
- `GET /health`
- `GET /api/docs/openapi.json`
- `GET /api/docs`

### Autenticação
- `POST /api/auth/request-login-code`
- `POST /api/auth/verify-login-code`
- `POST /api/auth/login-password`
- `POST /api/auth/set-password`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Convites
- `POST /api/users/invite`
- `GET /api/invites/:token`
- `POST /api/invites/:token/accept`

### Formato padrão de erro

```json
{
  "error": {
    "code": "SOME_CODE",
    "message": "Mensagem",
    "details": {}
  }
}
```

---

## 8. Upload de imagens

### Storage local
Se `STORAGE_IMAGE=""`, os arquivos ficam em:

```text
/uploads/{companyId}/{userId}/loss-events/{lossEventId}/...
```

### Google Cloud Storage
Se `STORAGE_IMAGE` estiver preenchido, o upload vai para o bucket com o mesmo padrão de pastas:

```text
{companyId}/{userId}/loss-events/{lossEventId}/...
```

### Observação para Cloud Run
Em produção no Cloud Run, prefira usar a **service account do serviço** em vez de `GOOGLE_APPLICATION_CREDENTIALS`.

---

## 9. Fluxo para colegas do frontend

Depois que a API estiver publicada no Cloud Run, quem trabalha só no frontend **não precisa**:
- subir o backend local
- rodar Cloud SQL Auth Proxy
- conectar manualmente no banco

Basta configurar no frontend:

```env
VITE_API_URL=https://SUA_API_PUBLICA.run.app
```

Se o frontend estiver em dev com Vite:
- o `vite.config` pode proxyar `/api`, `/health` e `/uploads` para a URL pública da API
- ou o frontend pode chamar diretamente a URL pública

### Observação
Se a API estiver com `AUTH_EMAIL_MODE=off`, o fluxo de OTP por e-mail fica desabilitado. Nesse caso, o caminho esperado para o time é **login por senha**.

---

## 10. Deploy em produção no GCP

Esta seção assume o seguinte desenho:
- API no **Cloud Run**
- Banco no **Cloud SQL PostgreSQL**
- Imagem no **Artifact Registry**
- Secrets no **Secret Manager**

### 10.1 APIs necessárias

```powershell
gcloud services enable `
  run.googleapis.com `
  cloudbuild.googleapis.com `
  artifactregistry.googleapis.com `
  sqladmin.googleapis.com `
  secretmanager.googleapis.com
```

### 10.2 Variáveis auxiliares

```powershell
$env:PROJECT_ID="SEU_PROJECT_ID"
$env:REGION="southamerica-east1"
$env:REPO="loss-control"
$env:SERVICE="loss-control-api"
$env:SERVICE_ACCOUNT="loss-control-api-sa@$env:PROJECT_ID.iam.gserviceaccount.com"
$env:IMAGE="${env:REGION}-docker.pkg.dev/${env:PROJECT_ID}/${env:REPO}/${env:SERVICE}:$(git rev-parse --short HEAD)"
```

### 10.3 Service account da API

```powershell
gcloud iam service-accounts create loss-control-api-sa `
  --display-name="Loss Control API"
```

Permissões mínimas:

```powershell
gcloud projects add-iam-policy-binding $env:PROJECT_ID `
  --member="serviceAccount:$env:SERVICE_ACCOUNT" `
  --role="roles/cloudsql.client"


gcloud projects add-iam-policy-binding $env:PROJECT_ID `
  --member="serviceAccount:$env:SERVICE_ACCOUNT" `
  --role="roles/secretmanager.secretAccessor"
```

Se usar bucket, adicione também a permissão adequada no GCS.

### 10.4 Artifact Registry

```powershell
gcloud artifacts repositories create $env:REPO `
  --repository-format=docker `
  --location=$env:REGION
```

### 10.5 Secrets

Crie pelo menos:
- `loss-control-database-url`
- `loss-control-resend-api-key`

Exemplo de criação:

```powershell
echo -n "SUA_DATABASE_URL" | gcloud secrets create loss-control-database-url `
  --replication-policy="automatic" `
  --data-file=-

echo -n "SUA_RESEND_API_KEY" | gcloud secrets create loss-control-resend-api-key `
  --replication-policy="automatic" `
  --data-file=-
```

### 10.6 Dockerfile recomendado

Pontos importantes no container de produção:
- instalar `openssl` para evitar warning/problema com Prisma em imagens slim
- não depender de `cross-env` no `start` da imagem final
- usar `node dist/index.cjs` no runtime
- em build com Prisma config exigindo `DATABASE_URL`, usar valor dummy apenas para gerar client

Exemplo base:

```dockerfile
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci

FROM node:20-bookworm-slim AS build
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy?schema=public
ENV DATABASE_URL=${DATABASE_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-bookworm-slim AS runner
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
ENV NODE_ENV=production
ARG DATABASE_URL=postgresql://dummy:dummy@localhost:5432/dummy?schema=public
ENV DATABASE_URL=${DATABASE_URL}
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev
RUN npx prisma generate
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/index.cjs"]
```

### 10.7 Build da imagem

```powershell
gcloud builds submit --tag $env:IMAGE
```

### 10.8 Descobrir o connection name correto do Cloud SQL

```powershell
gcloud sql instances describe loss-control-db `
  --format="yaml(connectionName,serverCaMode,ipAddresses,settings.ipConfiguration.privateNetwork)"
```

> Use exatamente o `connectionName` retornado aqui. Um erro comum é usar a instância certa com a região errada.

Exemplo real já encontrado no projeto:
- **correto:** `iron-decorator-484721-g9:us-central1:loss-control-db`
- **errado:** `iron-decorator-484721-g9:southamerica-east1:loss-control-db`

### 10.9 DATABASE_URL para Cloud Run

Se a instância usa public IP e o serviço vai conectar via Cloud SQL socket:

```text
postgresql://postgres:SENHA@localhost/losscontrol?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME&schema=public
```

### 10.10 Deploy do serviço

Exemplo de deploy:

```powershell
gcloud run deploy $env:SERVICE `
  --image $env:IMAGE `
  --region $env:REGION `
  --service-account $env:SERVICE_ACCOUNT `
  --add-cloudsql-instances PROJECT_ID:REGION:INSTANCE_NAME `
  --no-invoker-iam-check `
  --update-secrets "DATABASE_URL=loss-control-database-url:latest,RESEND_API_KEY=loss-control-resend-api-key:latest" `
  --set-env-vars "FRONTEND_URL=http://localhost:5173" `
  --set-env-vars "FRONTEND_ORIGINS=http://localhost:5173" `
  --set-env-vars "AUTH_EMAIL_MODE=off" `
  --set-env-vars "INVITE_EMAIL_MODE=resend" `
  --set-env-vars "EMAIL_FROM=noreply@abm-tecnologia.com" `
  --set-env-vars "ALLOW_LEGACY_AUTH=false" `
  --set-env-vars "AUTH_OTP_TTL_MINUTES=10" `
  --set-env-vars "AUTH_SESSION_TTL_DAYS=30" `
  --set-env-vars "INVITE_TTL_HOURS=48" `
  --set-env-vars "MANAGER_MAX_SUBORDINATES=5" `
  --set-env-vars "JSON_LIMIT=8mb" `
  --set-env-vars "RATE_LIMIT_WINDOW_MS=60000" `
  --set-env-vars "RATE_LIMIT_MAX=120"
```

### 10.11 Ajustar conexão SQL do serviço

Se você adicionou a instância errada, remova a conexão incorreta:

```powershell
gcloud run services update loss-control-api `
  --region=southamerica-east1 `
  --remove-cloudsql-instances=PROJECT_ID:REGION_ERRADA:INSTANCE_NAME
```

### 10.12 Atualizar secret da DATABASE_URL

Se precisar trocar a URL do banco, adicione uma nova versão ao secret:

```powershell
@'
postgresql://postgres:SENHA@localhost/losscontrol?host=/cloudsql/PROJECT_ID:REGION:INSTANCE_NAME&schema=public
'@ | Set-Content -NoNewline .\database_url_cloudrun.txt

gcloud secrets versions add loss-control-database-url --data-file=".\database_url_cloudrun.txt"
```

Depois force nova revisão do serviço:

```powershell
gcloud run services update loss-control-api `
  --region=southamerica-east1 `
  --update-secrets "DATABASE_URL=loss-control-database-url:latest,RESEND_API_KEY=loss-control-resend-api-key:latest"
```

### 10.13 Rodar migrations em produção

Crie um job separado para migrations:

```powershell
gcloud run jobs create loss-control-migrate `
  --image $env:IMAGE `
  --region $env:REGION `
  --service-account $env:SERVICE_ACCOUNT `
  --set-cloudsql-instances PROJECT_ID:REGION:INSTANCE_NAME `
  --update-secrets "DATABASE_URL=loss-control-database-url:latest,RESEND_API_KEY=loss-control-resend-api-key:latest" `
  --command npm `
  --args run,db:deploy
```

Executar:

```powershell
gcloud run jobs execute loss-control-migrate --region=$env:REGION
```

### 10.14 Validar o serviço

```powershell
gcloud run services describe loss-control-api --region=$env:REGION
```

```powershell
curl https://SUA_API_PUBLICA.run.app/health
```

---

## 11. Troubleshooting

### 11.1 Frontend mostra “Credenciais inválidas”, mas a API devolve 500
O frontend pode mascarar falhas internas como erro de login. Teste direto o endpoint e confira logs do Cloud Run:

```powershell
gcloud run services logs read loss-control-api `
  --region=southamerica-east1 `
  --limit=100
```

### 11.2 `P1001 Can't reach database server at /cloudsql/...`
Causas mais comuns:
- `DATABASE_URL` de produção ainda aponta para `127.0.0.1:5434`
- `connectionName` do Cloud SQL está errado
- a instância foi anexada com região errada no Cloud Run
- a service account do Cloud Run não tem `roles/cloudsql.client`

### 11.3 A instância existe, mas o serviço está com duas SQL connections
O `--add-cloudsql-instances` adiciona conexões, não substitui. Remova a errada com `--remove-cloudsql-instances`.

### 11.4 OTP por e-mail não funciona
Se `AUTH_EMAIL_MODE=off`, o endpoint de solicitar código não vai funcionar como fluxo normal de login por código. Para usar OTP, configure o modo conforme a estratégia do ambiente.

### 11.5 `relation "User" does not exist`
Você está conectado na database errada ou sem migrations aplicadas. Confirme a database atual e a lista de tabelas.

### 11.6 Upload não vai para bucket
Confira:
- `STORAGE_IMAGE`
- `STORAGE_PUBLIC_BASE_URL`
- permissões da service account no GCS

### 11.7 CORS bloqueando o frontend
Ajuste `FRONTEND_ORIGINS`. Em dev local, `http://localhost:5173` costuma ser suficiente. Se alguém abrir pelo IP da máquina ou outra porta, pode precisar incluir a origem correspondente.

### 11.8 Build do Docker falha no `prisma generate` pedindo `DATABASE_URL`
Se o `prisma.config.ts` exige `DATABASE_URL`, use valor dummy no build do container apenas para geração do Prisma Client.

### 11.9 Build do Cloud Run sobe, mas a revisão morre antes da porta 8080
Revise o comando de start do container. Evite depender de `cross-env` no runtime final se ele estiver em `devDependencies` e você fizer `npm ci --omit=dev`.

---

## 12. Checklist final de produção

Antes de considerar o deploy concluído, valide:
- imagem publicada no Artifact Registry
- Cloud Run com revisão saudável
- `DATABASE_URL` de produção apontando para socket `/cloudsql/...`
- conexão SQL anexada ao serviço com o `connectionName` correto
- secrets carregados
- service account com `cloudsql.client` e `secretmanager.secretAccessor`
- `/health` respondendo
- login por senha funcionando
- frontend consumindo a URL pública da API

---

## 13. Referência rápida do time

### Para quem mexe só no frontend
Você só precisa:
- rodar o frontend
- configurar `VITE_API_URL` para a URL pública da API
- usar um login válido

Você não precisa:
- subir backend local
- rodar Cloud SQL Auth Proxy
- logar manualmente no banco

---

## 14. Observação final

O README original já cobria instalação, variáveis de ambiente, Prisma, execução local, uploads, fluxos de auth e troubleshooting básico. Esta versão expande isso com um guia de deploy e com os principais aprendizados reais do projeto, incluindo setup de Cloud Run, secrets, Cloud SQL e erros comuns. 
