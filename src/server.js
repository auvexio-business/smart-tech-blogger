import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { google } from "googleapis";
import { randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

const required = [
  "SESSION_SECRET",
  "DATABASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI"
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.warn(`Missing environment variables: ${missing.join(", ")}`);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined
});

const PgSession = connectPgSimple(session);
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(session({
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true
  }),
  name: "smarttech.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

function oauthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function requireGoogleAuth(req, res, next) {
  if (!req.session.googleTokens?.refresh_token && !req.session.googleTokens?.access_token) {
    return res.status(401).json({
      error: "google_auth_required",
      message: "Connect your Google account first at /auth/google"
    });
  }
  next();
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "smart-tech-blogger" });
});

app.get("/auth/google", authLimiter, (req, res) => {
  const state = randomBytes(32).toString("hex");
  req.session.oauthState = state;
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    scope: [process.env.BLOGGER_SCOPE || "https://www.googleapis.com/auth/blogger"],
    state
  });
  res.redirect(url);
});

app.get("/auth/google/callback", authLimiter, async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).json({ error: "google_oauth_denied" });
  if (!safeEqual(state, req.session.oauthState)) {
    return res.status(400).json({ error: "invalid_oauth_state" });
  }
  delete req.session.oauthState;

  try {
    const { tokens } = await oauthClient().getToken(String(code || ""));
    req.session.googleTokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || req.session.googleTokens?.refresh_token,
      scope: tokens.scope,
      token_type: tokens.token_type,
      expiry_date: tokens.expiry_date
    };
    try {
      await persistBloggerCredentials(req.session.googleTokens);
    } catch (persistError) {
      console.error("Could not persist Blogger automation credentials:", persistError.message);
    }
    res.json({
      connected: true,
      message: "Google authorization completed. You can now inspect your Blogger blogs at /api/blogs."
    });
  } catch (err) {
    console.error("OAuth callback failed:", err.message);
    res.status(500).json({ error: "oauth_exchange_failed" });
  }
});

app.get("/api/status", (req, res) => {
  res.json({ googleConnected: Boolean(req.session.googleTokens) });
});

app.get("/api/blogs", requireGoogleAuth, async (req, res) => {
  try {
    const auth = oauthClient();
    auth.setCredentials(req.session.googleTokens);
    auth.on("tokens", (tokens) => {
      req.session.googleTokens = { ...req.session.googleTokens, ...tokens };
    });
    const blogger = google.blogger({ version: "v3", auth });
    const result = await blogger.blogs.listByUser({ userId: "self" });
    await persistBloggerCredentials(req.session.googleTokens);
    res.json({ blogs: result.data.items || [] });
  } catch (err) {
    console.error("Blogger blogs.listByUser failed:", err.message);
    res.status(502).json({ error: "blogger_api_failed" });
  }
});

app.post("/api/posts", requireGoogleAuth, async (req, res) => {
  const { blogId, title, content, labels = [], isDraft = false } = req.body || {};
  if (!blogId || typeof title !== "string" || !title.trim() ||
      typeof content !== "string" || !content.trim()) {
    return res.status(400).json({
      error: "invalid_post",
      message: "blogId, title, and content are required."
    });
  }
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string")) {
    return res.status(400).json({ error: "invalid_labels" });
  }

  try {
    const auth = oauthClient();
    auth.setCredentials(req.session.googleTokens);
    auth.on("tokens", (tokens) => {
      req.session.googleTokens = { ...req.session.googleTokens, ...tokens };
    });
    const blogger = google.blogger({ version: "v3", auth });
    const result = await blogger.posts.insert({
      blogId: String(blogId),
      isDraft: Boolean(isDraft),
      requestBody: { title: title.trim(), content, labels }
    });
    res.status(201).json({ post: result.data });
  } catch (err) {
    console.error("Blogger posts.insert failed:", err.message);
    res.status(502).json({ error: "blogger_publish_failed" });
  }
});


