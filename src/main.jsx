import React from "react";
import { createRoot } from "react-dom/client";
import CashCycle from "./CashCycle.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <CashCycle />
  </React.StrictMode>
);

// register the service worker so the app works offline + installs to home screen
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
