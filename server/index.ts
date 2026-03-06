import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import cors from "cors";
import path from "node:path";
import { normalizeError } from "./http/errors";
import { createRateLimitMiddleware } from "./http/rate-limit";


const app = express();
const httpServer = createServer(app);
app.set("trust proxy", true);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
    cors({
    origin: (origin: any, cb: any) => {
      const allowedByDefault = [
        /^http:\/\/localhost:\d+$/,
        /^http:\/\/127\.0\.0\.1:\d+$/,
        /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/,
        /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/,
        /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}:\d+$/,
      ];
      const extraOrigins = (process.env.FRONTEND_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (!origin) return cb(null, true);
      if (extraOrigins.includes(origin)) return cb(null, true);
      if (allowedByDefault.some((rx) => rx.test(origin))) return cb(null, true);

      return cb(null, false);
    },
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "x-user-email"],
  }),
  express.json({
    limit: process.env.JSON_LIMIT || "8mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));
app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));
app.use(
  "/api",
  createRateLimitMiddleware({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_MAX ?? 120),
  }),
);

export function log(message: string, source = "api") {
  const formattedTime = new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    if (req.path.startsWith("/api") || req.path === "/health") {
      log(`${req.method} ${req.path} ${res.statusCode} in ${duration}ms`);
    }
  });
  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    console.error(err);
    if (res.headersSent) return next(err);
    const normalized = normalizeError(err);
    return res.status(normalized.status).json(normalized.body);
  });

  const port = parseInt(process.env.PORT || "3001", 10);
  const host = process.env.HOST || "0.0.0.0";

  httpServer.listen({ port, host }, () => {
    log(`API listening on http://${host}:${port}`);
  });
})();
