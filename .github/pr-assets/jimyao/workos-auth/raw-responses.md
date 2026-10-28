Raw responses from `pnpm dev` against WorkOS staging (cookie values elided).

| Request | Response |
|---|---|
| `GET /api/auth/me`, no cookie | 401 `{"error":"unauthorized"}` |
| `GET /api/auth/me`, `Cookie: wos-session=garbage` | 401 |
| `GET /api/auth/me`, after password sign-in (cookie 2065 bytes, HttpOnly, SameSite=Lax, Path=/, 30 days) | 200 `{"userId":"user_01KV3Q…","email":"test@voluma.bio","name":"Jimmy Yao","labId":"org_01M607…"}` |
| `GET /api/auth/login?returnTo=//evil.example`, already signed in at AuthKit | back at `/` (hostile return path sanitized) |
| `POST /api/auth/logout` from the page | 200 `{"logoutUrl":"https://api.workos.com/user_management/sessions/logout?session_id=…"}`, `Set-Cookie: wos-session=; Max-Age=0`; `me` then 401 |
| Sign-in as a user outside the lab | redirected to `/?signin=not-a-member`; no `wos-session` cookie; WorkOS lists no session for the user |
| Access token replaced with `aaa.bbb.ccc` in the sealed cookie, `me` | 200 + one `Set-Cookie: wos-session=…`; the next two requests with the new cookie: 200, no `Set-Cookie` |
| Ingest with the runner bearer | 200 `{"messages":[]}` |
| Ingest with a bad bearer / no credentials | 401 / 401 |
| Ingest with a user cookie | 403 |
| `me` with the runner bearer | 403 |
| Cookie `POST /api/auth/logout`, `Origin: https://evil.example` / no `Origin` | 403 / 403 |
| Cookie `POST` with the right `Origin`, `Content-Type: text/plain` | 415 |
| Cookie plus `Authorization: Bearer nope` | 401 (the bearer alone counts) |