const BLOG_ID_FALLBACK = "2429305894635308678";
const AUTOMATION_TOPICS = [
  { key: "ai-prompting-basics", language: "en", topic: "A practical beginner's guide to writing effective AI prompts" },
  { key: "ai-prompts-arabic", language: "ar", topic: "دليل عملي للمبتدئين لكتابة أوامر فعّالة للذكاء الاصطناعي" },
  { key: "password-manager-guide", language: "en", topic: "How to choose and start using a password manager safely" },
  { key: "cloud-storage-arabic", language: "ar", topic: "كيف تختار خدمة تخزين سحابي وتنظم ملفاتك بأمان" },
  { key: "spreadsheet-productivity", language: "en", topic: "Useful spreadsheet habits that save time for beginners" },
  { key: "digital-privacy-arabic", language: "ar", topic: "خطوات عملية لتحسين الخصوصية الرقمية على الهاتف والحاسوب" },
  { key: "browser-security", language: "en", topic: "Simple browser security settings everyone should review" },
  { key: "ai-study-workflow-arabic", language: "ar", topic: "طريقة استخدام أدوات الذكاء الاصطناعي لتنظيم الدراسة والعمل" },
  { key: "backup-basics", language: "en", topic: "A beginner-friendly 3-2-1 backup plan for personal files" },
  { key: "phishing-arabic", language: "ar", topic: "كيف تكتشف رسائل التصيد الإلكتروني وتتجنب الروابط المزيفة" },
  { key: "smartphone-storage", language: "en", topic: "How to safely free up storage space on a smartphone" },
  { key: "ai-fact-checking-arabic", language: "ar", topic: "كيف تتحقق من إجابات الذكاء الاصطناعي قبل الاعتماد عليها" },
  { key: "two-factor-auth", language: "en", topic: "Two-factor authentication explained with a practical setup checklist" },
  { key: "wifi-security-arabic", language: "ar", topic: "إعدادات بسيطة لتأمين شبكة Wi-Fi المنزلية" },
  { key: "file-organization", language: "en", topic: "A simple digital file organization system for work and study" },
  { key: "accessible-tech-arabic", language: "ar", topic: "ميزات تسهيل الاستخدام في الهاتف التي قد تجعل حياتك أسهل" }
];

