import type { Express, Request } from "express";
import type { Server } from "http";
import crypto, { randomInt } from "node:crypto";
import { UserRole } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db/prisma";
import { ApiError } from "./http/errors";
import { uploadLossEventImage, deleteLossEventImage } from "./services/image-storage";

/**
 * Sem Auth por enquanto:
 * - tenta usar o header "x-user-email"
 * - se não tiver, usa DEFAULT_USER_EMAIL do .env
 * - se não tiver, pega o primeiro usuário do banco
 */
const OTP_TTL_MINUTES = Math.max(1, Number(process.env.AUTH_OTP_TTL_MINUTES ?? 10));
const SESSION_TTL_DAYS = Math.max(1, Number(process.env.AUTH_SESSION_TTL_DAYS ?? 30));
const INVITE_TTL_HOURS = Math.max(1, Number(process.env.INVITE_TTL_HOURS ?? 48));
const MANAGER_MAX_SUBORDINATES = Math.max(1, Number(process.env.MANAGER_MAX_SUBORDINATES ?? 5));

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [algorithm, salt, expected] = storedHash.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  if (derived.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(derived, expectedBuffer);
}

function generateOtpCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

async function sendLoginCodeEmail(email: string, code: string) {
  const mode = (process.env.AUTH_EMAIL_MODE ?? "console").toLowerCase();
  if (mode === "off") return false;

  // Default mode logs the OTP code for local/dev environments.
  console.log(`[AUTH_OTP] Email: ${email} Code: ${code}`);
  return true;
}

