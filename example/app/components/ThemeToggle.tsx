"use client";

import { useState, useEffect } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState("light");

  useEffect(() => {
    const saved = localStorage.getItem("meiden-theme");
    if (saved) setTheme(saved);
  }, []);

  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    localStorage.setItem("meiden-theme", next);
    // In a real app we would update the document class here
  };

  return (
    <button 
      className="button secondary" 
      type="button" 
      onClick={toggle}
      style={{ minWidth: "120px" }}
    >
      Theme: {theme}
    </button>
  );
}