async function ensureAutomationTables() {
  await pool.query("CREATE TABLE IF NOT EXISTS automation_credentials (id SMALLINT PRIMARY KEY CHECK (id = 1), blog_id TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query("CREATE TABLE IF NOT EXISTS automation_posts (id BIGSERIAL PRIMARY KEY, topic_key TEXT NOT NULL UNIQUE, title TEXT NOT NULL, blogger_post_id TEXT NOT NULL, language TEXT NOT NULL, published_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
}

function encryptRefreshToken(value) {
  const key = createHash("sha256").update(process.env.SESSION_SECRET || "").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString("base64")).join(".");
}

function decryptRefreshToken(value) {
  const [ivText, tagText, dataText] = value.split(".");
  const key = createHash("sha256").update(process.env.SESSION_SECRET || "").digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64"));
  decipher.setAuthTag(Buffer.from(tagText, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64")), decipher.final()]).toString("utf8");
}

async function persistBloggerCredentials(tokens) {
  if (!tokens?.refresh_token || !process.env.SESSION_SECRET) return;
  await ensureAutomationTables();
  const auth = oauthClient();
  auth.setCredentials(tokens);
  const blogger = google.blogger({ version: "v3", auth });
  const result = await blogger.blogs.listByUser({ userId: "self" });
  const blogs = result.data.items || [];
  const blog = blogs.find((item) => item.url === "https://auvexio.blogspot.com/") || blogs.find((item) => item.id === BLOG_ID_FALLBACK);
  if (!blog?.id) throw new Error("Target Blogger blog was not found in the connected Google account");
  await pool.query(
    "INSERT INTO automation_credentials (id, blog_id, refresh_token_enc) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET blog_id = EXCLUDED.blog_id, refresh_token_enc = EXCLUDED.refresh_token_enc, updated_at = NOW()",
    [String(blog.id), encryptRefreshToken(tokens.refresh_token)]
  );
}

function cleanGeneratedHtml(html) {
  return String(html || "")
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "");
}

async function generateArticle(topic) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const languageInstruction = topic.language === "ar"
    ? "Write in clear, natural Modern Standard Arabic."
    : "Write in clear, natural international English.";

  const prompt = [
    "You are the senior fact-checking editor of Smart Tech Guide, a practical bilingual technology publication.",
    "Create a distinctive, genuinely useful tutorial for this exact topic: " + topic.topic,
    languageInstruction,
    "Audience: general readers and beginners worldwide. Write for people, not search engines.",
    "Return ONLY valid JSON with keys: title, metaDescription, html, labels, sources.",
    "The title must be specific, natural, accurate, and preferably 45-65 characters. Never use clickbait.",
    "metaDescription must accurately summarize the article in 120-160 characters.",
    "Write at least 900 substantive words. Do not pad, repeat the same advice, or use generic filler.",
    "Structure: useful introduction; clear H2/H3 sections; numbered practical steps where appropriate; at least two concrete examples; common mistakes and how to avoid them; concise FAQ; practical conclusion.",
    "Explain trade-offs and limitations. Distinguish facts from recommendations. Do not claim a tool is free, available everywhere, or has a feature unless certain.",
    "Do not invent statistics, studies, quotes, product features, prices, dates, laws, or URLs. Avoid unsupported absolute claims.",
    "Use specific, actionable advice that adds value beyond a generic overview. Explain why each important step matters.",
    "HTML may use only h2, h3, p, ul, ol, li, strong, blockquote, code, and a tags. Use descriptive link text.",
    "Include 2-4 genuinely relevant primary/official sources in the article as normal HTML links, and return the same sources as [{\"title\":\"...\",\"url\":\"https://...\"}]. Prefer official documentation or recognized public authorities. Never guess a URL; if you cannot confidently provide a precise source URL, do not include it.",
    "Use only sources from these trusted domains where relevant: support.google.com, developers.google.com, cisa.gov, nist.gov, consumer.ftc.gov, ftc.gov, support.microsoft.com, support.apple.com, support.mozilla.org, ic3.gov, europa.eu.",
    "Do not add fabricated internal links. Never disclose that the article was generated by an automated system.",
    "labels must contain 3-5 concise, relevant strings. No keyword stuffing. No markdown fences."
  ].join("\n");

  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.45, maxOutputTokens: 8192 }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "Gemini request failed (" + response.status + ")");
  const textOutput = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";

  let article;
  try {
    article = JSON.parse(textOutput);
  } catch {
    throw new Error("Gemini returned content that was not valid JSON");
  }

  const title = typeof article.title === "string" ? article.title.trim() : "";
  const metaDescription = typeof article.metaDescription === "string" ? article.metaDescription.trim() : "";
  const html = cleanGeneratedHtml(article.html);
  const plainText = html.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const h2Count = (html.match(/<h2[\s>]/gi) || []).length;
  const faqPresent = /frequently asked questions|common questions|الأسئلة الشائعة|أسئلة شائعة/i.test(plainText);
  const exampleCount = (plainText.match(/\bexample\b|\bfor instance\b|مثال/gi) || []).length;

  const trustedDomains = new Set([
    "support.google.com", "developers.google.com", "cisa.gov", "nist.gov",
    "consumer.ftc.gov", "ftc.gov", "support.microsoft.com", "support.apple.com",
    "support.mozilla.org", "ic3.gov", "europa.eu"
  ]);
  const sources = Array.isArray(article.sources) ? article.sources : [];
  const validSources = sources.filter((source) => {
    if (!source || typeof source.title !== "string" || typeof source.url !== "string") return false;
    try {
      const parsed = new URL(source.url);
      const host = parsed.hostname.toLowerCase();
      const trusted = [...trustedDomains].some((domain) => host === domain || host.endsWith("." + domain));
      return source.title.trim().length > 0 && parsed.protocol === "https:" && trusted && (html.includes('href="' + source.url + '"') || html.includes("href='" + source.url + "'"));
    } catch {
      return false;
    }
  });

  const labels = Array.isArray(article.labels)
    ? article.labels.filter((label) => typeof label === "string" && label.trim()).map((label) => label.trim()).slice(0, 5)
    : [];

  const checks = {
    title: title.length >= 25 && title.length <= 90,
    metaDescription: metaDescription.length >= 80 && metaDescription.length <= 180,
    length: wordCount >= 900,
    structure: h2Count >= 4 && /<h3[\s>]/i.test(html) && /<p[\s>]/i.test(html),
    practicalExamples: exampleCount >= 2,
    faq: faqPresent,
    sources: validSources.length >= 2,
    labels: labels.length >= 3
  };
  const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failed.length) {
    throw new Error("Article failed editorial quality checks: " + failed.join(", ") + " (word count: " + wordCount + ")");
  }

  return { title, metaDescription, html, labels, sources: validSources, wordCount };
}
async function runDailyAutomation() {
  await ensureAutomationTables();
  const credentialResult = await pool.query("SELECT blog_id, refresh_token_enc FROM automation_credentials WHERE id = 1");
  const saved = credentialResult.rows[0];
  if (!saved) throw new Error("Blogger is not connected for background publishing");
  const usedResult = await pool.query("SELECT topic_key FROM automation_posts");
  const used = new Set(usedResult.rows.map((row) => row.topic_key));
  const topic = AUTOMATION_TOPICS.find((item) => !used.has(item.key));
  if (!topic) throw new Error("Prepared topic list is complete; add topics before continuing");
  const article = await generateArticle(topic);
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: decryptRefreshToken(saved.refresh_token_enc) });
  const blogger = google.blogger({ version: "v3", auth });
  const published = await blogger.posts.insert({
    blogId: saved.blog_id,
    isDraft: false,
    requestBody: { title: article.title, content: article.html, labels: article.labels, searchDescription: article.metaDescription }
  });
  await pool.query(
    "INSERT INTO automation_posts (topic_key, title, blogger_post_id, language) VALUES ($1, $2, $3, $4)",
    [topic.key, article.title, String(published.data.id), topic.language]
  );
  return { ok: true, title: article.title, language: topic.language, wordCount: article.wordCount, bloggerPostId: published.data.id };
}

