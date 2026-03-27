require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security middleware ──────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: "10kb" }));
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// Rate limiting — 10 analyses per IP per hour (each analysis is expensive)
const analysisLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: "Too many requests. Please try again in an hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Anthropic client ─────────────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Health check ─────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ status: "ok", version: "1.0.0", service: "RankLens API" });
});

// ── Main analysis endpoint ────────────────────────────────────────────
app.post("/api/analyze", analysisLimiter, async (req, res) => {
  const { primaryUrl, competitors = [], location = "India" } = req.body;

  // Validate input
  if (!primaryUrl || typeof primaryUrl !== "string") {
    return res.status(400).json({ error: "primaryUrl is required." });
  }
  if (primaryUrl.length > 200) {
    return res.status(400).json({ error: "URL too long." });
  }
  if (!Array.isArray(competitors) || competitors.length > 5) {
    return res.status(400).json({ error: "Maximum 5 competitors allowed." });
  }

  const competitorLine =
    competitors.filter(Boolean).length > 0
      ? competitors.filter(Boolean).join(", ")
      : "auto-detect 3 real competitors for this site's industry and niche";

  const prompt = `You are a senior SEO data analyst with deep knowledge of Google search rankings, domain authority metrics, and competitive SEO strategy. Perform a detailed, realistic SEO competitive analysis.

PRIMARY SITE: ${primaryUrl}
COMPETITORS: ${competitorLine}
TARGET LOCATION: ${location}

INSTRUCTIONS:
- Use your real knowledge of these domains if you recognize them
- If you don't recognize a domain, make realistic estimates based on its apparent industry/niche
- All numbers must be realistic — don't exaggerate
- Keywords must be real search queries people use in ${location}
- Best practices and improvements must be specific and actionable, not generic

Return ONLY a valid raw JSON object — no markdown fences, no explanation, no preamble. Just the JSON:

{
  "industry": "short industry label e.g. E-commerce / Fashion",
  "summary": "2 specific sentences describing the competitive landscape and primary site's position",
  "primarySite": {
    "domain": "${primaryUrl}",
    "name": "Brand name",
    "da": 1-100,
    "traffic": monthly organic visits as integer,
    "keywords": total keywords ranked as integer,
    "backlinks": referring domains as integer,
    "pageSpeed": 1-100,
    "contentScore": 1-100,
    "mobileScore": 1-100,
    "technicalScore": 1-100,
    "topKw": [
      {"kw": "real keyword", "pos": position number, "vol": monthly volume, "trend": "up|down|stable"}
    ],
    "bestPractices": ["specific practice 1", "specific practice 2", "specific practice 3", "specific practice 4", "specific practice 5"],
    "improvements": ["specific improvement 1", "specific improvement 2", "specific improvement 3", "specific improvement 4", "specific improvement 5"]
  },
  "competitors": [
    {
      "domain": "domain.com",
      "name": "Brand Name",
      "da": number,
      "traffic": number,
      "keywords": number,
      "backlinks": number,
      "pageSpeed": number,
      "contentScore": number,
      "mobileScore": number,
      "technicalScore": number,
      "topKw": [{"kw": "keyword", "pos": number, "vol": number, "trend": "up|down|stable"}],
      "bestPractices": ["5 specific practices"],
      "improvements": ["5 specific improvements"],
      "edgeOver": ["3 specific SEO advantages this competitor has over the primary site — be precise with data"]
    }
  ],
  "opportunities": [
    {"title": "Title", "desc": "Specific description", "priority": "high|medium|low", "impact": "expected outcome with numbers if possible"}
  ]
}

RULES:
- topKw must have exactly 10 items for each site
- competitors array must have exactly 3 entries (auto-detect if not provided)
- opportunities must have exactly 6 items
- trend values: only "up", "down", or "stable"
- priority values: only "high", "medium", or "low"
- ALL numbers must be plain integers, no strings, no commas
- da values: realistic range 1-80 (most sites are 10-50)
- keywords: realistic (small sites 100-2000, large sites 5000-50000)
- traffic: realistic monthly visits`;

  try {
    console.log(`[${new Date().toISOString()}] Analyzing: ${primaryUrl} | Competitors: ${competitorLine} | Location: ${location}`);

    const message = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    // Robustly extract JSON
    const jsonStart = raw.indexOf("{");
    const jsonEnd = raw.lastIndexOf("}");
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error("No valid JSON found in AI response");
    }

    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));

    // Basic validation
    if (!parsed.primarySite || !parsed.competitors || !parsed.opportunities) {
      throw new Error("Incomplete data returned by AI");
    }

    console.log(`[${new Date().toISOString()}] Success: ${primaryUrl}`);
    res.json({ success: true, data: parsed });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: "API authentication failed. Check your ANTHROPIC_API_KEY." });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: "AI API rate limit reached. Please try again in a minute." });
    }
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: "Failed to parse AI response. Please try again." });
    }

    res.status(500).json({ error: "Analysis failed: " + err.message });
  }
});

// ── Start server ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 RankLens API running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
  console.log(`   Analyze: POST http://localhost:${PORT}/api/analyze\n`);
});
// Keep-alive ping every 14 minutes to prevent Render sleep
if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    require('https').get(process.env.RENDER_EXTERNAL_URL + '/health', () => {}).on('error', () => {});
  }, 14 * 60 * 1000);
}
