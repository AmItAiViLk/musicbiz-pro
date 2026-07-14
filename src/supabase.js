import { createClient } from "@supabase/supabase-js";

// Public Supabase config. The URL and the *publishable* anon key are designed to
// ship in client code (that's their purpose) — data is protected by the RLS
// policies enabled on every table. These literals are fallbacks so the app
// always builds correctly even when the host's build-time env vars are absent.
const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ||
  "https://tyckebaxdgqscxbpilqm.supabase.co";
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  "sb_publishable_Te8gsHEkOK7P0HGZABg4uw_Vh_CRzBD";

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
