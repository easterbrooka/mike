import { Router } from "express";
import { requireAuth } from "../middleware/auth";

export const systemRouter = Router();

// GET /system/llm-providers
// Reports which LLM providers are configured at the system (env var) level.
// Frontend uses this to enable models for users who haven't set a personal key.
systemRouter.get("/llm-providers", requireAuth, (_req, res) => {
  res.json({
    claude: !!process.env.ANTHROPIC_API_KEY?.trim(),
    gemini: !!process.env.GEMINI_API_KEY?.trim(),
  });
});
