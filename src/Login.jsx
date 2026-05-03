import { useState } from "react";
import { supabase } from "./supabase.js";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });
      if (error) setError(error.message);
    } else {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else setNotice("נשלח אימייל אישור — בדוק את תיבת הדואר שלך.");
    }
    setLoading(false);
  }

  async function handleGoogle() {
    setError(null);
    const redirectTo =
      window.location.hostname === "localhost"
        ? `http://localhost:${window.location.port || 5173}`
        : window.location.origin;
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) setError(error.message);
  }

  return (
    <div
      className="min-h-dvh flex items-center justify-center p-6"
      style={{ background: "#0d0d11" }}
      dir="rtl"
    >
      <div className="w-full max-w-[360px] space-y-6">
        {/* Brand */}
        <div className="text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto"
            style={{ background: "#6366f1" }}
          >
            <svg className="w-7 h-6" viewBox="0 0 48 46" fill="white">
              <path d="M25.946 44.938c-.664.845-2.021.375-2.021-.698V33.937a2.26 2.26 0 0 0-2.262-2.262H10.287c-.92 0-1.456-1.04-.92-1.788l7.48-10.471c1.07-1.497 0-3.578-1.842-3.578H1.237c-.92 0-1.456-1.04-.92-1.788L10.013.474c.214-.297.556-.474.92-.474h28.894c.92 0 1.456 1.04.92 1.788l-7.48 10.471c-1.07 1.498 0 3.579 1.842 3.579h11.377c.943 0 1.473 1.088.89 1.83L25.947 44.94z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white tracking-tight">
              Tempo
            </h1>
            <p className="text-sm mt-0.5" style={{ color: "#64748b" }}>
              {mode === "login" ? "ברוך הבא, אמיתי" : "צור חשבון"}
            </p>
          </div>
        </div>

        {/* Card */}
        <div
          className="rounded-2xl p-6 space-y-4"
          style={{
            background: "#16161d",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          {/* Google */}
          <button
            onClick={handleGoogle}
            className="w-full flex items-center justify-center gap-3 rounded-xl py-2.5 text-sm font-semibold transition-colors"
            style={{ background: "#ffffff", color: "#111", fontSize: "14px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#f8f8f8")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#ffffff")}
          >
            <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
              <path
                fill="#4285F4"
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              />
              <path
                fill="#34A853"
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              />
              <path
                fill="#FBBC05"
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              />
              <path
                fill="#EA4335"
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              />
            </svg>
            המשך עם Google
          </button>

          <div className="flex items-center gap-3">
            <div
              className="flex-1 h-px"
              style={{ background: "rgba(255,255,255,0.07)" }}
            />
            <span className="text-xs" style={{ color: "#475569" }}>
              או
            </span>
            <div
              className="flex-1 h-px"
              style={{ background: "rgba(255,255,255,0.07)" }}
            />
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="אימייל"
              required
              dir="ltr"
              className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-all"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
              onFocus={(e) =>
                (e.target.style.borderColor = "rgba(99,102,241,0.5)")
              }
              onBlur={(e) =>
                (e.target.style.borderColor = "rgba(255,255,255,0.08)")
              }
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="סיסמה"
              required
              dir="ltr"
              className="w-full rounded-xl px-4 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition-all"
              style={{
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.08)",
              }}
              onFocus={(e) =>
                (e.target.style.borderColor = "rgba(99,102,241,0.5)")
              }
              onBlur={(e) =>
                (e.target.style.borderColor = "rgba(255,255,255,0.08)")
              }
            />

            {error && (
              <p
                className="text-xs rounded-xl px-3 py-2"
                style={{
                  color: "#f87171",
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.2)",
                }}
              >
                {error}
              </p>
            )}
            {notice && (
              <p
                className="text-xs rounded-xl px-3 py-2"
                style={{
                  color: "#34d399",
                  background: "rgba(52,211,153,0.08)",
                  border: "1px solid rgba(52,211,153,0.2)",
                }}
              >
                {notice}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full text-white text-sm font-semibold py-2.5 rounded-xl transition-all disabled:opacity-50"
              style={{ background: "#6366f1" }}
              onMouseEnter={(e) =>
                !loading && (e.currentTarget.style.background = "#4f46e5")
              }
              onMouseLeave={(e) =>
                (e.currentTarget.style.background = "#6366f1")
              }
            >
              {loading ? (
                <span className="inline-flex items-center gap-2 justify-center">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {mode === "login" ? "מתחבר..." : "נרשם..."}
                </span>
              ) : mode === "login" ? (
                "התחבר"
              ) : (
                "הירשם"
              )}
            </button>
          </form>

          <p className="text-center text-xs" style={{ color: "#475569" }}>
            {mode === "login" ? "אין לך חשבון?" : "כבר יש לך חשבון?"}{" "}
            <button
              onClick={() => {
                setMode(mode === "login" ? "signup" : "login");
                setError(null);
                setNotice(null);
              }}
              className="font-semibold transition-colors"
              style={{ color: "#818cf8" }}
            >
              {mode === "login" ? "הירשם" : "התחבר"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