async function sendInviteEmail(params: {
  to: string;
  companyName: string;
  invitedByName: string;
  inviteLink: string;
}) {
  const mode = (process.env.INVITE_EMAIL_MODE ?? "console").toLowerCase();

  if (mode === "resend") {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new ApiError(500, "EMAIL_CONFIG_ERROR", "Missing RESEND_API_KEY or EMAIL_FROM");
    }

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;">
        <h2>Convite para acessar o Loss Control</h2>
        <p>Você foi convidado para a empresa <strong>${params.companyName}</strong>.</p>
        <p>Convite enviado por: ${params.invitedByName}</p>
        <p>
          <a href="${params.inviteLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
            Aceitar convite
          </a>
        </p>
        <p>Se o botão não funcionar, copie e cole este link no navegador:</p>
        <p>${params.inviteLink}</p>
      </div>
    `;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [params.to],
        subject: `Convite - ${params.companyName}`,
        html,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new ApiError(502, "EMAIL_DELIVERY_FAILED", `Invite email delivery failed: ${text}`);
    }

    return { delivery: "resend" as const };
  }

  console.log(`[INVITE_LINK] To: ${params.to} Company: ${params.companyName} Link: ${params.inviteLink}`);
  return { delivery: "console" as const };
}

async function createSession(userId: string, ttlDays = SESSION_TTL_DAYS) {
  const token = crypto.randomBytes(48).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await prisma.session.create({
    data: {
      userId,
      tokenHash,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

function serializeUser(user: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  companyId: string | null;
  isActive: boolean;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    companyId: user.companyId,
    isActive: user.isActive,
  };
}

async function resolveActorFromAuthorization(req: Request) {
  const authHeader = req.header("authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  const session = await prisma.session.findFirst({
    where: {
      tokenHash: sha256(token),
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!session) return null;

  await prisma.session.update({
    where: { id: session.id },
    data: { lastSeenAt: new Date() },
  });

  if (!session.user.isActive) {
    throw new ApiError(401, "USER_DISABLED", "User is inactive");
  }

  return session.user;
}

async function resolveActorFromLegacyEmailHeader(req: Request) {
  if ((process.env.ALLOW_LEGACY_AUTH ?? "false").toLowerCase() !== "true") {
    return null;
  }

  const email = normalizeEmail(req.header("x-user-email") || process.env.DEFAULT_USER_EMAIL || "");

  if (email) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) return user;
  }

  return null;
}

async function getActor(req: Request) {
  const fromAuth = await resolveActorFromAuthorization(req);
  if (fromAuth) return fromAuth;

  const fromLegacy = await resolveActorFromLegacyEmailHeader(req);
  if (fromLegacy) return fromLegacy;

  const first = await prisma.user.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!first) {
    throw Object.assign(new Error("No active user found. Run seed."), { status: 500 });
  }
  return first;
}

function assertHasCompany(user: { companyId: string | null }) {
  if (!user.companyId) throw new ApiError(403, "COMPANY_REQUIRED", "User is not linked to a company");
}

function assertRole(user: { role: UserRole }, roles: UserRole[]) {
  if (!roles.includes(user.role)) {
    throw new ApiError(403, "FORBIDDEN", "Insufficient permission");
  }
}

async function assertManagerCanCreateOperator(manager: { id: string; companyId: string | null }) {
  assertHasCompany(manager);
  const managedOperators = await prisma.user.count({
    where: {
      companyId: manager.companyId,
      managedById: manager.id,
      role: UserRole.OPERATOR,
      isActive: true,
    },
  });

  if (managedOperators >= MANAGER_MAX_SUBORDINATES) {
    throw new ApiError(
      409,
      "MANAGER_SUBORDINATE_LIMIT_REACHED",
      `Manager can only manage up to ${MANAGER_MAX_SUBORDINATES} operators`,
    );
  }
}

function parseMoneyToCents(input: unknown): number {
  if (input === undefined || input === null) return 0;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw Object.assign(new Error("Invalid value"), { status: 400 });
    return Math.round(input * 100);
  }
  throw Object.assign(new Error("Invalid value"), { status: 400 });
}

function parseOptionalDate(s?: string) {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw Object.assign(new Error("Invalid date"), { status: 400 });
  }
  return d;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

async function assertCategoryOwned(companyId: string, categoryId: string) {
  const category = await prisma.category.findFirst({ where: { id: categoryId, companyId }, select: { id: true } });
  if (!category) throw new ApiError(400, "CATEGORY_NOT_FOUND", "Category not found");
}

async function ensureCategory(companyId: string, categoryId?: string, categoryName?: string) {
  if (categoryId) {
    const cat = await prisma.category.findFirst({ where: { id: categoryId, companyId } });
    if (!cat) throw Object.assign(new Error("Category not found"), { status: 400 });
    return cat;
  }
  if (categoryName) {
    return prisma.category.upsert({
      where: { companyId_name: { companyId, name: categoryName } },
      create: { companyId, name: categoryName },
      update: {},
    });
  }
  throw Object.assign(new Error("categoryId or categoryName is required"), { status: 400 });
}

async function ensureSector(companyId: string, sectorId?: string, sectorName?: string) {
  if (sectorId) {
    const sec = await prisma.sector.findFirst({ where: { id: sectorId, companyId } });
    if (!sec) throw Object.assign(new Error("Sector not found"), { status: 400 });
    return sec;
  }
  if (sectorName) {
    return prisma.sector.upsert({
      where: { companyId_name: { companyId, name: sectorName } },
      create: { companyId, name: sectorName },
      update: {},
    });
  }
  return null;
}

async function ensureReason(companyId: string, reasonId?: string, reasonName?: string, categoryId?: string) {
  if (reasonId) {
    const rsn = await prisma.reason.findFirst({ where: { id: reasonId, companyId } });
    if (!rsn) throw Object.assign(new Error("Reason not found"), { status: 400 });
    return rsn;
  }
  if (reasonName) {
    // upsert por (companyId, name) — categoryId opcional
    return prisma.reason.upsert({
      where: { companyId_name: { companyId, name: reasonName } },
      create: { companyId, name: reasonName, categoryId: categoryId ?? null },
      update: categoryId ? { categoryId } : {},
    });
  }
  return null;
}

async function ensureItem(companyId: string, categoryId: string, itemId?: string, itemName?: string) {
  if (itemId) {
    const item = await prisma.item.findFirst({ where: { id: itemId, companyId } });
    if (!item) throw Object.assign(new Error("Item not found"), { status: 400 });
    if (item.categoryId !== categoryId) {
      throw Object.assign(new Error("Item does not belong to selected category"), { status: 400 });
    }
    return item;
  }
  if (itemName) {
    return prisma.item.upsert({
      where: { companyId_categoryId_name: { companyId, categoryId, name: itemName } },
      create: { companyId, categoryId, name: itemName },
      update: {},
    });
  }
  return null;
}

const createNamedSchema = z.object({
  name: z.string().trim().min(1).max(120),
  isActive: z.boolean().optional(),
  categoryId: z.string().uuid().optional(), // só para Reason
});

const requestLoginCodeSchema = z.object({
  email: z.string().email().transform((v) => normalizeEmail(v)),
});

const verifyLoginCodeSchema = z.object({
  email: z.string().email().transform((v) => normalizeEmail(v)),
  code: z.string().regex(/^\d{6}$/),
});

const loginPasswordSchema = z.object({
  email: z.string().email().transform((v) => normalizeEmail(v)),
  password: z.string().min(6).max(72),
});

const setPasswordSchema = z.object({
  email: z.string().email().transform((v) => normalizeEmail(v)),
  password: z.string().min(6).max(72),
  name: z.string().trim().min(1).max(120).optional(),
});

const createUserSchema = z.object({
  companyId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  email: z.string().email().transform((v) => normalizeEmail(v)),
  role: z.nativeEnum(UserRole),
  isActive: z.boolean().optional(),
});

const updateUserSchema = z
  .object({
    companyId: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(120).optional(),
    role: z.nativeEnum(UserRole).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.companyId !== undefined || v.name !== undefined || v.role !== undefined || v.isActive !== undefined, {
    message: "At least one field must be provided",
  });

const createInviteSchema = z.object({
  email: z.string().email().transform((v) => normalizeEmail(v)),
  role: z.nativeEnum(UserRole),
  name: z.string().trim().min(1).max(120).optional(),
});

const acceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  password: z.string().min(6).max(72),
});

const createLossEventSchema = z.object({
  occurredAt: z.string().optional(), // ISO
  // escolha por ID ou por nome (nome cria/pega)
  categoryId: z.string().uuid().optional(),
  categoryName: z.string().trim().min(1).max(120).optional(),

  itemId: z.string().uuid().optional(),
  itemName: z.string().trim().min(1).max(160).optional(),

  reasonId: z.string().uuid().optional(),
  reasonName: z.string().trim().min(1).max(120).optional(),

  sectorId: z.string().uuid().optional(),
  sectorName: z.string().trim().min(1).max(120).optional(),

  quantity: z.union([z.number(), z.string()]).optional(),

  valueCents: z.number().int().nonnegative().optional(),
  value: z.number().nonnegative().optional(), // em reais/dólares (ex: 12.50)

  notes: z.string().max(2000).optional(),
});

const updateCompanySchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  tradeName: z.string().trim().max(160).nullable().optional(),
  cnpj: z.string().trim().max(32).nullable().optional(),
});

const createGoalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  periodStart: z.string(),
  periodEnd: z.string(),
  targetValueCents: z.number().int().nonnegative(),
  categoryId: z.string().uuid().optional(),
  sectorId: z.string().uuid().optional(),
});

const createAttachmentSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(120),
  base64Data: z.string().trim().min(1),
});

const createItemSchema = z.object({
  categoryId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  isActive: z.boolean().optional(),
});

const updateNamedSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.isActive !== undefined, {
    message: "At least one field must be provided",
  });

const updateItemSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    name: z.string().trim().min(1).max(160).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => v.categoryId !== undefined || v.name !== undefined || v.isActive !== undefined, {
    message: "At least one field must be provided",
  });

const openApiDoc = {
  openapi: "3.0.3",
  info: {
    title: "Loss Control API",
    version: "1.0.0",
  },
  paths: {
    "/health": { get: { summary: "Health check" } },
    "/api/settings/categories": {
      get: { summary: "List categories" },
      post: { summary: "Create category" },
    },
    "/api/settings/categories/{id}": {
      patch: { summary: "Update category" },
      delete: { summary: "Deactivate category" },
    },
    "/api/settings/reasons": {
      get: { summary: "List reasons" },
      post: { summary: "Create reason" },
    },
    "/api/settings/reasons/{id}": {
      patch: { summary: "Update reason" },
      delete: { summary: "Deactivate reason" },
    },
    "/api/settings/sectors": {
      get: { summary: "List sectors" },
      post: { summary: "Create sector" },
    },
    "/api/settings/sectors/{id}": {
      patch: { summary: "Update sector" },
      delete: { summary: "Deactivate sector" },
    },
    "/api/settings/items": {
      get: { summary: "List items" },
      post: { summary: "Create item" },
    },
    "/api/settings/items/{id}": {
      patch: { summary: "Update item" },
      delete: { summary: "Deactivate item" },
    },
    "/api/loss-events": {
      get: { summary: "List loss events" },
      post: { summary: "Create loss event" },
    },
    "/api/loss-events/{id}": {
      get: { summary: "Get loss event" },
      delete: { summary: "Delete loss event" },
    },
    "/api/loss-events/{id}/attachments": {
      post: { summary: "Upload attachment image" },
    },
    "/api/reports/loss-events.csv": {
      get: { summary: "Export losses CSV" },
    },
  },
};

export async function registerRoutes(_httpServer: Server, app: Express): Promise<Server> {
  // health
  app.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, db: "ok" });
  });
  app.get("/api/docs/openapi.json", (_req, res) => {
    res.json(openApiDoc);
  });
  app.get("/api/docs", (_req, res) => {
    res.type("text/plain").send("OpenAPI JSON: /api/docs/openapi.json");
  });

  // -----------------------
  // AUTH
  // -----------------------
  app.post("/api/auth/request-login-code", async (req, res) => {
    const body = parseBody(requestLoginCodeSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive) {
      // Keep response generic to avoid user enumeration.
      return res.json({ status: "CODE_SENT_IF_ACCOUNT_EXISTS" });
    }

    if (!user.password) {
      return res.status(409).json({
        status: "FIRST_ACCESS_REQUIRED",
        message: "First access requires password setup.",
      });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await prisma.authCode.create({
      data: {
        userId: user.id,
        purpose: "LOGIN",
        codeHash: sha256(code),
        expiresAt,
      },
    });

    const delivered = await sendLoginCodeEmail(body.email, code);
    if (!delivered) {
      return res.status(409).json({
        status: "FIRST_ACCESS_REQUIRED",
        message: "Unable to deliver email code. Set password to continue.",
      });
    }

    res.json({
      status: "CODE_SENT",
      otpTtlMinutes: OTP_TTL_MINUTES,
    });
  });

  app.post("/api/auth/verify-login-code", async (req, res) => {
    const body = parseBody(verifyLoginCodeSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive) throw new ApiError(401, "INVALID_LOGIN", "Invalid login credentials");

    const authCode = await prisma.authCode.findFirst({
      where: {
        userId: user.id,
        purpose: "LOGIN",
        usedAt: null,
        expiresAt: { gt: new Date() },
        codeHash: sha256(body.code),
      },
      orderBy: { createdAt: "desc" },
    });

    if (!authCode) throw new ApiError(401, "INVALID_CODE", "Invalid or expired code");

    await prisma.authCode.update({
      where: { id: authCode.id },
      data: { usedAt: new Date() },
    });

    const session = await createSession(user.id);
    res.json({
      status: "AUTHENTICATED",
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt.toISOString(),
      user: serializeUser(user),
    });
  });

  app.post("/api/auth/login-password", async (req, res) => {
    const body = parseBody(loginPasswordSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive || !user.password) {
      throw new ApiError(401, "INVALID_LOGIN", "Invalid login credentials");
    }

    if (!verifyPassword(body.password, user.password)) {
      throw new ApiError(401, "INVALID_LOGIN", "Invalid login credentials");
    }

    const session = await createSession(user.id);
    res.json({
      status: "AUTHENTICATED",
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt.toISOString(),
      user: serializeUser(user),
    });
  });

  app.post("/api/auth/set-password", async (req, res) => {
    const body = parseBody(setPasswordSchema, req.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || !user.isActive) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashPassword(body.password),
        ...(body.name ? { name: body.name } : {}),
      },
    });

    const session = await createSession(updatedUser.id);
    res.json({
      status: "AUTHENTICATED",
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt.toISOString(),
      user: serializeUser(updatedUser),
    });
  });

  app.get("/api/auth/me", async (req, res) => {
    const actor = await getActor(req);
    res.json({ user: serializeUser(actor) });
  });

  app.post("/api/auth/logout", async (req, res) => {
    const authHeader = req.header("authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      const token = authHeader.slice(7).trim();
      if (token) {
        await prisma.session.updateMany({
          where: { tokenHash: sha256(token), revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }
    res.status(204).send();
  });

  // -----------------------
  // USER MANAGEMENT
  // -----------------------
  app.get("/api/users", async (req, res) => {
    const actor = await getActor(req);

    const where =
      actor.role === UserRole.SUPER_ADMIN
        ? {}
        : actor.role === UserRole.COMPANY_ADMIN
        ? { companyId: actor.companyId }
        : actor.role === UserRole.MANAGER
        ? {
            companyId: actor.companyId,
            OR: [{ id: actor.id }, { managedById: actor.id }],
          }
        : { id: actor.id };

    const items = await prisma.user.findMany({
      where,
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ items });
  });

  app.post("/api/users", async (req, res) => {
    const actor = await getActor(req);
    assertRole(actor, [UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN, UserRole.MANAGER]);

    const body = parseBody(createUserSchema, req.body);

    const companyId =
      actor.role === UserRole.SUPER_ADMIN
        ? body.companyId ?? null
        : actor.companyId;

    if (!companyId) throw new ApiError(400, "COMPANY_REQUIRED", "companyId is required");
    if (actor.role !== UserRole.SUPER_ADMIN && body.role === UserRole.SUPER_ADMIN) {
      throw new ApiError(403, "FORBIDDEN", "Only super admin can create super admin users");
    }
    if (actor.role === UserRole.MANAGER) {
      if (body.role !== UserRole.OPERATOR) {
        throw new ApiError(403, "FORBIDDEN", "Manager can only create operator users");
      }
      await assertManagerCanCreateOperator(actor);
    }

    const created = await prisma.user.create({
      data: {
        companyId,
        managedById: actor.role === UserRole.MANAGER ? actor.id : null,
        name: body.name,
        email: body.email,
        password: null,
        role: body.role,
        isActive: body.isActive ?? true,
      },
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json(created);
  });

  app.patch("/api/users/:id", async (req, res) => {
    const actor = await getActor(req);
    assertRole(actor, [UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN, UserRole.MANAGER]);

    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(updateUserSchema, req.body);

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

    if (actor.role !== UserRole.SUPER_ADMIN) {
      if (!actor.companyId || existing.companyId !== actor.companyId) {
        throw new ApiError(403, "FORBIDDEN", "Cannot manage users from another company");
      }
      if (body.role === UserRole.SUPER_ADMIN) {
        throw new ApiError(403, "FORBIDDEN", "Only super admin can grant super admin role");
      }
      if (existing.role === UserRole.SUPER_ADMIN) {
        throw new ApiError(403, "FORBIDDEN", "Super admin user can only be managed by super admin");
      }
      if (actor.role === UserRole.MANAGER) {
        if (existing.role !== UserRole.OPERATOR || existing.managedById !== actor.id) {
          throw new ApiError(403, "FORBIDDEN", "Manager can only manage own operator subusers");
        }
        if (body.role !== undefined && body.role !== UserRole.OPERATOR) {
          throw new ApiError(403, "FORBIDDEN", "Manager cannot change operator role");
        }
        if (body.companyId !== undefined) {
          throw new ApiError(403, "FORBIDDEN", "Manager cannot reassign company");
        }
      }
    }

    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(body.companyId !== undefined ? { companyId: body.companyId } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(updated);
  });

  app.delete("/api/users/:id", async (req, res) => {
    const actor = await getActor(req);
    assertRole(actor, [UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN, UserRole.MANAGER]);
    const id = z.string().uuid().parse(req.params.id);

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) throw new ApiError(404, "USER_NOT_FOUND", "User not found");

    if (actor.role !== UserRole.SUPER_ADMIN) {
      if (!actor.companyId || existing.companyId !== actor.companyId) {
        throw new ApiError(403, "FORBIDDEN", "Cannot manage users from another company");
      }
      if (existing.role === UserRole.SUPER_ADMIN) {
        throw new ApiError(403, "FORBIDDEN", "Super admin user can only be managed by super admin");
      }
      if (actor.role === UserRole.MANAGER) {
        if (existing.role !== UserRole.OPERATOR || existing.managedById !== actor.id) {
          throw new ApiError(403, "FORBIDDEN", "Manager can only deactivate own operator subusers");
        }
      }
    }

    await prisma.user.update({
      where: { id },
      data: { isActive: false },
    });

    res.status(204).send();
  });

  app.get("/api/admin/users", async (req, res) => {
    const actor = await getActor(req);
    assertRole(actor, [UserRole.SUPER_ADMIN]);

    const items = await prisma.user.findMany({
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        companyId: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json({ items });
  });

  app.post("/api/users/invite", async (req, res) => {
    const actor = await getActor(req);
    assertRole(actor, [UserRole.COMPANY_ADMIN, UserRole.SUPER_ADMIN, UserRole.MANAGER]);
    assertHasCompany(actor);

    const body = parseBody(createInviteSchema, req.body);

    if (actor.role !== UserRole.SUPER_ADMIN && body.role === UserRole.SUPER_ADMIN) {
      throw new ApiError(403, "FORBIDDEN", "Only super admin can invite super admin users");
    }
    if (actor.role === UserRole.MANAGER) {
      if (body.role !== UserRole.OPERATOR) {
        throw new ApiError(403, "FORBIDDEN", "Manager can only invite operator users");
      }
      await assertManagerCanCreateOperator(actor);
    }

    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    await prisma.invite.updateMany({
      where: {
        companyId: actor.companyId!,
        email: body.email,
        acceptedAt: null,
      },
      data: {
        expiresAt: new Date(),
      },
    });

    const invite = await prisma.invite.create({
      data: {
        companyId: actor.companyId!,
        invitedById: actor.id,
        email: body.email,
        role: body.role,
        token,
        expiresAt,
      },
    });

    const company = await prisma.company.findUnique({
      where: { id: actor.companyId! },
      select: { name: true },
    });

    const frontendBase = (process.env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, "");
    const inviteLink = `${frontendBase}/convite?token=${encodeURIComponent(invite.token)}`;

    const delivery = await sendInviteEmail({
      to: body.email,
      companyName: company?.name ?? "Loss Control",
      invitedByName: actor.name,
      inviteLink,
    });

    res.status(201).json({
      status: "INVITE_SENT",
      delivery: delivery.delivery,
      invite: {
        id: invite.id,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
      },
    });
  });

  app.get("/api/invites/:token", async (req, res) => {
    const token = z.string().min(16).parse(req.params.token);

    const invite = await prisma.invite.findUnique({
      where: { token },
      include: {
        company: { select: { name: true } },
      },
    });

    if (!invite) throw new ApiError(404, "INVITE_NOT_FOUND", "Invite not found");
    if (invite.acceptedAt) throw new ApiError(409, "INVITE_ALREADY_ACCEPTED", "Invite already accepted");
    if (invite.expiresAt.getTime() <= Date.now()) throw new ApiError(410, "INVITE_EXPIRED", "Invite expired");

    res.json({
      invite: {
        email: invite.email,
        role: invite.role,
        companyName: invite.company.name,
        expiresAt: invite.expiresAt.toISOString(),
      },
    });
  });

  app.post("/api/invites/:token/accept", async (req, res) => {
    const token = z.string().min(16).parse(req.params.token);
    const body = parseBody(acceptInviteSchema, req.body);

    const invite = await prisma.invite.findUnique({
      where: { token },
    });

    if (!invite) throw new ApiError(404, "INVITE_NOT_FOUND", "Invite not found");
    if (invite.acceptedAt) throw new ApiError(409, "INVITE_ALREADY_ACCEPTED", "Invite already accepted");
    if (invite.expiresAt.getTime() <= Date.now()) throw new ApiError(410, "INVITE_EXPIRED", "Invite expired");

    const existing = await prisma.user.findUnique({ where: { email: invite.email } });
    if (existing && existing.companyId && existing.companyId !== invite.companyId) {
      throw new ApiError(409, "EMAIL_ALREADY_IN_USE", "Email already belongs to another company");
    }
    if (invite.role === UserRole.OPERATOR && invite.invitedById) {
      const manager = await prisma.user.findUnique({ where: { id: invite.invitedById } });
      if (manager?.role === UserRole.MANAGER) {
        const shouldCountNewSubordinate = !existing || existing.managedById !== invite.invitedById;
        if (shouldCountNewSubordinate) {
          await assertManagerCanCreateOperator(manager);
        }
      }
    }

    const user = existing
      ? await prisma.user.update({
          where: { id: existing.id },
          data: {
            companyId: invite.companyId,
            managedById: invite.role === UserRole.OPERATOR ? invite.invitedById ?? null : null,
            name: body.name,
            password: hashPassword(body.password),
            role: invite.role,
            isActive: true,
          },
        })
      : await prisma.user.create({
          data: {
            companyId: invite.companyId,
            managedById: invite.role === UserRole.OPERATOR ? invite.invitedById ?? null : null,
            name: body.name,
            email: invite.email,
            password: hashPassword(body.password),
            role: invite.role,
            isActive: true,
          },
        });

    await prisma.invite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date() },
    });

    const session = await createSession(user.id);
    res.json({
      status: "AUTHENTICATED",
      accessToken: session.token,
      tokenType: "Bearer",
      expiresAt: session.expiresAt.toISOString(),
      user: serializeUser(user),
    });
  });

  // -----------------------
  // SETTINGS (MVP)
  // -----------------------
  app.get("/api/settings/categories", async (req, res) => {
    const actor = await getActor(req);
    const items = await prisma.category.findMany({
      where: { companyId: actor.companyId! },
      orderBy: { name: "asc" },
    });
    res.json({ items });
  });

  app.post("/api/settings/categories", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(createNamedSchema, req.body);

    const created = await prisma.category.create({
      data: {
        companyId: actor.companyId!,
        name: body.name,
        isActive: body.isActive ?? true,
      },
    });
    res.status(201).json(created);
  });

  app.patch("/api/settings/categories/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(updateNamedSchema, req.body);

    const updated = await prisma.category.updateMany({
      where: { id, companyId: actor.companyId! },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    if (updated.count === 0) throw new ApiError(404, "CATEGORY_NOT_FOUND", "Category not found");
    const item = await prisma.category.findUnique({ where: { id } });
    res.json(item);
  });

  app.delete("/api/settings/categories/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const updated = await prisma.category.updateMany({
      where: { id, companyId: actor.companyId! },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ApiError(404, "CATEGORY_NOT_FOUND", "Category not found");
    res.status(204).send();
  });

  app.get("/api/settings/sectors", async (req, res) => {
    const actor = await getActor(req);
    const items = await prisma.sector.findMany({
      where: { companyId: actor.companyId! },
      orderBy: { name: "asc" },
    });
    res.json({ items });
  });

  app.post("/api/settings/sectors", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(createNamedSchema, req.body);

    const created = await prisma.sector.create({
      data: {
        companyId: actor.companyId!,
        name: body.name,
        isActive: body.isActive ?? true,
      },
    });
    res.status(201).json(created);
  });

  app.patch("/api/settings/sectors/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(updateNamedSchema, req.body);
    const updated = await prisma.sector.updateMany({
      where: { id, companyId: actor.companyId! },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    if (updated.count === 0) throw new ApiError(404, "SECTOR_NOT_FOUND", "Sector not found");
    const item = await prisma.sector.findUnique({ where: { id } });
    res.json(item);
  });

  app.delete("/api/settings/sectors/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const updated = await prisma.sector.updateMany({
      where: { id, companyId: actor.companyId! },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ApiError(404, "SECTOR_NOT_FOUND", "Sector not found");
    res.status(204).send();
  });

  app.get("/api/settings/reasons", async (req, res) => {
    const actor = await getActor(req);
    const items = await prisma.reason.findMany({
      where: { companyId: actor.companyId! },
      orderBy: { name: "asc" },
    });
    res.json({ items });
  });

  app.post("/api/settings/reasons", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(createNamedSchema, req.body);
    if (body.categoryId) await assertCategoryOwned(actor.companyId!, body.categoryId);

    const created = await prisma.reason.create({
      data: {
        companyId: actor.companyId!,
        name: body.name,
        categoryId: body.categoryId ?? null,
        isActive: body.isActive ?? true,
      },
    });
    res.status(201).json(created);
  });

  app.patch("/api/settings/reasons/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(
      z
        .object({
          name: z.string().trim().min(1).max(120).optional(),
          isActive: z.boolean().optional(),
          categoryId: z.string().uuid().nullable().optional(),
        })
        .refine((v) => v.name !== undefined || v.isActive !== undefined || v.categoryId !== undefined, {
          message: "At least one field must be provided",
        }),
      req.body,
    );

    if (body.categoryId) await assertCategoryOwned(actor.companyId!, body.categoryId);
    const updated = await prisma.reason.updateMany({
      where: { id, companyId: actor.companyId! },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
      },
    });
    if (updated.count === 0) throw new ApiError(404, "REASON_NOT_FOUND", "Reason not found");
    const item = await prisma.reason.findUnique({ where: { id } });
    res.json(item);
  });

  app.delete("/api/settings/reasons/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const updated = await prisma.reason.updateMany({
      where: { id, companyId: actor.companyId! },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ApiError(404, "REASON_NOT_FOUND", "Reason not found");
    res.status(204).send();
  });

  app.get("/api/settings/items", async (req, res) => {
    const actor = await getActor(req);
    const q = z.object({
      categoryId: z.string().uuid().optional(),
    }).parse(req.query);

    const items = await prisma.item.findMany({
      where: {
        companyId: actor.companyId!,
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      },
      orderBy: [{ name: "asc" }],
    });
    res.json({ items });
  });

  app.post("/api/settings/items", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(createItemSchema, req.body);
    await assertCategoryOwned(actor.companyId!, body.categoryId);

    const created = await prisma.item.create({
      data: {
        companyId: actor.companyId!,
        categoryId: body.categoryId,
        name: body.name,
        isActive: body.isActive ?? true,
      },
    });
    res.status(201).json(created);
  });

  app.patch("/api/settings/items/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(updateItemSchema, req.body);

    if (body.categoryId) await assertCategoryOwned(actor.companyId!, body.categoryId);
    const updated = await prisma.item.updateMany({
      where: { id, companyId: actor.companyId! },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
      },
    });
    if (updated.count === 0) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found");
    const item = await prisma.item.findUnique({ where: { id } });
    res.json(item);
  });

  app.delete("/api/settings/items/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const updated = await prisma.item.updateMany({
      where: { id, companyId: actor.companyId! },
      data: { isActive: false },
    });
    if (updated.count === 0) throw new ApiError(404, "ITEM_NOT_FOUND", "Item not found");
    res.status(204).send();
  });

  // -----------------------
  // COMPANY
  // -----------------------
  app.get("/api/company", async (req, res) => {
    const actor = await getActor(req);
    const company = await prisma.company.findUnique({
      where: { id: actor.companyId! },
      select: {
        id: true,
        name: true,
        tradeName: true,
        cnpj: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!company) throw new ApiError(404, "COMPANY_NOT_FOUND", "Company not found");
    res.json(company);
  });

  app.patch("/api/company", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(updateCompanySchema, req.body);

    const updated = await prisma.company.update({
      where: { id: actor.companyId! },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.tradeName !== undefined ? { tradeName: body.tradeName } : {}),
        ...(body.cnpj !== undefined ? { cnpj: body.cnpj } : {}),
      },
      select: {
        id: true,
        name: true,
        tradeName: true,
        cnpj: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.json(updated);
  });

  // -----------------------
  // GOALS
  // -----------------------
  app.get("/api/goals", async (req, res) => {
    const actor = await getActor(req);

    const q = z.object({
      periodStart: z.string().optional(),
      periodEnd: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      sectorId: z.string().uuid().optional(),
    }).parse(req.query);

    const periodStart = parseOptionalDate(q.periodStart);
    const periodEnd = parseOptionalDate(q.periodEnd);

    const items = await prisma.goal.findMany({
      where: {
        companyId: actor.companyId!,
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.sectorId ? { sectorId: q.sectorId } : {}),
        ...(periodStart || periodEnd
          ? {
              periodStart: { ...(periodStart ? { gte: periodStart } : {}) },
              periodEnd: { ...(periodEnd ? { lte: periodEnd } : {}) },
            }
          : {}),
      },
      orderBy: [{ periodEnd: "desc" }, { createdAt: "desc" }],
    });

    res.json({ items });
  });

  app.post("/api/goals", async (req, res) => {
    const actor = await getActor(req);
    const body = parseBody(createGoalSchema, req.body);

    const periodStart = parseOptionalDate(body.periodStart);
    const periodEnd = parseOptionalDate(body.periodEnd);
    if (!periodStart || !periodEnd) {
      throw new ApiError(400, "INVALID_PERIOD", "Invalid periodStart or periodEnd");
    }
    if (periodEnd < periodStart) {
      throw new ApiError(400, "INVALID_PERIOD", "periodEnd must be after periodStart");
    }

    if (body.categoryId) {
      const category = await prisma.category.findFirst({
        where: { id: body.categoryId, companyId: actor.companyId! },
        select: { id: true },
      });
      if (!category) throw new ApiError(400, "CATEGORY_NOT_FOUND", "Category not found");
    }

    if (body.sectorId) {
      const sector = await prisma.sector.findFirst({
        where: { id: body.sectorId, companyId: actor.companyId! },
        select: { id: true },
      });
      if (!sector) throw new ApiError(400, "SECTOR_NOT_FOUND", "Sector not found");
    }

    const created = await prisma.goal.create({
      data: {
        companyId: actor.companyId!,
        name: body.name,
        periodStart,
        periodEnd,
        targetValueCents: body.targetValueCents,
        categoryId: body.categoryId ?? null,
        sectorId: body.sectorId ?? null,
      },
    });

    res.status(201).json(created);
  });

  // -----------------------
  // LOSS EVENTS (CRUD)
  // -----------------------
  app.post("/api/loss-events", async (req, res) => {
    const actor = await getActor(req);
    const b = parseBody(createLossEventSchema, req.body);

    // valor
    const valueCents =
      b.valueCents !== undefined ? b.valueCents :
      b.value !== undefined ? parseMoneyToCents(b.value) :
      0;

    // occurredAt
    const occurredAt = parseOptionalDate(b.occurredAt) ?? new Date();

    // category (obrigatório)
    const category = await ensureCategory(actor.companyId!, b.categoryId, b.categoryName);
    const item = await ensureItem(actor.companyId!, category.id, b.itemId, b.itemName);
    if (!item) throw new ApiError(400, "ITEM_REQUIRED", "itemId or itemName is required");

    // sector (opcional)
    const sector = await ensureSector(actor.companyId!, b.sectorId, b.sectorName);

    // reason (opcional) — pode receber categoryId pra amarrar
    const reason = await ensureReason(actor.companyId!, b.reasonId, b.reasonName, category.id);

    const quantity =
      b.quantity === undefined ? null :
      typeof b.quantity === "number" ? String(b.quantity) :
      String(b.quantity);

    const created = await prisma.lossEvent.create({
      data: {
        companyId: actor.companyId!,
        createdById: actor.id,
        occurredAt,
        categoryId: category.id,
        itemId: item?.id ?? null,
        reasonId: reason?.id ?? null,
        sectorId: sector?.id ?? null,
        quantity,
        valueCents,
        notes: b.notes ?? null,
      },
      include: {
        item: true,
        category: true,
        reason: true,
        sector: true,
        createdBy: { select: { id: true, name: true, email: true, role: true } },
        attachments: true,
      },
    });

    res.status(201).json(created);
  });

  app.get("/api/loss-events", async (req, res) => {
    const actor = await getActor(req);

    const q = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      itemId: z.string().uuid().optional(),
      reasonId: z.string().uuid().optional(),
      sectorId: z.string().uuid().optional(),
      createdById: z.string().uuid().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }).parse(req.query);

    const from = parseOptionalDate(q.from);
    const to = parseOptionalDate(q.to);

    const limit = Math.min(Math.max(parseInt(q.limit ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(q.offset ?? "0", 10) || 0, 0);

    const where: any = {
      companyId: actor.companyId!,
      ...(q.categoryId ? { categoryId: q.categoryId } : {}),
      ...(q.itemId ? { itemId: q.itemId } : {}),
      ...(q.reasonId ? { reasonId: q.reasonId } : {}),
      ...(q.sectorId ? { sectorId: q.sectorId } : {}),
      ...(q.createdById ? { createdById: q.createdById } : {}),
      ...(from || to
        ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    };

    const [total, items] = await Promise.all([
      prisma.lossEvent.count({ where }),
      prisma.lossEvent.findMany({
        where,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: limit,
        skip: offset,
        include: {
          item: true,
          category: true,
          reason: true,
          sector: true,
          createdBy: { select: { id: true, name: true, email: true, role: true } },
          attachments: true,
        },
      }),
    ]);

    res.json({ total, limit, offset, items });
  });

  app.get("/api/loss-events/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);

    const item = await prisma.lossEvent.findFirst({
      where: { id, companyId: actor.companyId! },
      include: {
        item: true,
        category: true,
        reason: true,
        sector: true,
        createdBy: { select: { id: true, name: true, email: true, role: true } },
        attachments: true,
      },
    });

    if (!item) throw new ApiError(404, "LOSS_EVENT_NOT_FOUND", "Not found");
    res.json(item);
  });

  app.delete("/api/loss-events/:id", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);

    // garante que é da mesma company
    const existing = await prisma.lossEvent.findFirst({
      where: { id, companyId: actor.companyId! },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, "LOSS_EVENT_NOT_FOUND", "Not found");

    await prisma.lossEvent.delete({ where: { id } });
    res.status(204).send();
  });

  app.post("/api/loss-events/:id/attachments", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const body = parseBody(createAttachmentSchema, req.body);

    const existing = await prisma.lossEvent.findFirst({
      where: { id, companyId: actor.companyId! },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, "LOSS_EVENT_NOT_FOUND", "Loss event not found");

    const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (!allowedMimeTypes.has(body.mimeType)) throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", "Unsupported file type");

    const buffer = Buffer.from(body.base64Data, "base64");
    if (!buffer.length) throw new ApiError(400, "EMPTY_FILE", "Empty file");
    if (buffer.length > 5 * 1024 * 1024) {
      throw new ApiError(400, "FILE_TOO_LARGE", "File too large (max 5MB)");
    }

    const company = await prisma.company.findUnique({
      where: { id: actor.companyId! },
      select: { name: true },
    });

    const uploaded = await uploadLossEventImage({
      companyId: actor.companyId!,
      companyName: company?.name,
      userId: actor.id,
      lossEventId: id,
      mimeType: body.mimeType,
      originalFileName: body.fileName,
      buffer,
    });

    const created = await prisma.attachment.create({
      data: {
        lossEventId: id,
        storageKey: uploaded.storageKey,
        url: uploaded.url,
        mimeType: body.mimeType,
        sizeBytes: buffer.length,
      },
    });

    res.status(201).json(created);
  });

  app.delete("/api/loss-events/:id/attachments/:attachmentId", async (req, res) => {
    const actor = await getActor(req);
    const id = z.string().uuid().parse(req.params.id);
    const attachmentId = z.string().uuid().parse(req.params.attachmentId);

    // garante que o loss event pertence à company do ator
    const existing = await prisma.lossEvent.findFirst({
      where: { id, companyId: actor.companyId! },
      select: { id: true },
    });
    if (!existing) throw new ApiError(404, "LOSS_EVENT_NOT_FOUND", "Loss event not found");

    const attachment = await prisma.attachment.findFirst({
      where: { id: attachmentId, lossEventId: id },
    });
    if (!attachment) throw new ApiError(404, "ATTACHMENT_NOT_FOUND", "Attachment not found");

    // remove do storage (local ou GCS)
    await deleteLossEventImage(attachment.storageKey);

    // remove do banco
    await prisma.attachment.delete({ where: { id: attachmentId } });

    res.status(204).send();
  });

  // -----------------------
  // REPORTS
  // -----------------------
  app.get("/api/reports/loss-events.csv", async (req, res) => {
    const actor = await getActor(req);
    const q = z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      categoryId: z.string().uuid().optional(),
      itemId: z.string().uuid().optional(),
      reasonId: z.string().uuid().optional(),
      sectorId: z.string().uuid().optional(),
      createdById: z.string().uuid().optional(),
    }).parse(req.query);

    const from = parseOptionalDate(q.from);
    const to = parseOptionalDate(q.to);

    const items = await prisma.lossEvent.findMany({
      where: {
        companyId: actor.companyId!,
        ...(q.categoryId ? { categoryId: q.categoryId } : {}),
        ...(q.itemId ? { itemId: q.itemId } : {}),
        ...(q.reasonId ? { reasonId: q.reasonId } : {}),
        ...(q.sectorId ? { sectorId: q.sectorId } : {}),
        ...(q.createdById ? { createdById: q.createdById } : {}),
        ...(from || to
          ? { occurredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      include: {
        item: true,
        category: true,
        reason: true,
        sector: true,
        createdBy: { select: { name: true, email: true, role: true } },
      },
      take: 5000,
    });

    const esc = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const header = [
      "id",
      "occurredAt",
      "item",
      "category",
      "reason",
      "sector",
      "operator",
      "operatorEmail",
      "operatorRole",
      "quantity",
      "valueCents",
      "notes",
    ].join(",");
    const lines = items.map((it) =>
      [
        esc(it.id),
        esc(it.occurredAt.toISOString()),
        esc(it.item?.name ?? ""),
        esc(it.category?.name ?? ""),
        esc(it.reason?.name ?? ""),
        esc(it.sector?.name ?? ""),
        esc(it.createdBy?.name ?? ""),
        esc(it.createdBy?.email ?? ""),
        esc(it.createdBy?.role ?? ""),
        esc(it.quantity?.toString() ?? ""),
        esc(it.valueCents),
        esc(it.notes ?? ""),
      ].join(","),
    );
    const csv = [header, ...lines].join("\n");
    const now = new Date().toISOString().slice(0, 10);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="loss-events-${now}.csv"`);
    res.status(200).send(csv);
  });

  return _httpServer;
}



