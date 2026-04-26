// [FS-01] Frontend source tree: src/main.tsx is the React entry; sibling dirs are App.tsx (root layout), store/ (Zustand), hooks/ (React hooks), components/ (UI w/ co-located CSS), lib/ (pure logic), types/ (TS mirrors of Rust types).
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { CLAUDE_THEME, applyTheme } from "./lib/theme";

// Apply theme CSS variables before first render
applyTheme(CLAUDE_THEME);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