app.get("/api/automation/status", async (_req, res) => {
  try {
    await ensureAutomationTables();
    const [credential, count] = await Promise.all([
      pool.query("SELECT blog_id FROM automation_credentials WHERE id = 1"),
      pool.query("SELECT COUNT(*)::int AS total FROM automation_posts")
    ]);
    res.json({
      configured: Boolean(credential.rows[0]),
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      scheduler: "GitHub Actions daily workflow (requires repository secrets)",
      publishedAutomatically: count.rows[0].total,
      remainingPreparedTopics: Math.max(0, AUTOMATION_TOPICS.length - count.rows[0].total)
    });
  } catch (err) {
    console.error("Automation status failed:", err.message);
    res.status(500).json({ error: "automation_status_failed" });
  }
});

app.post("/api/automation/run", async (req, res) => {
  const suppliedKey = req.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (!process.env.GEMINI_API_KEY || !safeEqual(suppliedKey, process.env.GEMINI_API_KEY)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const result = await runDailyAutomation();
    res.status(201).json(result);
  } catch (err) {
    console.error("Daily automation failed:", err.message);
    res.status(502).json({ error: "automation_run_failed", message: err.message });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: "logout_failed" });
    res.clearCookie("smarttech.sid");
    res.json({ ok: true });
  });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "internal_server_error" });
});

app.listen(port, () => {
  console.log(`Smart Tech Blogger backend listening on port ${port}`);
});
