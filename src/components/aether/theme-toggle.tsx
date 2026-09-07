import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { THEME_STORAGE_KEY } from "@/lib/aether/guest";

type Mode = "light" | "dark";

function readMode(): Mode {
  if (typeof document === "undefined") return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  if (document.documentElement.classList.contains("light")) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyMode(mode: Mode) {
  document.documentElement.classList.remove("light", "dark");
  document.documentElement.classList.add(mode);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("light");

  useEffect(() => {
    setMode(readMode());
  }, []);

  return (
    <button
      type="button"
      className="inline-flex min-h-11 min-w-11 items-center justify-center border border-line text-ink"
      aria-label={mode === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => {
        const next = mode === "dark" ? "light" : "dark";
        applyMode(next);
        setMode(next);
      }}
    >
      {mode === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
    </button>
  );
}
