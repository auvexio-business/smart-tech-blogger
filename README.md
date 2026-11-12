# Smart Tech Blogger

Backend for **دليل التقنية الذكية | Smart Tech Guide**. This project is intended to connect securely to Blogger, prepare bilingual Arabic/English posts, and publish them through the official Blogger API.

## Current implementation

- Express backend with a health endpoint.
- Google OAuth 2.0 authorization-code flow for Blogger.
- PostgreSQL-backed sessions (so OAuth sessions are not stored in an in-memory process store).
- Endpoint to list the authenticated user's Blogger blogs.
- Endpoint to create a Blogger post as a draft or publish it.
- Open-weight article generation through OpenRouter's free-model router.
- Encrypted persistence of the Blogger refresh token for background publishing.
- Daily publishing endpoint protected by a dedicated automation secret, with a GitHub Actions schedule.
- Basic article checks (minimum length, structure, and removal of executable HTML), plus a fixed topic list to prevent reusing the same planned topic.

## Requirements

- Node.js 20+
- PostgreSQL database
- A Google OAuth 2.0 **Web application** client
- Blogger API v3 enabled in the Google Cloud project

## Run locally

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in the values locally.
3. Set the Google OAuth redirect URI to exactly match `GOOGLE_REDIRECT_URI`.
4. Start the server: `npm run dev`
5. Open `http://localhost:3000/auth/google` and authorize the Google account that owns the Blogger blog.

Never commit `.env`, OAuth client secrets, access tokens, or refresh tokens.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port (defaults to 3000) |
| `APP_BASE_URL` | Public base URL for the deployed app |
| `SESSION_SECRET` | Long random secret used to sign sessions |
| `DATABASE_URL` | PostgreSQL connection string |
| `GOOGLE_CLIENT_ID` | OAuth web client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth web client secret |
| `GOOGLE_REDIRECT_URI` | Exact deployed callback URL |
| `BLOGGER_SCOPE` | Blogger OAuth scope |

## API

- `GET /health` — service health.
- `GET /auth/google` — begin Google authorization.
- `GET /auth/google/callback` — OAuth callback.
- `GET /api/status` — whether this browser session is connected.
- `GET /api/blogs` — list Blogger blogs for the connected account.
- `POST /api/posts` — create a post. JSON body: `{ "blogId": "...", "title": "...", "content": "...", "labels": [], "isDraft": true }`.
- `GET /api/automation/status` — show automation setup status.
- `POST /auth/logout` — end the current session.

## Daily publishing setup

2. After deployment, open `/api/blogs` once while signed in; this stores the Blogger refresh token encrypted in PostgreSQL for background publishing.
4. The workflow runs daily at 06:00 UTC (09:00 Saudi Arabia time). It can also be started manually from the Actions tab.

The initial topic queue contains 16 planned articles and stops when those topics are used. The article checks are automated safeguards, not a guarantee of factual accuracy, originality, SEO performance, or AdSense approval. The default OpenRouter free-model router selects from currently available free models and is rate-limited; availability, output quality, and response length can vary. The system retries temporary provider failures and rejects articles that fail editorial checks. OpenRouter and its selected inference provider process submitted prompts/content under their applicable terms.

The Blogger API publishes posts but does not manage the Blogger theme/template. Theme installation remains a separate Blogger-admin task.

No guarantee is made about Google search rankings or AdSense approval. Automated content must be useful, original, accurate, and reviewed by quality controls to avoid scaled low-value publishing.
