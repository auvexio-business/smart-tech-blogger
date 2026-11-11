import "dotenv/config";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pg from "pg";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { google } from "googleapis";
import { randomBytes, timingSafeEqual } from "node:crypto";

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
