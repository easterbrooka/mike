import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { downloadsRouter } from "./routes/downloads";
import { systemRouter } from "./routes/system";
import { assertKmsConfigured } from "./lib/crypto/kms";

// Fail fast in production if the envelope-encryption inputs are missing —
// otherwise the first request that needs to seal/open ciphertext would
// surface the misconfiguration as a 500 instead of a startup error.
if (process.env.NODE_ENV === "production") {
  assertKmsConfigured();
  if (!process.env.EMAIL_HMAC_PEPPER) {
    throw new Error(
      "EMAIL_HMAC_PEPPER must be set in production (32 bytes hex from Secrets Manager mike/email-hmac-pepper)",
    );
  }
}

const app = express();
const PORT = process.env.PORT ?? 3001;

const allowedOrigins = (process.env.FRONTEND_URL ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Security headers. Most of helmet's defaults are aimed at HTML responses;
// this is a JSON API so we keep CSP off (it has no use here and would
// mostly produce noisy reports) but HSTS + frame/nosniff/referrer
// protections are worth setting. HSTS is the load-bearing one — it tells
// browsers to never speak HTTP to this origin again.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  }),
);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) cb(null, true);
      else cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use(express.json({ limit: "50mb" }));

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);
app.use("/system", systemRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});
