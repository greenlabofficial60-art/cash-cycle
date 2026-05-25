# Cash Cycle

A calendar-based personal cash-flow forecasting app. Plan income, bills, goals,
debts and budgets, and see where your balance is headed day by day.

There are **two ways to run it**. Pick whichever is easier for you.

---

## Option A — Fastest: the single HTML file (no install, no build)

Use `index-standalone.html`. It runs by itself in any browser — no Node, no build step.

1. Double-click `index-standalone.html` to open it in your browser. That's it.
2. To put it online + on your phone, see "Host on GitHub Pages" below.

> Note: the standalone file loads React from the internet (a CDN), so the very
> first open needs a connection. After that the service worker caches it offline.

---

## Option B — The full project (for editing in Claude Code / VS Code)

This is a normal Vite + React project. Nothing here is over the paste limit —
the big component lives in its own file, so you never paste it into a chat.

```bash
npm install
npm run dev      # opens a local dev server
npm run build    # creates a /dist folder you can host
```

Files:
- `src/CashCycle.jsx` — the whole app (open/edit this one)
- `src/main.jsx` — mounts the app + registers the service worker
- `index.html` — page shell with iOS home-screen meta tags
- `public/` — manifest, service worker, and app icons

---

## Host on GitHub (so you can open it anywhere)

1. Create a new repository on github.com (e.g. `cash-cycle`).
2. Upload these files (drag the whole folder into the repo's "Add file → Upload files").
3. Your code is now viewable on GitHub.

### Make it a live website (GitHub Pages)

**Easiest (standalone file):**
1. Rename `index-standalone.html` to `index.html` (or keep both — Pages serves `index.html`).
2. In the repo: **Settings → Pages → Source: Deploy from a branch → main → /(root) → Save**.
3. Wait ~1 minute. Your app is live at `https://YOURNAME.github.io/cash-cycle/`.

**Full build version:**
1. `npm run build` locally, then upload the contents of the `dist/` folder
   (or use a GitHub Action). The included `vite.config.js` uses `base: "./"`
   so it works from the Pages subpath automatically.

---

## Add it to your iPhone home screen

1. Open the live GitHub Pages link in **Safari** on your iPhone.
2. Tap the **Share** button (the square with the up arrow).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add**.

It now opens full-screen with its own icon, like a native app, and works offline.
(Android/Chrome: open the link, tap the ⋮ menu, then **Add to Home screen**.)

---

## Heads up
- Data is stored in the app's memory for now, so it resets if you fully close it.
  Adding permanent saving (localStorage) is a small next step — ask and it can be added.
- This is an original implementation built to match the layout/behavior you wanted.
