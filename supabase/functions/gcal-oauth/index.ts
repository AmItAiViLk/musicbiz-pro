/**
 * gcal-oauth/index.ts — Deno Edge Function
 *
 * Exchanges a Google OAuth authorization code for tokens and stores
 * the refresh_token in user_settings.google_refresh_token.
 *
 * Required Edge Function secrets:
 *   GOOGLE_CLIENT_ID     — same OAuth client used in the frontend
 *   GOOGLE_CLIENT_SECRET — the confidential client secret (never in frontend)
 *
 * Called by the frontend after the user completes the Google consent screen:
 *   POST /gcal-oauth
 *   Authorization: Bearer <supabase-user-jwt>
 *   { "code": "...", "redirect_uri": "http://localhost:5173" }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") ?? "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
  const authHeader = req.headers.get("Authorization") ?? "";
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser(authHeader.replace("Bearer ", ""));
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);

  // ── Parse body ──────────────────────────────────────────────────────────────
  let code: string, redirectUri: string;
  try {
    const body = await req.json();
    code = body.code;
    redirectUri = body.redirect_uri;
    if (!code || !redirectUri) throw new Error();
  } catch {
    return json({ error: "Missing code or redirect_uri" }, 400);
  }

  if (!GOOGLE_CLIENT_SECRET) {
    return json(
      {
        error:
          "GOOGLE_CLIENT_SECRET not set — add it as an Edge Function secret in Supabase dashboard",
      },
      500,
    );
  }

  // ── Exchange code for tokens ─────────────────────────────────────────────────
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json();

  if (!tokenRes.ok || !tokens.refresh_token) {
    console.error("Token exchange failed:", tokens);
    return json(
      {
        error:
          "לא התקבל refresh_token — ודא שה-Redirect URI רשום ב-Google Cloud Console ושה-scope כולל access_type=offline&prompt=consent",
        details: tokens,
      },
      400,
    );
  }

  // ── Persist refresh token ────────────────────────────────────────────────────
  const { error: upsertErr } = await supabase.from("user_settings").upsert({
    user_id: user.id,
    google_refresh_token: tokens.refresh_token,
  });

  if (upsertErr) return json({ error: upsertErr.message }, 500);

  return json({ success: true });
});
