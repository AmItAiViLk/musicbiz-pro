import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";
import Login from "./Login.jsx";
import { supabase } from "./supabase.js";

function Root() {
  const [session, setSession] = useState(undefined); // undefined = still loading

  useEffect(() => {
    // Restore existing session immediately (auth persistence)
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    // Listen for sign-in / sign-out events
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Loading spinner while checking session
  if (session === undefined) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0d0d11]">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!session) return <Login />;
  return <App user={session.user} />;
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
