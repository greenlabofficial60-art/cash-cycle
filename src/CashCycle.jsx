import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import {
  FIREBASE_READY, fbAuth, fbDb,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  doc as fbDoc, setDoc, getDoc,
} from "./firebase.js";

// ============================================================================
// Cash Cycle — calendar-based cash-flow forecasting (iPhone style)
//
// Home = a scrolling month calendar. Each day cell shows:
//   • the projected running balance pill (when it changes that day)
//   • transaction blocks (emoji + name + amount), green for income
//   • "today" marked with a blue circle
// Top = current balance + a plain-language forecast banner ("Clear Skies").
// Bottom = floating pill toolbar: calendar · charts · + · grid · cards
// ============================================================================

const uid = () => Math.random().toString(36).slice(2, 9);
const todayISO = () => new Date().toISOString().slice(0, 10);
const dISO = (d) => d.toISOString().slice(0, 10);

let _simplifiedDisplay = false;

const fmtK = (n) => {
  if (_simplifiedDisplay) n = Math.round(n);
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1000) return s + "$" + (a / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return s + "$" + Math.round(a);
};
const fmtFull = (n) => {
  if (_simplifiedDisplay) return (n < 0 ? "-" : "") + "$" + Math.abs(Math.round(n)).toLocaleString("en-US");
  return (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const FREQ_LABEL = {
  once: "One-time", daily: "Daily", weekly: "Weekly",
  biweekly: "Every 2 weeks", monthly: "Monthly", yearly: "Yearly",
};

const CATS = {
  income: [
    { id: "hourly", label: "Hourly", icon: "⏱️" },
    { id: "salary", label: "Paycheck", icon: "💵" },
    { id: "freelance", label: "Freelance", icon: "💻" },
    { id: "other-in", label: "Other income", icon: "➕" },
  ],
  expense: [
    { id: "rent", label: "Rent", icon: "🏠" },
    { id: "car", label: "Car payment", icon: "🚗" },
    { id: "phone", label: "Phone", icon: "📱" },
    { id: "bills", label: "Bills", icon: "💡" },
    { id: "food", label: "Food", icon: "🍔" },
    { id: "subs", label: "Subscriptions", icon: "📺" },
    { id: "other-out", label: "Other", icon: "➖" },
  ],
};
const TINT = {
  income:  { bg: "#d6f5e3", accent: "#30d158", text: "#0b6b39" },
  rent:    { bg: "#e7ddd6", accent: "#a07d63", text: "#5c4631" },
  car:     { bg: "#cfeafe", accent: "#0a84ff", text: "#0a4a8a" },
  phone:   { bg: "#dcdcf7", accent: "#5e5ce6", text: "#3a3a8a" },
  bills:   { bg: "#fff0c9", accent: "#ff9f0a", text: "#8a5a00" },
  food:    { bg: "#ffe0d6", accent: "#ff6b3d", text: "#8a3a1a" },
  subs:    { bg: "#f3d9f0", accent: "#bf5af2", text: "#7a2e8a" },
  goal:    { bg: "#dcf5dc", accent: "#34c759", text: "#1a6e2e" },
  default: { bg: "#eaeaef", accent: "#8e8e93", text: "#444" },
};
const tintFor = (tx) => (tx.type === "income" ? TINT.income : tx.type === "goal" ? TINT.goal : TINT[tx.category] || TINT.default);
const catMeta = (id) => {
  if (id === "goal") return { id: "goal", label: "Goal", icon: "🌱" };
  for (const k of ["income", "expense"]) for (const c of CATS[k]) if (c.id === id) return c;
  return { id, label: "Other", icon: "•" };
};

function step(d, f) {
  const n = new Date(d);
  if (f === "daily") n.setDate(n.getDate() + 1);
  else if (f === "weekly") n.setDate(n.getDate() + 7);
  else if (f === "biweekly") n.setDate(n.getDate() + 14);
  else if (f === "monthly") n.setMonth(n.getMonth() + 1);
  else if (f === "yearly") n.setFullYear(n.getFullYear() + 1);
  else n.setDate(n.getDate() + 1e6);
  return n;
}
function occurrences(tx, start, end) {
  const out = [];
  let cur = new Date(tx.date + "T00:00:00");
  if (tx.frequency === "once") return cur >= start && cur <= end ? [new Date(cur)] : [];
  let g = 0;
  while (cur < start && g++ < 6000) cur = step(cur, tx.frequency);
  g = 0;
  while (cur <= end && g++ < 6000) { if (cur >= start) out.push(new Date(cur)); cur = step(cur, tx.frequency); }
  return out;
}

// ── localStorage persistence ─────────────────────────────────────────────────
const LS_KEY = "cc_v1";
const DEFAULT_ACCOUNTS = [{ id: "acc1", name: "Checking", balance: 7500, color: "#0a84ff" }];
const DEFAULT_SOURCES  = [{ id: "src1", title: "Hourly Job", icon: "⏱️", type: "hourly", target: 0, account: "acc1" }];

function loadLS() {
  try { const v = localStorage.getItem(LS_KEY); return v ? JSON.parse(v) : null; } catch { return null; }
}
function saveLS(data) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}
function clearLS() {
  try { localStorage.removeItem(LS_KEY); } catch {}
}

// ============================================================================
export default function CashCycle() {
  const _saved = useMemo(loadLS, []); // read once at mount

  const [accounts, setAccounts] = useState(() => _saved?.accounts ?? DEFAULT_ACCOUNTS);
  const [activeAccount, setActiveAccount] = useState(() => _saved?.activeAccount ?? "acc1");
  const [txns, setTxns] = useState(() => _saved?.txns ?? seed());
  const [view, setView] = useState("calendar");
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState(null);
  const [addMenu, setAddMenu] = useState(false);
  const [statusStep, setStatusStep] = useState(null);
  const [newType, setNewType] = useState("expense");
  const [newPaid, setNewPaid] = useState(false);
  const [incomeFlow, setIncomeFlow] = useState(null);
  const [sourceSheet, setSourceSheet] = useState(false);
  const [sources, setSources] = useState(() => _saved?.sources ?? DEFAULT_SOURCES);
  function addSource(src) { setSources((p) => [...p, src]); setSourceSheet(false); }
  const [budgetPeriod, setBudgetPeriod] = useState("weekly");
  const [budgetStart, setBudgetStart] = useState(() => startOfPeriod(new Date(), "weekly"));
  const [budgeted, setBudgeted] = useState(() => _saved?.budgeted ?? 0);
  const [assigned, setAssigned] = useState(() => _saved?.assigned ?? {});
  function assignTo(catId, amt) { setAssigned((p) => ({ ...p, [catId]: amt })); }
  const [debts, setDebts] = useState(() => _saved?.debts ?? []);
  function addDebt(d) { setDebts((p) => [...p, d]); }
  function removeDebt(id) { setDebts((p) => p.filter((x) => x.id !== id)); }
  const [thresholds, setThresholds] = useState({ clear: 500, partly: 300, rain: 100, storm: 0 });
  const [showWarnings, setShowWarnings] = useState(false);
  const [showInsights, setShowInsights] = useState(false);
  const [darkMode, setDarkMode] = useState(() => _saved?.darkMode ?? false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accentColor, setAccentColor] = useState(() => _saved?.accentColor ?? "#0a84ff");
  const [simplifiedDisplay, setSimplifiedDisplay] = useState(() => _saved?.simplifiedDisplay ?? false);
  const [showProjectedBalances, setShowProjectedBalances] = useState(() => _saved?.showProjectedBalances ?? true);
  const [morningForecast, setMorningForecast] = useState(() => _saved?.morningForecast ?? true);
  const [morningTime, setMorningTime] = useState(() => _saved?.morningTime ?? "08:00");
  const [eveningForecast, setEveningForecast] = useState(() => _saved?.eveningForecast ?? true);
  const [eveningTime, setEveningTime] = useState(() => _saved?.eveningTime ?? "18:00");
  const [paymentReminders, setPaymentReminders] = useState(() => _saved?.paymentReminders ?? true);
  const [reminderTime, setReminderTime] = useState(() => _saved?.reminderTime ?? "18:00");
  const [autoMarkPaid, setAutoMarkPaid] = useState(() => _saved?.autoMarkPaid ?? false);
  const [showBalancePanel, setShowBalancePanel] = useState(false);
  const [excludedAccounts, setExcludedAccounts] = useState(() => new Set(_saved?.excludedAccounts ?? []));
  // Auth state
  const [authUser, setAuthUser] = useState(null); // { uid, displayName, email, photoURL }
  const [authLoading, setAuthLoading] = useState(FIREBASE_READY);

  _simplifiedDisplay = simplifiedDisplay;

  // ── Build the saveable state snapshot ──────────────────────────────────────
  const appSnap = useMemo(() => ({
    accounts, txns, debts, assigned, budgeted, sources, activeAccount,
    excludedAccounts: [...excludedAccounts],
    darkMode, accentColor, simplifiedDisplay, showProjectedBalances,
    morningForecast, morningTime, eveningForecast, eveningTime,
    paymentReminders, reminderTime, autoMarkPaid,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [accounts, txns, debts, assigned, budgeted, sources, activeAccount,
       excludedAccounts, darkMode, accentColor, simplifiedDisplay,
       showProjectedBalances, morningForecast, morningTime, eveningForecast,
       eveningTime, paymentReminders, reminderTime, autoMarkPaid]);

  // Save to localStorage on every change
  useEffect(() => { saveLS(appSnap); }, [appSnap]);

  // Sync to Firestore (debounced 1.5 s) when signed in
  useEffect(() => {
    if (!authUser || !fbDb) return;
    const t = setTimeout(async () => {
      try { await setDoc(fbDoc(fbDb, "users", authUser.uid), appSnap); } catch {}
    }, 1500);
    return () => clearTimeout(t);
  }, [appSnap, authUser]); // eslint-disable-line

  // Firebase auth listener
  useEffect(() => {
    if (!FIREBASE_READY || !fbAuth) return;
    setAuthLoading(true);
    const unsub = onAuthStateChanged(fbAuth, async (u) => {
      setAuthUser(u ? { uid: u.uid, displayName: u.displayName, email: u.email, photoURL: u.photoURL } : null);
      if (u && fbDb) {
        try {
          const snap = await getDoc(fbDoc(fbDb, "users", u.uid));
          if (snap.exists()) {
            const d = snap.data();
            if (d.accounts)  setAccounts(d.accounts);
            if (d.txns)      setTxns(d.txns);
            if (d.debts)     setDebts(d.debts);
            if (d.assigned)  setAssigned(d.assigned);
            if (d.budgeted != null)  setBudgeted(d.budgeted);
            if (d.sources)   setSources(d.sources);
            if (d.activeAccount) setActiveAccount(d.activeAccount);
            if (d.excludedAccounts) setExcludedAccounts(new Set(d.excludedAccounts));
            if (d.darkMode != null) setDarkMode(d.darkMode);
            if (d.accentColor) setAccentColor(d.accentColor);
            if (d.simplifiedDisplay != null) setSimplifiedDisplay(d.simplifiedDisplay);
            if (d.showProjectedBalances != null) setShowProjectedBalances(d.showProjectedBalances);
          }
        } catch {}
      }
      setAuthLoading(false);
    });
    return unsub;
  }, []); // eslint-disable-line

  const handleSignIn = useCallback(async () => {
    if (!fbAuth) return null;
    try {
      await signInWithPopup(fbAuth, new GoogleAuthProvider());
      return null;
    } catch (e) {
      const code = e?.code || "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return null;
      if (code === "auth/popup-blocked") return "Popup blocked — please allow popups for this site in your browser settings.";
      if (code === "auth/unauthorized-domain") return "Sign-in not enabled for this domain yet.";
      return "Sign-in failed. Please try again.";
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    if (!fbAuth) return;
    try { await signOut(fbAuth); } catch {}
    setAuthUser(null);
  }, []);

  // ── Full reset ──────────────────────────────────────────────────────────────
  const doReset = useCallback(async () => {
    setAccounts([{ id: "acc1", name: "Checking", balance: 0, color: "#0a84ff" }]);
    setActiveAccount("acc1");
    setTxns([]);
    setDebts([]);
    setAssigned({});
    setBudgeted(0);
    setSources(DEFAULT_SOURCES);
    setExcludedAccounts(new Set());
    clearLS();
    // Also wipe Firestore doc if signed in
    if (authUser && fbDb) {
      try { await setDoc(fbDoc(fbDb, "users", authUser.uid), {}); } catch {}
    }
  }, [authUser]); // eslint-disable-line

  // Use functional updater so txns is NOT a dependency — avoids running on every txns change
  useEffect(() => {
    if (!autoMarkPaid) return;
    const today = todayISO();
    setTxns(p => {
      const needsMark = p.some(tx => tx.type === "expense" && tx.date < today && tx.status !== "paid");
      if (!needsMark) return p;
      return p.map(tx =>
        tx.type === "expense" && tx.date < today && tx.status !== "paid"
          ? { ...tx, status: "paid" }
          : tx
      );
    });
  }, [autoMarkPaid]); // eslint-disable-line

  const acc = accounts.find((a) => a.id === activeAccount);

  const includedIds = useMemo(
    () => accounts.map(a => a.id).filter(id => !excludedAccounts.has(id)),
    [accounts, excludedAccounts]
  );
  const totalBalance = useMemo(
    () => accounts.filter(a => includedIds.includes(a.id)).reduce((s, a) => s + a.balance, 0),
    [accounts, includedIds]
  );
  const accTxns = useMemo(
    () => txns.filter((x) => includedIds.includes(x.account)),
    [txns, includedIds]
  );

  const { dayMap, lowest, end } = useMemo(() => {
    const start = new Date(todayISO() + "T00:00:00");
    const end = new Date(start); end.setMonth(end.getMonth() + 6);
    // Build O(1) lookup maps keyed by date string
    const eventsByDay = new Map();
    const goalsByDay  = new Map();
    for (const tx of accTxns) {
      const isGoal = tx.type === "goal";
      for (const d of occurrences(tx, start, end)) {
        const key = dISO(d);
        if (isGoal) {
          if (!goalsByDay.has(key)) goalsByDay.set(key, []);
          goalsByDay.get(key).push(tx);
        } else {
          if (!eventsByDay.has(key)) eventsByDay.set(key, []);
          eventsByDay.get(key).push({ amount: tx.type === "income" ? tx.amount : -tx.amount, tx });
        }
      }
    }
    const map = {};
    let bal = totalBalance;
    const cur = new Date(start);
    let lowest = { value: bal, date: new Date(start) };
    while (cur <= end) {
      const key = dISO(cur);
      const todays    = eventsByDay.get(key) ?? [];
      const goalsToday = goalsByDay.get(key) ?? [];
      let changed = false;
      for (const e of todays) { bal += e.amount; changed = true; }
      if (bal < lowest.value) lowest = { value: bal, date: new Date(cur) };
      map[key] = { balance: bal, txs: [...todays.map((e) => e.tx), ...goalsToday], changed };
      cur.setDate(cur.getDate() + 1);
    }
    return { dayMap: map, lowest, end };
  }, [accTxns, totalBalance]); // eslint-disable-line

  const forecast = useMemo(
    () => buildForecastSentence(accTxns, totalBalance, dayMap, thresholds),
    [accTxns, totalBalance, dayMap, thresholds] // eslint-disable-line
  );

  const onTapTxCb = useCallback((tx) => { setEditing(tx); setSheet(true); }, []);
  const onEditWarningsCb = useCallback(() => setShowWarnings(true), []);

  const saveTx = useCallback((tx) => {
    setTxns((p) => (p.some((x) => x.id === tx.id) ? p.map((x) => (x.id === tx.id ? tx : x)) : [...p, tx]));
    setSheet(false); setEditing(null);
  }, []);
  const delTx = useCallback((id) => {
    setTxns((p) => p.filter((x) => x.id !== id)); setSheet(false); setEditing(null);
  }, []);

  return (
    <div style={{ ...S.root, "--ac": accentColor }} className={darkMode ? "dm" : ""}>
      <style>{CSS}</style>

      <div style={S.header}>
        <div style={{ display: "flex", gap: 8 }}>
          <IconBtn onClick={() => setMenuOpen(true)}>☰</IconBtn>
          <IconBtn>💬</IconBtn>
        </div>
        <button onClick={() => setShowBalancePanel(true)}
          style={{ textAlign: "center", background: "transparent", border: "none", cursor: "pointer", padding: "2px 8px" }}>
          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>{fmtK(totalBalance)}</div>
          <div style={{ fontSize: 11, color: "#8e8e93", fontWeight: 600 }}>Updated just now</div>
        </button>
        <div style={{ display: "flex", gap: 8 }}>
          <IconBtn onClick={() => setShowInsights(true)}>📊</IconBtn>
          <IconBtn>🏆</IconBtn>
        </div>
      </div>

      {view === "calendar" && (
        <Calendar dayMap={dayMap} forecast={forecast} end={end}
          onTapTx={onTapTxCb}
          onEditWarnings={onEditWarningsCb}
          showProjectedBalances={showProjectedBalances} />
      )}
      {view === "stats" && (
        <BudgetView
          accTxns={accTxns} acc={acc} period={budgetPeriod} setPeriod={setBudgetPeriod}
          start={budgetStart} setStart={setBudgetStart}
          budgeted={budgeted} setBudgeted={setBudgeted}
          assigned={assigned} assignTo={assignTo}
        />
      )}
      {view === "accounts" && (
        <Accounts accounts={accounts} setAccounts={setAccounts}
          activeAccount={activeAccount} setActiveAccount={setActiveAccount} txns={txns} />
      )}
      {view === "ledger" && (
        <Ledger accounts={accounts} setAccounts={setAccounts} txns={txns} />
      )}
      {view === "debts" && (
        <Debts debts={debts} addDebt={addDebt} removeDebt={removeDebt}
          accounts={accounts} setAccounts={setAccounts}
          txns={txns} setTxns={setTxns} activeAccount={activeAccount} />
      )}
      {view === "forecast" && (
        <ForecastView accounts={accounts} accTxns={accTxns} dayMap={dayMap}
          balance={acc?.balance ?? 0} onBack={() => setView("calendar")} dm={darkMode} />
      )}
      {view === "profile" && (
        <ProfileView accounts={accounts} txns={txns} activeAccount={activeAccount}
          onBack={() => setView("calendar")} dm={darkMode}
          authUser={authUser} authLoading={authLoading}
          onSignIn={handleSignIn} onSignOut={handleSignOut}
          onResetData={doReset} />
      )}
      {view === "settings" && (
        <SettingsView
          dm={darkMode} setDarkMode={setDarkMode}
          accentColor={accentColor} setAccentColor={setAccentColor}
          simplifiedDisplay={simplifiedDisplay} setSimplifiedDisplay={setSimplifiedDisplay}
          showProjectedBalances={showProjectedBalances} setShowProjectedBalances={setShowProjectedBalances}
          morningForecast={morningForecast} setMorningForecast={setMorningForecast}
          morningTime={morningTime} setMorningTime={setMorningTime}
          eveningForecast={eveningForecast} setEveningForecast={setEveningForecast}
          eveningTime={eveningTime} setEveningTime={setEveningTime}
          paymentReminders={paymentReminders} setPaymentReminders={setPaymentReminders}
          reminderTime={reminderTime} setReminderTime={setReminderTime}
          autoMarkPaid={autoMarkPaid} setAutoMarkPaid={setAutoMarkPaid}
          onResetData={doReset}
          onManageCategories={() => setView("stats")}
          onBack={() => setView("calendar")} />
      )}

      {showBalancePanel && (
        <BalancePanel
          accounts={accounts} txns={txns} forecast={forecast}
          totalBalance={totalBalance} includedIds={includedIds}
          excludedAccounts={excludedAccounts} setExcludedAccounts={setExcludedAccounts}
          dm={darkMode} onClose={() => setShowBalancePanel(false)} />
      )}

      {menuOpen && (
        <SideMenu
          dm={darkMode}
          darkMode={darkMode} setDarkMode={setDarkMode}
          onClose={() => setMenuOpen(false)}
          onNavigate={(v) => { setView(v); setMenuOpen(false); }}
        />
      )}

      <div style={S.toolbarWrap}>
        {addMenu && (
          <div className="cc-overlay" style={S.addOverlay} onClick={() => { setAddMenu(false); setStatusStep(null); }}>
            <div style={S.addMenu} onClick={(e) => e.stopPropagation()}>
              {!statusStep ? (
                [
                  { type: "expense", icon: "💳", label: "Expense", delay: 0 },
                  { type: "income", icon: "💰", label: "Income", delay: 0.04 },
                  { type: "goal", icon: "🌱", label: "Goal", delay: 0.08 },
                ].map((opt) => (
                  <button key={opt.type} className="cc-addopt"
                    style={{ ...S.addOpt, animationDelay: `${opt.delay}s` }}
                    onClick={() => {
                      if (opt.type === "expense" || opt.type === "income") { setStatusStep(opt.type); return; }
                      setNewType(opt.type); setNewPaid(false);
                      setEditing(null); setAddMenu(false); setSheet(true);
                    }}>
                    <span style={{ fontSize: 26 }}>{opt.icon}</span>
                    <span style={{ fontSize: 20, fontWeight: 800 }}>{opt.label}</span>
                  </button>
                ))
              ) : statusStep === "income" ? (
                [
                  { action: "planned", icon: "📅", label: "Planned", delay: 0 },
                  { action: "received", icon: "✅", label: "Received", delay: 0.04 },
                  { action: "source", icon: "📁", label: "Source", delay: 0.08 },
                ].map((opt) => (
                  <button key={opt.label} className="cc-addopt"
                    style={{ ...S.addOpt, animationDelay: `${opt.delay}s` }}
                    onClick={() => {
                      setAddMenu(false); setStatusStep(null);
                      if (opt.action === "source") { setSourceSheet(true); return; }
                      setNewType("income"); setIncomeFlow(opt.action);
                      setNewPaid(opt.action === "received");
                      setEditing(null); setSheet(true);
                    }}>
                    <span style={{ fontSize: 26 }}>{opt.icon}</span>
                    <span style={{ fontSize: 20, fontWeight: 800 }}>{opt.label}</span>
                  </button>
                ))
              ) : (
                [
                  { paid: false, icon: "📅", label: "Planned", delay: 0 },
                  { paid: true, icon: "✅", label: "Paid", delay: 0.04 },
                ].map((opt) => (
                  <button key={opt.label} className="cc-addopt"
                    style={{ ...S.addOpt, animationDelay: `${opt.delay}s` }}
                    onClick={() => {
                      setNewType(statusStep); setNewPaid(opt.paid);
                      setEditing(null); setAddMenu(false); setStatusStep(null); setSheet(true);
                    }}>
                    <span style={{ fontSize: 26 }}>{opt.icon}</span>
                    <span style={{ fontSize: 20, fontWeight: 800 }}>{opt.label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
        <div style={S.toolbar} className="cc-toolbar-pill">
          <TBtn active={view === "calendar"} onClick={() => setView("calendar")}><IcoCalendar /></TBtn>
          <TBtn active={view === "stats"} onClick={() => setView("stats")}><IcoPie /></TBtn>
          <button style={{ ...S.plus, transform: addMenu ? "rotate(45deg)" : "rotate(0)" }}
            onClick={() => { setAddMenu((v) => !v); setStatusStep(null); }} aria-label="Add">+</button>
          <TBtn active={view === "ledger"} onClick={() => setView("ledger")}><IcoGrid /></TBtn>
          <TBtn active={view === "debts" || view === "accounts"} onClick={() => setView("debts")}><IcoCard /></TBtn>
        </div>
      </div>

      {sheet && (
        <TxSheet accounts={accounts} activeAccount={activeAccount} editing={editing}
          initialType={newType} initialPaid={newPaid} incomeFlow={incomeFlow} sources={sources}
          onOpenSource={() => setSourceSheet(true)}
          onClose={() => { setSheet(false); setEditing(null); setIncomeFlow(null); }}
          onSave={saveTx} onDelete={delTx} />
      )}

      {sourceSheet && (
        <SourceSheet accounts={accounts} onClose={() => setSourceSheet(false)} onSave={addSource} />
      )}
      {showWarnings && (
        <WeatherWarnings thresholds={thresholds}
          onClose={() => setShowWarnings(false)}
          onSave={(t) => { setThresholds(t); setShowWarnings(false); }} />
      )}
      {showInsights && (
        <Insights accounts={accounts} accTxns={accTxns} dayMap={dayMap}
          balance={acc?.balance ?? 0} onClose={() => setShowInsights(false)} />
      )}
    </div>
  );
}

// ============================================================================
// ============================================================================
// WEATHER WARNINGS — adjust balance thresholds (image 1)
// ============================================================================
function WeatherWarnings({ thresholds, onClose, onSave }) {
  const [t, setT] = useState({ ...thresholds });
  const MAX = 800;
  const tiers = [
    { id: "clear", label: "Clear Skies", icon: "☀️", color: "#30a85f", bg: "#e3f7e8", track: "#30d158", prefix: "Above" },
    { id: "partly", label: "Partly Cloudy", icon: "⛅", color: "#0a84ff", bg: "#e3f0ff", track: "#0a84ff", prefix: "Above" },
    { id: "rain", label: "Rain Expected", icon: "🌧️", color: "#e8590c", bg: "#fdebe0", track: "#ff6b1a", prefix: "Above" },
    { id: "storm", label: "Storm Warning", icon: "⛈️", color: "#3a4a5a", bg: "#eceef0", track: "#3a4a5a", prefix: "At" },
  ];
  const setTier = (id, v) => setT((p) => ({ ...p, [id]: Math.round(Number(v)) }));

  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={{ ...S.detailSheet, background: "#fff" }} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={{ display: "flex", alignItems: "flex-start", padding: "4px 0 12px" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 24, fontWeight: 800 }}>Weather Warnings</div>
            <div style={{ fontSize: 15, color: "#8e8e93", marginTop: 2 }}>Adjust your balance thresholds</div>
          </div>
          <button onClick={() => onSave(t)} style={S.warnSave}>Save</button>
          <button onClick={onClose} style={{ ...S.iconBtn, marginLeft: 8 }}>✕</button>
        </div>

        <div style={S.detailBody} className="cc-cal">
          <div style={S.suggestedPill}>★ Suggested</div>

          {/* gradient legend bar */}
          <div style={{ height: 26, borderRadius: 8, margin: "14px 0 4px",
            background: "linear-gradient(90deg,#3a4a5a,#8a5a3a,#e8590c,#ff6b1a,#8a7a6a,#5a8aaa,#0a84ff,#19c0c0,#30d158)" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#8e8e93", fontWeight: 600 }}>
            <span>$0</span><span>${MAX}</span>
          </div>

          <div style={{ fontSize: 22, fontWeight: 800, margin: "20px 0 12px" }}>Balance Thresholds</div>

          {tiers.map((tier) => (
            <div key={tier.id} style={{ background: tier.bg, borderRadius: 16, padding: 16, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ fontSize: 24, marginRight: 10 }}>{tier.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: tier.color }}>{tier.label}</div>
                  <div style={{ fontSize: 14, color: tier.color, opacity: 0.85 }}>{tier.prefix} ${t[tier.id]}</div>
                </div>
                <div style={{ fontSize: 22, fontWeight: 800, color: tier.color }}>${t[tier.id]}</div>
              </div>
              <input type="range" min="0" max={MAX} step="10" value={t[tier.id]}
                onChange={(e) => setTier(tier.id, e.target.value)}
                style={{ ...S.thresholdSlider, accentColor: tier.track, marginTop: 12 }} />
            </div>
          ))}
          <div style={{ height: 20 }} />
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// INSIGHTS — projected balance, net worth, runway, savings rate (images 2 & 3)
// ============================================================================
function Insights({ accounts, accTxns, dayMap, balance, onClose }) {
  const [months, setMonths] = useState(6);
  const [selected, setSelected] = useState(accounts.map((a) => a.id));
  const toggle = (id) => setSelected((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  // build projected series from dayMap, sampled to ~40 points across the horizon
  const keys = Object.keys(dayMap).sort();
  const horizonDays = months * 30;
  const slice = keys.slice(0, horizonDays);
  const step = Math.max(1, Math.floor(slice.length / 40));
  const series = slice.filter((_, i) => i % step === 0).map((k) => dayMap[k].balance);
  const startBal = balance;
  const endBal = series[series.length - 1] ?? balance;
  const pct = startBal > 0 ? ((endBal - startBal) / startBal) * 100 : 0;

  const startLabel = keys[0] ? new Date(keys[0] + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const endKey = slice[slice.length - 1];
  const endLabel = endKey ? new Date(endKey + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  // monthly income / expenses
  const perMonth = { daily: 30, weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12, once: 0 };
  const mIn = accTxns.filter((x) => x.type === "income").reduce((s, x) => s + x.amount * (perMonth[x.frequency] || 0), 0);
  const mOut = accTxns.filter((x) => x.type === "expense").reduce((s, x) => s + x.amount * (perMonth[x.frequency] || 0), 0);
  const net = mIn - mOut;
  const savingsRate = mIn > 0 ? Math.round((net / mIn) * 100) : 0;
  const ratio = mOut > 0 ? (mIn / mOut) : 0;
  const runwayMonths = mOut > 0 ? Math.floor(balance / mOut) : 99;
  const savingsLabel = savingsRate >= 30 ? "EXCELLENT" : savingsRate >= 15 ? "GOOD" : savingsRate >= 0 ? "FAIR" : "OVERSPENDING";
  const totalSelBal = accounts.filter((a) => selected.includes(a.id)).reduce((s, a) => s + a.balance, 0);

  // chart geometry
  const w = 320, h = 130, pad = 6;
  const allVals = series.length ? [...series, balance] : [balance];
  const mn = Math.min(...allVals), mx = Math.max(...allVals);
  const rng = mx - mn || 1;
  const X = (i) => pad + (i / Math.max(1, series.length - 1)) * (w - pad * 2);
  const Y = (v) => pad + (1 - (v - mn) / rng) * (h - pad * 2);
  const line = series.map((v, i) => `${i === 0 ? "M" : "L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");

  return (
    <div className="cc-overlay" style={{ ...S.overlay, alignItems: "stretch" }} onClick={onClose}>
      <div className="cc-sheet" style={{ ...S.detailSheet, background: "#fff", maxHeight: "100%", borderRadius: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 2px 14px" }}>
          <button onClick={onClose} style={S.iconBtn}>✕</button>
          <div style={{ flex: 1, textAlign: "center", fontSize: 22, fontWeight: 800 }}>Insights</div>
          <span style={{ ...S.editPill, color: "#1c1c1e", background: "#f2f2f7" }}>✎ Edit</span>
        </div>

        <div style={S.detailBody} className="cc-cal">
          {/* Projected Balance card */}
          <div style={S.insightCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>📈</span>
              <span style={{ fontSize: 19, fontWeight: 800, flex: 1 }}>Projected Balance</span>
              <span style={{ color: "#b0b0b5", fontSize: 20 }}>›</span>
            </div>
            <div style={{ fontSize: 40, fontWeight: 800, color: "#0a84ff", marginTop: 8 }}>{fmtK(endBal)}</div>
            <div style={{ fontSize: 14, color: "#8e8e93" }}>in {months} months</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: pct >= 0 ? "#0a84ff" : "#ff453a", marginTop: 2 }}>
              {pct >= 0 ? "↑" : "↓"} {Math.abs(pct).toFixed(1)}% <span style={{ color: "#8e8e93", fontWeight: 500 }}>from {fmtK(startBal)}</span>
            </div>
            <svg viewBox={`0 0 ${w} ${h}`} style={{ width: "100%", height: 110, marginTop: 10 }}>
              <path d={line} fill="none" stroke="#0a84ff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            </svg>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 4 }}>
              <span style={{ fontSize: 14, color: "#8e8e93", fontWeight: 600 }}>{startLabel}</span>
              <select value={months} onChange={(e) => setMonths(Number(e.target.value))} style={S.pillSelect}>
                {[3, 6, 12].map((m) => <option key={m} value={m}>{m} Months</option>)}
              </select>
              <span style={{ fontSize: 14, color: "#8e8e93", fontWeight: 600 }}>{endLabel}</span>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {accounts.map((a) => {
                const on = selected.includes(a.id);
                return (
                  <button key={a.id} onClick={() => toggle(a.id)} style={{ ...S.acctChip,
                    border: on ? "1.5px solid #0a84ff" : "1.5px solid #e3e3e8", color: "#1c1c1e" }}>
                    <span style={{ color: on ? "#0a84ff" : "#c7c7cc" }}>{on ? "✓" : "○"}</span>
                    {a.name === "Savings" ? "💰" : "🏦"} {a.name} <b>{fmtK(a.balance)}</b>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Net Worth ring */}
          <div style={S.insightCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 36, height: 36, borderRadius: 18, background: "#efe6fb", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>👛</span>
              <span style={{ fontSize: 19, fontWeight: 800, flex: 1 }}>Net Worth</span>
              <span style={{ background: "#d6f5e3", color: "#1a8a4a", borderRadius: 12, padding: "4px 10px", fontSize: 13, fontWeight: 800 }}>↗ 2.5%</span>
            </div>
            <div style={{ fontSize: 36, fontWeight: 800, margin: "10px 0" }}>{fmtFull(totalSelBal).replace(".00", "")}</div>
            <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}>
              <div style={{ position: "relative", width: 170, height: 170 }}>
                <svg viewBox="0 0 170 170" style={{ width: 170, height: 170 }}>
                  <circle cx="85" cy="85" r="70" fill="none" stroke="#ececef" strokeWidth="16" />
                  <circle cx="85" cy="25" r="9" fill="#ff6b6b" />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: "#7a3fb0" }}>0%</span>
                  <span style={{ fontSize: 15, color: "#8e8e93" }}>Assets</span>
                </div>
              </div>
            </div>
            <div style={{ textAlign: "center", color: "#8e8e93", fontSize: 14 }}>ⓘ Tap for details</div>
          </div>

          {/* Runway + Savings Rate */}
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ ...S.insightCard, flex: 1, marginBottom: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>Runway</div>
              <div style={{ fontSize: 13, color: "#8e8e93" }}>Based on current spending</div>
              <div style={{ fontSize: 40, fontWeight: 800, margin: "12px 0 8px" }}>{runwayMonths >= 99 ? "∞" : runwayMonths + "m"}</div>
              <div style={{ fontSize: 13, color: "#8e8e93" }}>Based on current spending</div>
            </div>
            <div style={{ ...S.insightCard, flex: 1, marginBottom: 12 }}>
              <div style={{ fontSize: 20, fontWeight: 800 }}>Savings Rate</div>
              <div style={{ fontSize: 13, color: "#8e8e93" }}>This month</div>
              <div style={{ fontSize: 40, fontWeight: 800, margin: "12px 0 8px" }}>{savingsRate}%</div>
              <span style={{ display: "inline-block", border: "1.5px solid #30d158", color: "#1a8a4a", borderRadius: 12, padding: "5px 12px", fontSize: 13, fontWeight: 800 }}>{savingsLabel}</span>
            </div>
          </div>

          {/* Income vs Expenses */}
          <div style={S.insightCard}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>⇄</span>
              <span style={{ fontSize: 19, fontWeight: 800, flex: 1 }}>Income vs Expenses</span>
              <span style={{ background: "#d6f5e3", color: "#1a8a4a", borderRadius: 12, padding: "4px 10px", fontSize: 13, fontWeight: 800 }}>↗ {ratio.toFixed(1)}:1</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
              <span style={{ fontSize: 17, fontWeight: 700 }}>↗ Income</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: "#30a85f" }}>{fmtFull(mIn).replace(".00", "")}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12 }}>
              <span style={{ fontSize: 17, fontWeight: 700 }}>↘ Expenses</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: "#ff6b6b" }}>{fmtFull(mOut).replace(".00", "")}</span>
            </div>
            <div style={{ borderTop: "0.5px solid #e3e3e8", margin: "14px 0", paddingTop: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 17, fontWeight: 800 }}>✅ Net</span>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#7a3fb0" }}>{fmtFull(net).replace(".00", "")}</span>
            </div>
          </div>
          <div style={{ height: 30 }} />
        </div>
      </div>
    </div>
  );
}

const Calendar = React.memo(function Calendar({ dayMap, forecast, end, onTapTx, onEditWarnings, showProjectedBalances = true }) {
  const scrollRef = useRef(null);

  const weeks = useMemo(() => {
    const start = new Date(todayISO() + "T00:00:00");
    const monday = new Date(start);
    monday.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const days = [];
    const cur = new Date(monday);
    while (cur <= end) { days.push(new Date(cur)); cur.setDate(cur.getDate() + 1); }
    const w = [];
    for (let i = 0; i < days.length; i += 7) w.push(days.slice(i, i + 7));
    return w;
  }, [end]);

  const todayKey = todayISO();
  const [monthLabel, setMonthLabel] = useState(() => {
    const d = new Date(); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  });
  function onScroll(e) {
    const idx = Math.min(weeks.length - 1, Math.floor(e.target.scrollTop / 118) + 1);
    const ref = weeks[idx]?.[3] || weeks[idx]?.[0];
    if (ref) setMonthLabel(`${MONTHS[ref.getMonth()]} ${ref.getFullYear()}`);
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={S.bannerWrap}>
        <div onClick={onEditWarnings} style={{ ...S.banner, background: forecast.bg, borderLeft: `4px solid ${forecast.accent}`, cursor: "pointer" }}>
          <div style={{ fontSize: 26 }}>{forecast.icon}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, color: forecast.color, fontSize: 17 }}>{forecast.title}</div>
            <div style={{ fontSize: 14, color: forecast.color, lineHeight: 1.3, marginTop: 1 }}>{forecast.body}</div>
          </div>
          <span style={S.editPill} onClick={(e) => { e.stopPropagation(); onEditWarnings(); }}>Edit</span>
        </div>
      </div>

      <div style={S.dowRow}>
        {DOW.map((d) => <div key={d} style={S.dowCell} className="cc-dow-cell">{d}</div>)}
      </div>

      <div style={{ position: "relative", height: 0 }}>
        <div style={S.monthChip} className="cc-month-chip">{monthLabel} ⌄</div>
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="cc-cal" style={S.calScroll}>
        <div style={{ height: 30 }} />
        {weeks.map((week, wi) => (
          <div key={wi} style={S.weekRow}>
            {week.map((day) => {
              const key = dISO(day);
              const info = dayMap[key];
              const isToday = key === todayKey;
              const isPast = key < todayKey;
              const isFirst = day.getDate() === 1;
              return (
                <div key={key} style={{ ...S.dayCell, opacity: isPast ? 0.4 : 1 }}>
                  <div style={S.dateNumWrap}>
                    {isToday ? (
                      <span style={S.todayCircle}>{day.getDate()}</span>
                    ) : (
                      <span style={{ fontSize: 15, fontWeight: 600, color: "#1c1c1e" }}>
                        {isFirst ? `${MONTHS[day.getMonth()].slice(0, 3)} 1` : day.getDate()}
                      </span>
                    )}
                  </div>
                  {info?.changed && !isPast && showProjectedBalances && <div style={S.balPill} className="cc-bal-pill">{fmtK(info.balance)}</div>}
                  {info?.txs?.map((tx) => {
                    const t = tintFor(tx);
                    const m = catMeta(tx.category);
                    const isGoal = tx.type === "goal";
                    const planned = tx.type === "income" && tx.status === "planned";
                    return (
                      <button key={tx.id + key} onClick={() => onTapTx(tx)}
                        style={{ ...S.txBlock, background: t.bg,
                          borderLeft: `3px solid ${t.accent}`,
                          borderStyle: isGoal || planned ? "dashed" : "solid",
                          opacity: planned ? 0.82 : 1 }}>
                        <span style={{ fontSize: 15 }}>{m.icon}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: t.text, lineHeight: 1.05 }}>
                          {tx.name.length > 7 ? tx.name.slice(0, 6) + "…" : tx.name}
                        </span>
                        <span style={{ fontSize: 11, fontWeight: 800, color: t.text }}>
                          {isGoal ? "🎯" : tx.type === "income" ? "+" : "-"}{fmtK(tx.amount)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
        <div style={{ height: 120 }} />
      </div>
    </div>
  );
});

// ============================================================================
// ============================================================================
// BUDGET VIEW — period switcher, summary cards, category assignment
// ============================================================================
const BUDGET_CATEGORIES = [
  { id: "personal", label: "Personal", icon: "🛍️", bg: "#fbdce7" },
  { id: "transport", label: "Transportation", icon: "🚗", bg: "#cfe9fb" },
  { id: "education", label: "Education", icon: "📚", bg: "#d3f1e4" },
  { id: "entertainment", label: "Entertainment", icon: "🎬", bg: "#e7dcf6" },
  { id: "food", label: "Food", icon: "🍔", bg: "#fdefc8" },
  { id: "healthcare", label: "Healthcare", icon: "🏥", bg: "#fbd9dd" },
  { id: "housing", label: "Housing", icon: "🏠", bg: "#e7ddd0" },
  { id: "utilities", label: "Utilities", icon: "💡", bg: "#fdf0c4" },
  { id: "savings", label: "Savings", icon: "🌱", bg: "#d8f3d8" },
];
const PERIODS = [
  { id: "weekly", label: "Weekly", days: 7, sub: "Plan your budget week by week", icon: "📅", bg: "#d3f1d8", confirm: false },
  { id: "monthly", label: "Monthly", days: 30, sub: "Traditional monthly budgeting", icon: "🗓️", bg: "#efdcf7", confirm: true },
  { id: "payperiod", label: "Pay Period", days: 14, sub: "Match your specific pay schedule", icon: "💵", bg: "#fde7c4", confirm: true },
  { id: "custom", label: "Custom Range", days: 14, sub: "Choose your own start and end dates", icon: "🎚️", bg: "#ececef", confirm: true },
];

function startOfPeriod(d, period) {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  if (period === "monthly") { x.setDate(1); return dISO(x); }
  // day-based periods (weekly / payperiod / custom) -> back to Sunday
  x.setDate(x.getDate() - x.getDay());
  return dISO(x);
}
function endOfPeriod(startISO, period) {
  const days = PERIODS.find((p) => p.id === period)?.days || 7;
  const e = new Date(startISO + "T00:00:00");
  if (period === "monthly") { e.setMonth(e.getMonth() + 1); e.setDate(0); return dISO(e); }
  e.setDate(e.getDate() + days - 1);
  return dISO(e);
}

function BudgetView({ accTxns, acc, period, setPeriod, start, setStart, budgeted, setBudgeted, assigned, assignTo }) {
  const [periodOpen, setPeriodOpen] = useState(false);
  const [editingCat, setEditingCat] = useState(null); // category id being assigned
  const [budgetEdit, setBudgetEdit] = useState(false);

  const end = endOfPeriod(start, period);
  const startD = new Date(start + "T00:00:00");
  const endD = new Date(end + "T00:00:00");
  const fmtD = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  // planned spend per category within this period (from expense transactions)
  const planned = {};
  for (const tx of accTxns.filter((x) => x.type === "expense")) {
    for (const d of occurrences(tx, startD, endD)) {
      const cat = expenseToBudgetCat(tx);
      planned[cat] = (planned[cat] || 0) + tx.amount;
      void d;
    }
  }

  const totalAssigned = Object.values(assigned).reduce((s, v) => s + (Number(v) || 0), 0);
  const leftToAssign = budgeted - totalAssigned;
  const fullyAssigned = budgeted > 0 && Math.abs(leftToAssign) < 0.01;

  function shiftPeriod(dir) {
    const days = PERIODS.find((p) => p.id === period)?.days || 7;
    const s = new Date(start + "T00:00:00");
    if (period === "monthly") s.setMonth(s.getMonth() + dir);
    else s.setDate(s.getDate() + dir * days);
    setStart(dISO(s));
  }
  const [pendingPeriod, setPendingPeriod] = useState(null); // period awaiting confirm
  function applyPeriod(p) {
    setPeriod(p);
    setStart(startOfPeriod(new Date(start + "T00:00:00"), p));
    setPeriodOpen(false);
    setPendingPeriod(null);
  }
  function changePeriod(p) {
    // same period -> just close; different -> confirm first
    if (p === period) { setPeriodOpen(false); return; }
    setPendingPeriod(p);
  }

  return (
    <div style={S.bodyScroll} className="cc-cal">
      {/* period switcher */}
      <div style={S.periodRow}>
        <button onClick={() => shiftPeriod(-1)} style={S.periodArrow}>‹ {fmtD(startD).split(",")[0]}</button>
        <button onClick={() => setPeriodOpen((v) => !v)} style={S.periodPill}>
          🗓️ {PERIODS.find((p) => p.id === period)?.label} ⌄
        </button>
        <button onClick={() => shiftPeriod(1)} style={{ ...S.periodArrow, textAlign: "right" }}>{fmtD(endD).split(",")[0]} ›</button>
      </div>
      {periodOpen && (
        <PeriodPicker current={period} onClose={() => setPeriodOpen(false)} onPick={changePeriod} />
      )}
      {pendingPeriod && (
        <ConfirmPeriod period={pendingPeriod}
          onCancel={() => setPendingPeriod(null)} onConfirm={() => applyPeriod(pendingPeriod)} />
      )}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#8e8e93", fontWeight: 700, margin: "0 4px 10px" }}>
        <span>{fmtD(startD)}</span><span>{fmtD(endD)}</span>
      </div>

      {/* summary cards */}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={() => setBudgetEdit(true)} style={{ ...S.sumCard, background: "#e8f0fe" }}>
          <div style={{ fontSize: 13, color: "#3a3a3c", fontWeight: 700 }}>Budgeted</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#0a84ff" }}>{fmtK(budgeted)}</div>
        </button>
        <div style={{ ...S.sumCard, background: "#f2f2f7" }}>
          <div style={{ fontSize: 13, color: "#8e8e93", fontWeight: 700 }}>Assigned</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#8e8e93" }}>{fmtK(totalAssigned)}</div>
        </div>
        <div style={{ ...S.sumCard, background: fullyAssigned ? "#d6f5e3" : "#eaf7ee" }}>
          <div style={{ fontSize: 13, color: "#1a8a4a", fontWeight: 700 }}>{fullyAssigned ? "Fully Assigned" : "Left"}</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#30a85f" }}>{fmtK(fullyAssigned ? 0 : leftToAssign)}</div>
        </div>
      </div>

      {/* prompt or status */}
      {budgeted === 0 ? (
        <button onClick={() => setBudgetEdit(true)} style={S.budgetPrompt}>
          <span style={{ fontSize: 24 }}>💰</span>
          <div style={{ flex: 1, textAlign: "left" }}>
            <div style={{ fontWeight: 800, color: "#0a64d6", fontSize: 16 }}>Set your budget to get started</div>
            <div style={{ fontSize: 13, color: "#0a64d6", lineHeight: 1.3, marginTop: 2 }}>
              Tap the Budgeted card above to enter your income for this period
            </div>
          </div>
          <span style={{ color: "#0a64d6", fontSize: 20 }}>›</span>
        </button>
      ) : (
        <div style={{ ...S.budgetPrompt, background: fullyAssigned ? "#d6f5e3" : "#fff7e0", borderColor: fullyAssigned ? "#30d158" : "#ffcf5a" }}>
          <span style={{ fontSize: 22 }}>{fullyAssigned ? "✅" : "⚠️"}</span>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 700, color: fullyAssigned ? "#1a8a4a" : "#8a5a00" }}>
            {fullyAssigned ? "Every dollar has a job. Nice work!" : `${fmtK(Math.abs(leftToAssign))} ${leftToAssign > 0 ? "left to assign" : "over-assigned"}`}
          </div>
        </div>
      )}

      {/* categories header */}
      <div style={{ display: "flex", justifyContent: "space-between", margin: "20px 4px 6px" }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#8e8e93", letterSpacing: 0.5 }}>CATEGORIES</span>
        <span style={{ fontSize: 13, fontWeight: 800, color: "#8e8e93", letterSpacing: 0.5 }}>ASSIGNED {fmtK(totalAssigned)}</span>
      </div>

      {/* category rows */}
      <div>
        {BUDGET_CATEGORIES.map((c) => {
          const a = Number(assigned[c.id]) || 0;
          const pl = planned[c.id] || 0;
          return (
            <div key={c.id} style={S.catRow}>
              <div style={{ ...S.catTile, background: c.bg }}>{c.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 19, fontWeight: 800, color: "#3a3a3c" }}>{c.label}</div>
                <div style={{ fontSize: 14, color: "#8e8e93", marginTop: 4 }}>{fmtK(pl)} planned</div>
              </div>
              <button onClick={() => setEditingCat(c.id)} style={{ ...S.assignPill,
                background: a > 0 ? "#0a84ff" : "#f2f2f7", color: a > 0 ? "#fff" : "#8e8e93" }}>
                {fmtK(a)}
              </button>
            </div>
          );
        })}
      </div>
      <div style={{ height: 120 }} />

      {/* set-budget calculator */}
      {budgetEdit && (
        <AmountPrompt context="Budget" subtitle="Set your budget for this period"
          value={budgeted} balance={acc?.balance ?? 0}
          onClose={() => setBudgetEdit(false)} onSave={(v) => { setBudgeted(v); setBudgetEdit(false); }} />
      )}
      {/* assign-to-category calculator */}
      {editingCat && (
        <AmountPrompt
          context={BUDGET_CATEGORIES.find((c) => c.id === editingCat)?.label}
          subtitle={budgeted > 0 ? `${fmtK(leftToAssign)} left to assign` : "Set a budget first to track this"}
          value={Number(assigned[editingCat]) || 0} balance={acc?.balance ?? 0}
          onClose={() => setEditingCat(null)}
          onSave={(v) => { assignTo(editingCat, v); setEditingCat(null); }} />
      )}
    </div>
  );
}

// "Select Budget Period" sheet (image 4)
function PeriodPicker({ current, onClose, onPick }) {
  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={{ ...S.detailSheet, maxHeight: "92%" }} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
          <div style={{ width: 64, height: 64, borderRadius: 32, background: "#e3edff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 30, margin: "0 auto 12px" }}>📅</div>
          <div style={{ fontSize: 24, fontWeight: 800 }}>Select Budget Period</div>
          <div style={{ fontSize: 15, color: "#8e8e93", marginTop: 4 }}>Choose how you want to organize your budget</div>
        </div>
        <div style={{ marginTop: 14 }}>
          {PERIODS.map((p) => {
            const active = p.id === current;
            return (
              <button key={p.id} onClick={() => onPick(p.id)}
                style={{ ...S.periodCard, border: active ? "2px solid #5e7cf5" : "1px solid #e3e3e8",
                  background: active ? "#f5f7ff" : "#fff" }}>
                <span style={{ width: 50, height: 50, borderRadius: 25, background: p.bg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>{p.icon}</span>
                <div style={{ flex: 1, textAlign: "left" }}>
                  <div style={{ fontSize: 19, fontWeight: 800 }}>{p.label}</div>
                  <div style={{ fontSize: 14, color: "#8e8e93", marginTop: 2 }}>{p.sub}</div>
                </div>
                <span style={{ color: "#b0b0b5", fontSize: 22 }}>›</span>
              </button>
            );
          })}
        </div>
        <div style={{ height: 14 }} />
      </div>
    </div>
  );
}

// confirm dialog (image 5)
function ConfirmPeriod({ period, onCancel, onConfirm }) {
  const p = PERIODS.find((x) => x.id === period) || PERIODS[0];
  const copy = {
    monthly: "Switch to monthly budgeting like YNAB? This will budget from the 1st to the last day of each month, giving you a consistent monthly view of your finances.",
    payperiod: "Switch to pay-period budgeting? Your budget will align with your pay schedule so every paycheck has a plan.",
    custom: "Switch to a custom range? You'll choose your own start and end dates for each budgeting period.",
    weekly: "Switch to weekly budgeting? This plans your money one week at a time, Sunday through Saturday.",
  };
  return (
    <div className="cc-overlay" style={{ ...S.overlay, alignItems: "center", justifyContent: "center", padding: 24 }} onClick={onCancel}>
      <div style={S.confirmCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <div style={{ flex: 1, fontSize: 22, fontWeight: 800 }}>Switch to {p.label} Budgeting?</div>
          <button onClick={onCancel} style={S.closeX} aria-label="Close">✕</button>
        </div>
        <div style={{ fontSize: 16, color: "#6a6a6e", lineHeight: 1.5, margin: "12px 0 20px" }}>
          {copy[period] || `Switch to ${p.label} budgeting?`}
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={onCancel} style={S.confirmCancel}>Cancel</button>
          <button onClick={onConfirm} style={S.confirmGo}>Switch to {p.label}</button>
        </div>
      </div>
    </div>
  );
}

// map an expense transaction to a budget category id
function expenseToBudgetCat(tx) {
  const m = { rent: "housing", car: "transport", food: "food", bills: "utilities", phone: "utilities", subs: "entertainment" };
  const byBudget = { housing: "housing", transport: "transport", food: "food", utilities: "utilities", fun: "entertainment", health: "healthcare", other: "personal" };
  return byBudget[tx.budget] || m[tx.category] || "personal";
}

// small amount-entry popup used by the budget screen
function AmountPrompt({ title, subtitle, value, balance, context, onClose, onSave }) {
  // expression-based calculator. `expr` holds the live string, `display` the shown result.
  const [expr, setExpr] = useState(value ? String(value) : "");
  const [decimal, setDecimal] = useState(true); // $.00 mode
  const ctxLabel = context || "Budget";

  function evalExpr(s) {
    if (!s) return 0;
    const clean = s.replace(/×/g, "*").replace(/÷/g, "/").replace(/[^0-9+\-*/.]/g, "");
    try {
      // eslint-disable-next-line no-new-func
      const r = Function(`"use strict";return (${clean})`)();
      return isFinite(r) ? r : 0;
    } catch { return 0; }
  }
  const result = evalExpr(expr);
  const shown = decimal ? result.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : Math.round(result).toLocaleString("en-US");

  function press(k) {
    if (k === "C") { setExpr(""); return; }
    if (k === "back") { setExpr((e) => e.slice(0, -1)); return; }
    if ("+-×÷".includes(k)) {
      setExpr((e) => (e === "" ? e : /[+\-×÷]$/.test(e) ? e.slice(0, -1) + k : e + k));
      return;
    }
    setExpr((e) => e + k);
  }

  const keys = ["7","8","9","×","4","5","6","÷","1","2","3","+","C","0",".","-"];
  const isOp = (k) => "+-×÷".includes(k);

  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={{ ...S.calcSheet }} onClick={(e) => e.stopPropagation()}>
        {/* header */}
        <div style={S.calcHead}>
          <span style={{ fontSize: 18 }}>💰</span>
          <span style={{ flex: 1, fontSize: 17, fontWeight: 600 }}>Assigning funds to <b>{ctxLabel}</b></span>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>
        {/* tip strip */}
        <div style={S.calcTip}>
          <span style={{ fontSize: 16 }}>💡</span>
          <span style={{ color: "#0a84ff", fontWeight: 700, fontSize: 16 }}>{subtitle || "Set your budget for this period"}</span>
        </div>
        {/* decimal toggle + live total */}
        <div style={S.calcTotalRow}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 800, color: "#8e8e93", letterSpacing: 0.6 }}>DECIMAL</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
              <span style={{ color: "#0a84ff", fontWeight: 800 }}>$.00</span>
              <MiniToggle on={decimal} onChange={setDecimal} />
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 38, fontWeight: 800, color: "#0a84ff", lineHeight: 1 }}>${shown}</div>
            <div style={{ fontSize: 14, color: "#8e8e93" }}>{expr || "0"}</div>
          </div>
        </div>
        {/* current balance chip */}
        {balance != null && (
          <div style={S.balChip}>
            Current Balance <b style={{ color: "#0a84ff" }}>{fmtFull(balance).replace(".00", "")}</b>
          </div>
        )}
        {/* keypad */}
        <div style={S.keypad}>
          {keys.map((k) => (
            <button key={k} onClick={() => press(k)} style={{
              ...S.key, color: isOp(k) ? "#0a84ff" : k === "C" ? "#8e8e93" : "#1c1c1e",
            }}>{k}</button>
          ))}
        </div>
        {/* footer: backspace + done */}
        <div style={S.calcFooter}>
          <button onClick={() => press("back")} style={S.backKey} aria-label="Backspace">⌫</button>
          <button onClick={() => onSave(Math.max(0, result))} style={S.doneBtn}>done</button>
        </div>
        <div style={{ height: 6 }} />
      </div>
    </div>
  );
}

function MiniToggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 42, height: 25, borderRadius: 25, border: "none", cursor: "pointer",
      background: on ? "#0a84ff" : "#c7c7cc", position: "relative", transition: "background .2s", padding: 0,
    }}>
      <span style={{ position: "absolute", top: 2, left: on ? 19 : 2, width: 21, height: 21,
        borderRadius: "50%", background: "#fff", transition: "left .2s", boxShadow: "0 1px 2px rgba(0,0,0,.3)" }} />
    </button>
  );
}

// ============================================================================
// ============================================================================
// LEDGER — tabbed account/ledger screen (History / Balances / Income / etc.)
// ============================================================================
function Ledger({ accounts, setAccounts, txns }) {
  const [tab, setTab] = useState("balances");
  const tabs = ["History", "Balances", "Income", "Expenses", "Assets", "Liabilities", "Goals"];

  const perMonth = { daily: 30, weekly: 52 / 12, biweekly: 26 / 12, monthly: 1, yearly: 1 / 12, once: 0 };
  const monthly = (list) => list.reduce((s, x) => s + x.amount * (perMonth[x.frequency] || 0), 0);
  const incomeTx = txns.filter((x) => x.type === "income");
  const expenseTx = txns.filter((x) => x.type === "expense");

  const tabsRef = useRef(null);
  const drag = useRef({ down: false, startX: 0, scroll: 0, moved: false });

  function onDown(e) {
    const el = tabsRef.current; if (!el) return;
    drag.current = { down: true, startX: e.clientX ?? e.touches?.[0]?.clientX ?? 0, scroll: el.scrollLeft, moved: false };
  }
  function onMove(e) {
    const el = tabsRef.current; if (!el || !drag.current.down) return;
    const x = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
    const dx = x - drag.current.startX;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    el.scrollLeft = drag.current.scroll - dx;
  }
  function onUp() { drag.current.down = false; }

  function selectTab(id) {
    if (drag.current.moved) return; // ignore click that was actually a drag
    setTab(id);
    // scroll the chosen tab into view
    const el = tabsRef.current;
    const btn = el?.querySelector(`[data-tab="${id}"]`);
    if (btn) btn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* horizontal swipeable tab bar */}
      <div ref={tabsRef} className="cc-hscroll cc-drag" style={S.ledgerTabs}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp}
        onTouchStart={onDown} onTouchMove={onMove} onTouchEnd={onUp}>
        {tabs.map((t) => {
          const id = t.toLowerCase();
          const active = id === tab;
          return (
            <button key={t} data-tab={id} onClick={() => selectTab(id)}
              style={{ ...S.ledgerTab, color: active ? "#1c1c1e" : "#b0b0b5" }}>
              {t}
              {active && <div style={S.ledgerUnderline} />}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }} className="cc-cal">
        {tab === "balances" && <BalancesTab accounts={accounts} setAccounts={setAccounts} />}
        {tab === "history" && <LedgerList title="Recent activity" rows={[...incomeTx, ...expenseTx].slice(0, 30).map((x) => ({
          left: x.name, right: (x.type === "income" ? "+" : "-") + fmtFull(x.amount), color: x.type === "income" ? "#30a85f" : "#1c1c1e",
        }))} />}
        {tab === "income" && <LedgerTable cols={["SOURCE", "MONTHLY", "FREQ"]} rows={incomeTx.map((x) => [x.name, fmtFull(x.amount * (perMonth[x.frequency] || 0)), FREQ_LABEL[x.frequency] || "—"])} footer={["Total /mo", fmtFull(monthly(incomeTx)), ""]} />}
        {tab === "expenses" && <LedgerTable cols={["EXPENSE", "MONTHLY", "FREQ"]} rows={expenseTx.map((x) => [x.name, fmtFull(x.amount * (perMonth[x.frequency] || 0)), FREQ_LABEL[x.frequency] || "—"])} footer={["Total /mo", fmtFull(monthly(expenseTx)), ""]} />}
        {tab === "assets" && <LedgerTable cols={["ASSET", "VALUE", "TYPE"]} rows={accounts.map((a) => [a.name, fmtFull(a.balance), "Cash"])} footer={["Net worth", fmtFull(accounts.reduce((s, a) => s + a.balance, 0)), ""]} />}
        {tab === "liabilities" && (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "#8e8e93" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>🎉</div>
            <div style={{ fontWeight: 700 }}>No liabilities tracked</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Add a loan or credit card to see it here.</div>
          </div>
        )}
        {tab === "goals" && (() => {
          const goals = txns.filter((x) => x.type === "goal");
          if (!goals.length) return (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#8e8e93" }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🌱</div>
              <div style={{ fontWeight: 700 }}>No goals yet</div>
              <div style={{ fontSize: 13, marginTop: 4 }}>Tap + → Goal to start saving toward something.</div>
            </div>
          );
          return <LedgerTable cols={["GOAL", "TARGET", "BY"]}
            rows={goals.map((g) => [g.name, fmtFull(g.amount),
              new Date(g.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })])}
            footer={["Total target", fmtFull(goals.reduce((s, g) => s + g.amount, 0)), ""]} />;
        })()}
        <div style={{ height: 120 }} />
      </div>
    </div>
  );
}

function BalancesTab({ accounts, setAccounts }) {
  return (
    <div style={{ width: "100%", boxSizing: "border-box" }}>
      <div>
        <div style={S.ledgerHead}>
          <div style={{ flex: 2, minWidth: 0 }}>ACCOUNT</div>
          <div style={{ flex: 1, textAlign: "right", minWidth: 0 }}>BALANCE</div>
          <div style={{ width: 44, textAlign: "right" }}>APY</div>
          <div style={{ width: 30, textAlign: "center" }}>IN</div>
        </div>
        {accounts.map((a) => (
          <div key={a.id} style={S.ledgerRow}>
            <div style={{ flex: 2, fontSize: 18, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.name}</div>
            <div style={{ flex: 1, textAlign: "right", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 800, fontSize: 17 }}>$</span>
              <input type="number" defaultValue={a.balance}
                onBlur={(e) => setAccounts((p) => p.map((x) => x.id === a.id ? { ...x, balance: parseFloat(e.target.value) || 0 } : x))}
                style={S.ledgerBalInput} />
            </div>
            <div style={{ width: 44, textAlign: "right", color: "#b0b0b5", fontSize: 16 }}>—</div>
            <div style={{ width: 30, textAlign: "center" }}>
              <span style={{ width: 11, height: 11, borderRadius: 6, background: "#30d158", display: "inline-block" }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LedgerTable({ cols, rows, footer }) {
  return (
    <div style={{ width: "100%", boxSizing: "border-box" }}>
      <div>
        <div style={S.ledgerHead}>
          {cols.map((c, i) => (
            <div key={c} style={{ flex: i === 0 ? 2 : 1, textAlign: i === 0 ? "left" : "right", minWidth: 0 }}>{c}</div>
          ))}
        </div>
        {rows.length === 0 && <div style={{ padding: "30px 16px", textAlign: "center", color: "#8e8e93" }}>Nothing here yet.</div>}
        {rows.map((r, ri) => (
          <div key={ri} style={S.ledgerRow}>
            {r.map((cell, ci) => (
              <div key={ci} style={{ flex: ci === 0 ? 2 : 1, textAlign: ci === 0 ? "left" : "right",
                fontSize: ci === 0 ? 17 : 15, fontWeight: ci === 0 ? 700 : 600,
                color: ci === 0 ? "#1c1c1e" : "#3a3a3c", minWidth: 0, overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cell}</div>
            ))}
          </div>
        ))}
        {footer && rows.length > 0 && (
          <div style={{ ...S.ledgerRow, borderTop: "1px solid #e3e3e8", background: "#fafafa" }}>
            {footer.map((cell, ci) => (
              <div key={ci} style={{ flex: ci === 0 ? 2 : 1, textAlign: ci === 0 ? "left" : "right",
                fontSize: 15, fontWeight: 800, color: "#1c1c1e", minWidth: 0 }}>{cell}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LedgerList({ title, rows }) {
  return (
    <div style={{ padding: "8px 16px" }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: "#8e8e93", letterSpacing: 0.5, margin: "8px 0" }}>{title.toUpperCase()}</div>
      {rows.length === 0 && <div style={{ color: "#8e8e93", padding: 10 }}>No activity yet.</div>}
      {rows.map((r, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "13px 2px", borderBottom: "0.5px solid #f0f0f0" }}>
          <span style={{ fontWeight: 600 }}>{r.left}</span>
          <span style={{ fontWeight: 800, color: r.color }}>{r.right}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================================
// DEBTS — Credit Cards / Debts / IOUs tracker + bank account adder
// ============================================================================
const US_BANKS = [
  "Chase", "Bank of America", "Wells Fargo", "Citibank", "PNC Bank", "U.S. Bank",
  "Capital One", "TD Bank", "Truist", "Goldman Sachs (Marcus)", "American Express",
  "Discover", "Ally Bank", "Charles Schwab Bank", "Fifth Third Bank", "Citizens Bank",
  "KeyBank", "Regions Bank", "Huntington Bank", "M&T Bank", "BMO Harris", "HSBC",
  "Navy Federal Credit Union", "USAA", "SoFi", "Chime", "Synchrony Bank",
  "Barclays", "First Citizens Bank", "Comerica", "Other / Local bank",
];
const DEBT_TABS = [
  { id: "cards", label: "Credit Cards", kind: "card" },
  { id: "debts", label: "Debts", kind: "loan" },
  { id: "ious", label: "IOUs", kind: "iou" },
];

function Debts({ debts, addDebt, removeDebt, accounts, setAccounts, txns, setTxns, activeAccount }) {
  const [tab, setTab] = useState("cards");
  const [sheet, setSheet] = useState(false);
  const [bankSheet, setBankSheet] = useState(false);
  const [importSheet, setImportSheet] = useState(false);
  const kind = DEBT_TABS.find((t) => t.id === tab).kind;
  const list = debts.filter((d) => d.kind === kind);

  // utilization across credit cards
  const cards = debts.filter((d) => d.kind === "card");
  const totalBal = cards.reduce((s, c) => s + (c.balance || 0), 0);
  const totalLimit = cards.reduce((s, c) => s + (c.limit || 0), 0);
  const util = totalLimit > 0 ? Math.round((totalBal / totalLimit) * 100) : null;
  const utilColor = util == null ? "#ff9f0a" : util < 30 ? "#30d158" : util < 70 ? "#ff9f0a" : "#ff453a";

  const totalOwed = list.reduce((s, d) => s + (d.balance || 0), 0);
  const labels = { card: "credit card", loan: "debt", iou: "IOU" };

  return (
    <div style={S.bodyScroll} className="cc-cal">
      {/* header: prompt + utilization ring */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", margin: "8px 4px 14px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 22, fontWeight: 800 }}>Cards & Debts</div>
          <div style={{ fontSize: 14, color: "#8e8e93", marginTop: 2 }}>
            {cards.length === 0 ? "Add a credit card below" : `${cards.length} card${cards.length > 1 ? "s" : ""} tracked`}
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 70, height: 70, borderRadius: 35, border: `4px solid ${utilColor}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <span style={{ fontSize: 16 }}>{util == null ? "☀️" : util < 30 ? "☀️" : util < 70 ? "⛅" : "🌧️"}</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: utilColor }}>{util == null ? "--%" : util + "%"}</span>
          </div>
          <div style={{ fontSize: 13, color: "#8e8e93", fontWeight: 700, marginTop: 4 }}>Util.</div>
        </div>
      </div>

      {/* summary cards */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <SummaryMini label="Total owed" value={fmtK(debts.reduce((s, d) => s + (d.balance || 0), 0))} bg="#fde7e7" color="#c0392b" />
        <SummaryMini label="Cards" value={String(cards.length)} bg="#e8f0fe" color="#0a84ff" />
        <SummaryMini label="Limit" value={totalLimit ? fmtK(totalLimit) : "--"} bg="#f2f2f7" color="#3a3a3c" />
      </div>

      {/* segmented control */}
      <div style={S.debtSeg}>
        {DEBT_TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ ...S.debtSegBtn,
            background: tab === t.id ? "#fff" : "transparent",
            boxShadow: tab === t.id ? "0 1px 4px rgba(0,0,0,.12)" : "none",
            color: tab === t.id ? "#1c1c1e" : "#8e8e93" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* list */}
      <div style={{ marginTop: 14 }}>
        {list.length === 0 ? (
          <div style={{ textAlign: "center", padding: "30px 16px", color: "#8e8e93" }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>{kind === "card" ? "💳" : kind === "loan" ? "🏦" : "🤝"}</div>
            <div style={{ fontWeight: 700, color: "#3a3a3c" }}>No {labels[kind]}s yet</div>
            <div style={{ fontSize: 14, marginTop: 4 }}>Tap the + button below to add one</div>
          </div>
        ) : (
          list.map((d) => {
            const u = d.limit ? Math.round((d.balance / d.limit) * 100) : null;
            return (
              <div key={d.id} style={S.debtCard}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ ...S.catTile, background: "#e8f0fe", width: 44, height: 44, fontSize: 20 }}>
                    {kind === "card" ? "💳" : kind === "loan" ? "🏦" : "🤝"}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 17, fontWeight: 800 }}>{d.name}</div>
                    {d.bank && <div style={{ fontSize: 13, color: "#8e8e93" }}>{d.bank}</div>}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: "#c0392b" }}>{fmtFull(d.balance)}</div>
                    {d.apr ? <div style={{ fontSize: 12, color: "#8e8e93" }}>{d.apr}% APR</div> : null}
                  </div>
                </div>
                {u != null && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#8e8e93", marginBottom: 4 }}>
                      <span>{fmtK(d.balance)} of {fmtK(d.limit)}</span><span>{u}% used</span>
                    </div>
                    <div style={{ height: 7, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                      <div style={{ width: `${Math.min(100, u)}%`, height: "100%", background: u < 30 ? "#30d158" : u < 70 ? "#ff9f0a" : "#ff453a" }} />
                    </div>
                  </div>
                )}
                <button onClick={() => removeDebt(d.id)} style={S.debtRemove}>Remove</button>
              </div>
            );
          })
        )}
      </div>

      {/* add buttons */}
      <button onClick={() => setSheet(true)} style={{ ...S.primaryBtn, marginTop: 18 }}>
        + Add {labels[kind]}
      </button>
      <button onClick={() => setBankSheet(true)} style={{ ...S.btnGhostFull }}>
        🏦 Add bank account
      </button>
      <button onClick={() => setImportSheet(true)}
        style={{ ...S.btnGhostFull, marginTop: 10, borderColor: "#0a84ff", color: "#0a84ff" }}>
        📥 Import bank statement (CSV)
      </button>
      <div style={{ fontSize: 13, color: "#8e8e93", textAlign: "center", marginTop: 8, lineHeight: 1.4 }}>
        Download your statement from your bank's website as a CSV file, then import it here. Works with Chase, Bank of America, Wells Fargo, Citi, Capital One and more.
      </div>
      <div style={{ height: 120 }} />

      {sheet && <AddDebtSheet kind={kind} label={labels[kind]} onClose={() => setSheet(false)}
        onSave={(d) => { addDebt(d); setSheet(false); }} />}
      {bankSheet && <AddBankSheet onClose={() => setBankSheet(false)}
        onSave={(acc) => { setAccounts((p) => [...p, acc]); setBankSheet(false); }} />}
      {importSheet && <StatementImporter accounts={accounts} activeAccount={activeAccount}
        existingTxns={txns} dm={darkMode} onClose={() => setImportSheet(false)}
        onImport={(newTxns, balanceUpdate) => {
          setTxns(p => [...p, ...newTxns]);
          if (balanceUpdate) {
            setAccounts(p => p.map(a => a.id === balanceUpdate.acctId ? { ...a, balance: balanceUpdate.balance } : a));
          }
          setImportSheet(false);
        }} />}
    </div>
  );
}

function SummaryMini({ label, value, bg, color }) {
  return (
    <div style={{ flex: 1, background: bg, borderRadius: 14, padding: "12px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 12, color: "#8e8e93", fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

function AddDebtSheet({ kind, label, onClose, onSave }) {
  const [name, setName] = useState("");
  const [bank, setBank] = useState("");
  const [balance, setBalance] = useState("");
  const [limit, setLimit] = useState("");
  const [apr, setApr] = useState("");
  const [due, setDue] = useState("");
  const [bankOpen, setBankOpen] = useState(false);

  function submit() {
    const bal = parseFloat(balance);
    if (!name.trim() || !bal) return;
    onSave({ id: uid(), kind, name: name.trim(), bank,
      balance: bal, limit: parseFloat(limit) || 0, apr: parseFloat(apr) || 0, due });
  }

  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={S.detailSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={S.detailHead}>
          <div style={{ ...S.avatar, background: "#cfe0ff" }}>{kind === "card" ? "💳" : kind === "loan" ? "🏦" : "🤝"}</div>
          <div style={{ flex: 1, fontSize: 21, fontWeight: 800, textTransform: "capitalize" }}>Add {label}</div>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>
        <div style={S.detailBody} className="cc-cal">
          <Row label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={kind === "card" ? "e.g., Visa Rewards" : kind === "loan" ? "e.g., Car loan" : "e.g., Loan to Alex"} style={S.rowInput} />
          </Row>
          {kind !== "iou" && (
            <>
              <Row label="Bank">
                <button onClick={() => setBankOpen((v) => !v)} style={S.boxInputBtn}>
                  {bank || <span style={{ color: "#b0b0b5" }}>Select bank</span>}
                </button>
              </Row>
              {bankOpen && (
                <div style={{ ...S.dropdown, maxHeight: 220, overflowY: "auto" }} className="cc-cal">
                  {US_BANKS.map((b) => (
                    <button key={b} onClick={() => { setBank(b); setBankOpen(false); }} style={S.dropItem}>{b}</button>
                  ))}
                </div>
              )}
            </>
          )}
          <Row label="Balance">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
              <input type="number" inputMode="decimal" placeholder="0" value={balance}
                onChange={(e) => setBalance(e.target.value)} style={S.amountRowInput} />
            </div>
          </Row>
          {kind === "card" && (
            <Row label="Limit">
              <div style={{ display: "flex", alignItems: "center" }}>
                <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
                <input type="number" inputMode="decimal" placeholder="0" value={limit}
                  onChange={(e) => setLimit(e.target.value)} style={S.amountRowInput} />
              </div>
            </Row>
          )}
          {kind !== "iou" && (
            <Row label="APR %">
              <input type="number" inputMode="decimal" placeholder="0" value={apr}
                onChange={(e) => setApr(e.target.value)} style={{ ...S.rowInput, fontWeight: 700 }} />
            </Row>
          )}
          <Row label={kind === "iou" ? "Pay back by" : "Due date"}>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} style={{ ...S.rowInput, fontWeight: 600 }} />
          </Row>
        </div>
        <button onClick={submit} style={S.saveBtn}>Add {label}</button>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

function AddBankSheet({ onClose, onSave }) {
  const [bank, setBank] = useState("");
  const [nickname, setNickname] = useState("");
  const [atype, setAtype] = useState("Checking");
  const [balance, setBalance] = useState("");
  const [bankOpen, setBankOpen] = useState(false);
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f", "#64d2ff"];

  function submit() {
    if (!bank && !nickname.trim()) return;
    const name = nickname.trim() || `${bank} ${atype}`;
    onSave({ id: uid(), name, bank, atype, balance: parseFloat(balance) || 0,
      color: colors[Math.floor(Math.random() * colors.length)] });
  }

  return (
    <div className="cc-overlay" style={{ ...S.overlay, zIndex: 70 }} onClick={onClose}>
      <div className="cc-sheet" style={S.detailSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={S.detailHead}>
          <div style={{ ...S.avatar, background: "#cfe0ff" }}>🏦</div>
          <div style={{ flex: 1, fontSize: 21, fontWeight: 800 }}>Add Bank Account</div>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>
        <div style={S.detailBody} className="cc-cal">
          <Row label="Bank">
            <button onClick={() => setBankOpen((v) => !v)} style={S.boxInputBtn}>
              {bank || <span style={{ color: "#b0b0b5" }}>Select your bank</span>}
            </button>
          </Row>
          {bankOpen && (
            <div style={{ ...S.dropdown, maxHeight: 240, overflowY: "auto" }} className="cc-cal">
              {US_BANKS.map((b) => (
                <button key={b} onClick={() => { setBank(b); setBankOpen(false); }} style={S.dropItem}>{b}</button>
              ))}
            </div>
          )}
          <Row label="Nickname">
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="e.g., Everyday checking" style={S.rowInput} />
          </Row>
          <Row label="Type">
            <select value={atype} onChange={(e) => setAtype(e.target.value)} style={{ ...S.rowInput, fontWeight: 600 }}>
              {["Checking", "Savings", "Money Market", "CD", "Cash"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>
          <Row label="Balance">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
              <input type="number" inputMode="decimal" placeholder="0" value={balance}
                onChange={(e) => setBalance(e.target.value)} style={S.amountRowInput} />
            </div>
          </Row>
          <div style={{ fontSize: 12, color: "#8e8e93", padding: "6px 2px", lineHeight: 1.4 }}>
            🔒 This only stores a balance you type in. Cash Cycle never connects to your bank or asks for logins.
          </div>
        </div>
        <button onClick={submit} style={S.saveBtn}>Add Account</button>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

function Accounts({ accounts, setAccounts, activeAccount, setActiveAccount, txns }) {
  const [name, setName] = useState(""); const [bal, setBal] = useState("");
  const colors = ["#0a84ff", "#30d158", "#ff9f0a", "#bf5af2", "#ff375f"];
  function add() {
    if (!name.trim()) return;
    setAccounts((p) => [...p, { id: uid(), name: name.trim(), balance: parseFloat(bal) || 0, color: colors[p.length % colors.length] }]);
    setName(""); setBal("");
  }
  return (
    <div style={S.bodyScroll} className="cc-cal">
      <h2 style={S.h2}>Accounts</h2>
      <div style={S.statCard}>
        {accounts.map((a, i) => (
          <div key={a.id} onClick={() => setActiveAccount(a.id)}
            style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 4px",
              borderBottom: i < accounts.length - 1 ? "0.5px solid #e3e3e8" : "none", cursor: "pointer" }}>
            <span style={{ width: 12, height: 12, borderRadius: 6, background: a.color }} />
            <span style={{ flex: 1, fontWeight: 600 }}>{a.name}{activeAccount === a.id ? " ✓" : ""}</span>
            <span style={{ color: "#8e8e93" }}>$</span>
            <input type="number" defaultValue={a.balance}
              onBlur={(e) => setAccounts((p) => p.map((x) => x.id === a.id ? { ...x, balance: parseFloat(e.target.value) || 0 } : x))}
              style={S.inlineInput} />
          </div>
        ))}
      </div>
      <h2 style={{ ...S.h2, marginTop: 20 }}>Add account</h2>
      <div style={S.statCard}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={S.fullInput} />
        <input placeholder="Starting balance" type="number" value={bal} onChange={(e) => setBal(e.target.value)}
          style={{ ...S.fullInput, marginTop: 8 }} />
        <button onClick={add} style={S.primaryBtn}>Add account</button>
      </div>
      <div style={{ textAlign: "center", color: "#8e8e93", fontSize: 12, marginTop: 20 }}>
        Cash Cycle · {txns.length} transactions tracked
      </div>
      <div style={{ height: 120 }} />
    </div>
  );
}

// ============================================================================
// Budget categories + selectable icons (matches the detail sheet screenshot)
const BUDGETS = {
  expense: [
    { id: "housing", label: "Housing", icon: "🏠", icons: ["🏠", "🏢", "🏘️", "🔑", "🛋️", "🧰"] },
    { id: "transport", label: "Transport", icon: "🚗", icons: ["🚗", "⛽", "🚕", "🚌", "🚲", "🛣️"] },
    { id: "food", label: "Food", icon: "🍔", icons: ["🍔", "🛒", "🍕", "☕", "🍽️", "🥗"] },
    { id: "utilities", label: "Utilities", icon: "💡", icons: ["💡", "💧", "🔥", "📶", "📱", "🗑️"] },
    { id: "fun", label: "Lifestyle", icon: "📺", icons: ["📺", "🎮", "🎬", "🛍️", "✈️", "🎁"] },
    { id: "health", label: "Health", icon: "💊", icons: ["💊", "🏥", "🦷", "🏋️", "🧘", "👓"] },
    { id: "other", label: "Other", icon: "💳", icons: ["💳", "📦", "📝", "❓", "💸", "🔖"] },
  ],
  income: [
    { id: "salary", label: "Salary", icon: "💵", icons: ["💵", "🏦", "💼", "📈", "🪙", "💰"] },
    { id: "side", label: "Side income", icon: "💻", icons: ["💻", "🛠️", "🎨", "📷", "🚚", "✍️"] },
    { id: "gift", label: "Gifts", icon: "🎁", icons: ["🎁", "❤️", "🎉", "🤝", "💌", "🧧"] },
    { id: "other-in", label: "Other", icon: "➕", icons: ["➕", "📥", "🔁", "🏷️", "💲", "📊"] },
  ],
  goal: [
    { id: "savings", label: "Savings", icon: "🌱", icons: ["🌱", "🏦", "🐷", "💰", "🌳", "🪴"] },
    { id: "emergency", label: "Emergency", icon: "🛟", icons: ["🛟", "🚨", "⛑️", "🔒", "🛡️", "📦"] },
    { id: "bigbuy", label: "Big purchase", icon: "🛍️", icons: ["🛍️", "🚗", "🏠", "✈️", "💍", "💻"] },
    { id: "debt", label: "Pay off debt", icon: "✂️", icons: ["✂️", "💳", "🎓", "🏦", "📉", "🆓"] },
  ],
};
const RECURRENCE = [
  { id: "once", label: "None" },
  { id: "weekly", label: "Weekly" },
  { id: "biweekly", label: "Every 2 wks" },
  { id: "monthly", label: "Monthly" },
  { id: "yearly", label: "Yearly" },
];

// income icon choices (image 3 "Choose Icon" row) + recurrence units
const INCOME_ICONS = ["💰", "💵", "💴", "💶", "💷", "🏢", "💼", "📈", "⏱️", "💻", "🎁", "🪙"];
const SOURCE_TYPES = [
  { id: "salary", label: "Salary", icon: "💵" },
  { id: "hourly", label: "Hourly", icon: "⏱️" },
  { id: "freelance", label: "Freelance", icon: "💻" },
  { id: "business", label: "Business", icon: "🏢" },
  { id: "investments", label: "Investments", icon: "📈" },
  { id: "other", label: "Other", icon: "💰" },
];
const RECUR_UNITS = [
  { id: "day", label: "Day(s)" },
  { id: "week", label: "Week(s)" },
  { id: "month", label: "Month(s)" },
  { id: "year", label: "Year(s)" },
];
const unitToFreq = (every, unit) => {
  if (unit === "day") return every === 1 ? "daily" : "daily";
  if (unit === "week") return every === 2 ? "biweekly" : "weekly";
  if (unit === "month") return "monthly";
  if (unit === "year") return "yearly";
  return "once";
};

// ============================================================================
// INCOME SHEET — Planned (image 2) and Received (image 3) layouts
// ============================================================================
function IncomeSheet({ accounts, activeAccount, editing, flow, sources, onOpenSource, onClose, onSave, onDelete }) {
  const received = flow === "received";
  const [source, setSource] = useState(editing?.source || "");
  const [name, setName] = useState(editing?.name || "");
  const [notes, setNotes] = useState(editing?.notes || "");
  const [icon, setIcon] = useState(editing?.icon || "💰");
  const [amount, setAmount] = useState(editing ? String(editing.amount) : "");
  const [date, setDate] = useState(editing?.date || todayISO());
  const [account, setAccount] = useState(editing?.account || activeAccount);
  const [addToAccount, setAddToAccount] = useState(editing?.addToAccount ?? received);
  // recurrence (planned only)
  const [every, setEvery] = useState(editing?.every || 1);
  const [unit, setUnit] = useState(editing?.unit || "month");
  const [endsMode, setEndsMode] = useState(editing?.endsMode || "ondate"); // ondate | aftern
  const [endDate, setEndDate] = useState(editing?.endDate || "");
  const [endCount, setEndCount] = useState(editing?.endCount || 12);
  const [srcOpen, setSrcOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);

  const curAcc = accounts.find((a) => a.id === account);
  const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  function submit() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return;
    const freq = received ? "once" : unitToFreq(Number(every), unit);
    onSave({
      id: editing?.id || uid(), type: "income",
      name: (name || source || "Income").trim(), notes: notes.trim(),
      amount: amt, icon, date, account, source,
      frequency: freq, every: Number(every), unit, endsMode, endDate, endCount,
      addToAccount, category: "hourly",
      status: received ? "received" : "planned",
    });
  }

  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={{ ...S.detailSheet, background: received ? "#fff" : "#f7f7f8" }} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={S.detailHead}>
          <div style={{ ...S.avatar, background: "#bde8c8" }}>💰</div>
          <div style={{ flex: 1, fontSize: 21, fontWeight: 800 }}>{received ? "Add Income" : "Adding Income"}</div>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>

        <div style={S.detailBody} className="cc-cal">
          {received ? (
            // ---------- RECEIVED layout (image 3) ----------
            <>
              <CapLabel>Income Source (optional)</CapLabel>
              <button onClick={() => setSrcOpen((v) => !v)} style={S.sourcePill}>
                <span style={S.budgetIconCircle}>{sources.find((s) => s.id === source)?.icon || "💰"}</span>
                <span style={{ fontWeight: 600 }}>{sources.find((s) => s.id === source)?.title || "Select source"}</span>
              </button>
              {srcOpen && (
                <div style={S.dropdown}>
                  {sources.map((s) => (
                    <button key={s.id} onClick={() => { setSource(s.id); setIcon(s.icon); setSrcOpen(false); }} style={S.dropItem}>
                      {s.icon} {s.title}
                    </button>
                  ))}
                  <button onClick={() => { setSrcOpen(false); onOpenSource(); }} style={{ ...S.dropItem, color: "#0a84ff", fontWeight: 800 }}>
                    + New source
                  </button>
                </div>
              )}

              <CapLabel>Choose Icon</CapLabel>
              <div className="cc-hscroll" style={{ display: "flex", gap: 10, overflowX: "auto", padding: "2px 0 8px" }}>
                {INCOME_ICONS.map((ic) => (
                  <button key={ic} onClick={() => setIcon(ic)} style={{ ...S.iconCircle,
                    border: icon === ic ? "2px solid #0a84ff" : "1px solid #e3e3e8" }}>{ic}</button>
                ))}
              </div>

              <CapLabel>Description</CapLabel>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Freelance payment" style={S.boxInput} />

              <CapLabel>Amount Received</CapLabel>
              <div style={S.amountBox}>
                <span style={{ fontSize: 20, fontWeight: 800 }}>$</span>
                <input type="number" inputMode="decimal" placeholder="0" value={amount}
                  onChange={(e) => setAmount(e.target.value)} style={{ ...S.boxInput, border: "none", flex: 1, fontSize: 20 }} />
                <span style={{ fontSize: 18 }}>🧮</span>
              </div>

              <CapLabel>Date</CapLabel>
              <label style={{ ...S.boxInput, display: "flex", alignItems: "center", gap: 8, position: "relative", cursor: "pointer" }}>
                <span style={{ fontSize: 16 }}>📅</span>
                <span style={{ fontWeight: 600 }}>{dateLabel}</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={S.hiddenDate} />
              </label>

              <div style={{ display: "flex", alignItems: "center", padding: "14px 2px 4px" }}>
                <span style={{ flex: 1, fontSize: 18, fontWeight: 800 }}>Add to Account?</span>
                <Toggle on={addToAccount} onChange={setAddToAccount} />
              </div>
              {addToAccount && (
                <select value={account} onChange={(e) => setAccount(e.target.value)} style={S.boxInput}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
            </>
          ) : (
            // ---------- PLANNED layout (image 2) ----------
            <>
              <Row label="Source">
                <button onClick={() => setSrcOpen((v) => !v)} style={S.boxInputBtn}>
                  {sources.find((s) => s.id === source)?.title || <span style={{ color: "#b0b0b5" }}>Select income source</span>}
                </button>
              </Row>
              {srcOpen && (
                <div style={S.dropdown}>
                  {sources.map((s) => (
                    <button key={s.id} onClick={() => { setSource(s.id); setIcon(s.icon); setSrcOpen(false); }} style={S.dropItem}>
                      {s.icon} {s.title}
                    </button>
                  ))}
                  <button onClick={() => { setSrcOpen(false); onOpenSource(); }} style={{ ...S.dropItem, color: "#0a84ff", fontWeight: 800 }}>
                    + New source
                  </button>
                </div>
              )}

              <Row label="Title">
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Salary, Freelance" style={S.rowInput} />
              </Row>
              <Row label="Notes">
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes…" style={S.rowInput} />
              </Row>
              <Row label="Icon">
                <span style={{ ...S.budgetIconCircle, background: "#bde8c8" }}>{icon}</span>
              </Row>
              <Row label="Amount">
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
                  <input type="number" inputMode="decimal" placeholder="0" value={amount}
                    onChange={(e) => setAmount(e.target.value)} style={S.amountRowInput} />
                </div>
              </Row>

              <Row label="Recurrence">
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <span style={S.miniPill}>Every</span>
                  <input type="number" min="1" value={every} onChange={(e) => setEvery(e.target.value)}
                    style={{ ...S.miniPill, width: 44, textAlign: "center", border: "1px solid #e3e3e8" }} />
                  <select value={unit} onChange={(e) => setUnit(e.target.value)} style={S.pillSelect}>
                    <option value="">Select</option>
                    {RECUR_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </div>
              </Row>

              <Row label="Ends" stack>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setEndsMode("ondate")} style={{ ...S.endsBtn,
                    background: endsMode === "ondate" ? "#30d158" : "#fff", color: endsMode === "ondate" ? "#fff" : "#1c1c1e" }}>On date</button>
                  <button onClick={() => setEndsMode("aftern")} style={{ ...S.endsBtn,
                    background: endsMode === "aftern" ? "#30d158" : "#fff", color: endsMode === "aftern" ? "#fff" : "#1c1c1e" }}>After N</button>
                </div>
                {endsMode === "ondate" ? (
                  <label style={{ ...S.boxInput, display: "block", position: "relative", cursor: "pointer", textAlign: "center" }}>
                    <span style={{ fontWeight: 600, color: endDate ? "#1c1c1e" : "#b0b0b5" }}>
                      {endDate ? new Date(endDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "None"}
                    </span>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={S.hiddenDate} />
                  </label>
                ) : (
                  <input type="number" min="1" value={endCount} onChange={(e) => setEndCount(e.target.value)}
                    placeholder="Number of times" style={{ ...S.boxInput, textAlign: "center" }} />
                )}
              </Row>

              <Row label="Date">
                <label style={{ position: "relative", cursor: "pointer" }}>
                  <span style={{ fontSize: 16, fontWeight: 700 }}>{dateLabel}</span>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={S.hiddenDate} />
                </label>
              </Row>

              <Row label="Deposit To">
                <select value={account} onChange={(e) => setAccount(e.target.value)} style={{ ...S.rowInput, fontWeight: 600 }}>
                  <option value="">None</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Row>
            </>
          )}

          {editing && <button onClick={() => onDelete(editing.id)} style={S.deleteBtn}>Delete income</button>}
        </div>

        <button onClick={submit} style={S.saveBtn}>{received ? "Add Income" : "Add Income"}</button>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

// ============================================================================
// NEW INCOME SOURCE SHEET (image 4)
// ============================================================================
function SourceSheet({ accounts, onClose, onSave }) {
  const [title, setTitle] = useState("");
  const [icon, setIcon] = useState("💰");
  const [stype, setStype] = useState("other");
  const [target, setTarget] = useState("");
  const [account, setAccount] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);
  const curType = SOURCE_TYPES.find((t) => t.id === stype) || SOURCE_TYPES[0];

  function submit() {
    if (!title.trim()) return;
    onSave({ id: uid(), title: title.trim(), icon, type: stype, target: parseFloat(target) || 0, account });
  }

  return (
    <div className="cc-overlay" style={{ ...S.overlay, zIndex: 70 }} onClick={onClose}>
      <div className="cc-sheet" style={S.detailSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />
        <div style={S.detailHead}>
          <div style={{ ...S.avatar, background: "#bde8c8" }}>💰</div>
          <div style={{ flex: 1, fontSize: 21, fontWeight: 800 }}>New Income Source</div>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>

        <div style={S.detailBody} className="cc-cal">
          <Row label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g., Main Job, Freelance" style={S.rowInput} />
          </Row>
          <Row label="Icon">
            <span style={{ ...S.budgetIconCircle, background: "#bde8c8" }}>{icon}</span>
          </Row>
          <div className="cc-hscroll" style={{ display: "flex", gap: 10, overflowX: "auto", padding: "2px 0 8px" }}>
            {INCOME_ICONS.map((ic) => (
              <button key={ic} onClick={() => setIcon(ic)} style={{ ...S.iconCircle,
                border: icon === ic ? "2px solid #0a84ff" : "1px solid #e3e3e8" }}>{ic}</button>
            ))}
          </div>
          <Row label="Type">
            <button onClick={() => setTypeOpen((v) => !v)} style={S.boxInputBtn}>
              {curType.icon} {curType.label}
            </button>
          </Row>
          {typeOpen && (
            <div style={S.dropdown}>
              {SOURCE_TYPES.map((t) => (
                <button key={t.id} onClick={() => { setStype(t.id); setIcon(t.icon); setTypeOpen(false); }} style={S.dropItem}>
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          )}
          <Row label="Target/Mo">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
              <input type="number" inputMode="decimal" placeholder="0" value={target}
                onChange={(e) => setTarget(e.target.value)} style={S.amountRowInput} />
            </div>
          </Row>
          <Row label="Deposit To">
            <select value={account} onChange={(e) => setAccount(e.target.value)} style={{ ...S.rowInput, fontWeight: 600 }}>
              <option value="">None</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Row>
        </div>

        <button onClick={submit} style={S.saveBtn}>Create Source</button>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

const CapLabel = ({ children }) => (
  <div style={{ fontSize: 12, fontWeight: 800, color: "#8a8a8e", letterSpacing: 0.6, textTransform: "uppercase", margin: "12px 2px 6px" }}>
    {children}
  </div>
);

function TxSheet({ accounts, activeAccount, editing, initialType, initialPaid, incomeFlow, sources, onOpenSource, onClose, onSave, onDelete }) {
  // Income has its own dedicated layouts (Planned vs Received)
  if ((editing?.type || initialType) === "income") {
    return (
      <IncomeSheet accounts={accounts} activeAccount={activeAccount} editing={editing}
        flow={incomeFlow || (initialPaid ? "received" : "planned")} sources={sources}
        onOpenSource={onOpenSource} onClose={onClose} onSave={onSave} onDelete={onDelete} />
    );
  }
  const [type, setType] = useState(editing?.type || initialType || "expense");
  const [name, setName] = useState(editing?.name || "");
  const [notes, setNotes] = useState(editing?.notes || "");
  const [amount, setAmount] = useState(editing ? String(editing.amount) : "");
  const [frequency, setFrequency] = useState(editing?.frequency || "once");
  const [date, setDate] = useState(editing?.date || todayISO());
  const [account, setAccount] = useState(editing?.account || activeAccount);
  const [notify, setNotify] = useState(editing?.notify ?? "off"); // off | 0 | 1 | 3 | 7
  const [paid, setPaid] = useState(editing ? (editing.status === "received" || editing.paid || false) : !!initialPaid);
  const initBudget = BUDGETS[editing?.type || initialType || "expense"][0];
  const [budget, setBudget] = useState(editing?.budget || initBudget.id);
  const [icon, setIcon] = useState(editing?.icon || initBudget.icon);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);

  const budgetList = BUDGETS[type];
  const curBudget = budgetList.find((b) => b.id === budget) || budgetList[0];
  const curAcc = accounts.find((a) => a.id === account) || accounts[0];

  // when type changes, reset budget + icon to that type's first option
  useEffect(() => {
    const list = BUDGETS[type];
    if (!list.some((b) => b.id === budget)) { setBudget(list[0].id); setIcon(list[0].icon); }
  }, [type]); // eslint-disable-line

  const noun = type === "goal" ? "Goal" : type === "income" ? "Income" : "Expense";
  const placeholders = {
    expense: "e.g., Rent, Mortgage, Property Tax",
    income: "e.g., Paycheck, Freelance, Bonus",
    goal: "e.g., Emergency fund, New car",
  };
  const paidLabel = type === "income" ? "Mark as Received" : type === "goal" ? "Mark as Funded" : "Mark as Paid";
  const saveLabel = `Save ${noun}`;
  const dueLabel = type === "income" ? "Date" : type === "goal" ? "Target Date" : "Due Date";
  const payLabel = type === "income" ? "Deposit To" : type === "goal" ? "Save In" : "Pay From";

  function pickBudget(b) { setBudget(b.id); setIcon(b.icon); setBudgetOpen(false); }

  function submit() {
    const amt = parseFloat(amount);
    if (!name.trim() || !amt || amt <= 0) return;
    onSave({
      id: editing?.id || uid(), type, name: name.trim(), notes: notes.trim(),
      amount: amt, frequency, date, account, notify, paid,
      budget, icon, category: budgetCategoryToCat(type, budget),
      status: type === "income" ? (paid ? "received" : "planned") : undefined,
    });
  }

  const dateLabel = new Date(date + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="cc-overlay" style={S.overlay} onClick={onClose}>
      <div className="cc-sheet" style={S.detailSheet} onClick={(e) => e.stopPropagation()}>
        <div style={S.grabber} />

        {/* header */}
        <div style={S.detailHead}>
          <div style={S.avatar}>{icon}</div>
          <div style={{ flex: 1, fontSize: 21, fontWeight: 800 }}>
            {editing ? "Edit" : "Adding"} {noun}
          </div>
          <button onClick={onClose} style={S.closeX} aria-label="Close">✕</button>
        </div>

        <div style={S.detailBody} className="cc-cal">
          {/* Title */}
          <Row label="Title">
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={placeholders[type]} style={S.rowInput} />
          </Row>

          {/* Notes */}
          <Row label="Notes">
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional notes…" style={S.rowInput} />
          </Row>

          {/* Amount */}
          <Row label="Amount">
            <div style={{ display: "flex", alignItems: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>$</span>
              <input type="number" inputMode="decimal" placeholder="0" value={amount}
                onChange={(e) => setAmount(e.target.value)} style={S.amountRowInput} />
            </div>
          </Row>

          {/* Due / target date */}
          <Row label={dueLabel}>
            <label style={{ position: "relative", cursor: "pointer" }}>
              <span style={{ fontSize: 16, fontWeight: 700 }}>{dateLabel}</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                style={S.hiddenDate} />
            </label>
          </Row>

          {/* Recurrence */}
          <Row label="Recurrence">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={S.pillSelect}>
              {RECURRENCE.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
          </Row>

          {/* Notifications */}
          <Row label="Notifications" align="center">
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {["off", "0", "1", "3", "7"].map((n) => (
                <button key={n} onClick={() => setNotify(n)} style={{ ...S.notifChip,
                  background: notify === n ? "#0a84ff" : "#fff",
                  color: notify === n ? "#fff" : "#1c1c1e",
                  border: notify === n ? "none" : "1px solid #e3e3e8" }}>
                  {n === "off" ? "Off" : n}
                </button>
              ))}
              <span style={{ fontSize: 16, fontWeight: 600, color: "#1c1c1e" }}>days</span>
            </div>
          </Row>

          {/* Pay from / deposit to */}
          <Row label={payLabel}>
            <button onClick={() => setAcctOpen((v) => !v)} style={S.selectorBtn}>
              <span style={{ fontSize: 20 }}>🏦</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{curAcc?.name}</span>
              <span style={{ marginLeft: "auto", color: "#8e8e93" }}>▾</span>
            </button>
          </Row>
          {acctOpen && (
            <div style={S.dropdown}>
              {accounts.map((a) => (
                <button key={a.id} onClick={() => { setAccount(a.id); setAcctOpen(false); }}
                  style={{ ...S.dropItem, fontWeight: a.id === account ? 800 : 500 }}>
                  🏦 {a.name} {a.id === account ? "✓" : ""}
                </button>
              ))}
            </div>
          )}

          {/* Mark as paid */}
          <Row label={paidLabel} align="center">
            <div style={{ marginLeft: "auto" }}>
              <Toggle on={paid} onChange={setPaid} />
            </div>
          </Row>

          {/* Budget category */}
          <Row label="Budget Category" stack>
            <button onClick={() => setBudgetOpen((v) => !v)} style={S.budgetBtn}>
              <span style={S.budgetIconCircle}>{curBudget.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>{curBudget.label}</span>
              <span style={{ marginLeft: "auto", color: "#8e8e93" }}>▾</span>
            </button>
          </Row>
          {budgetOpen && (
            <div style={{ ...S.dropdown, marginTop: -4 }}>
              {budgetList.map((b) => (
                <button key={b.id} onClick={() => pickBudget(b)}
                  style={{ ...S.dropItem, fontWeight: b.id === budget ? 800 : 500 }}>
                  {b.icon} {b.label} {b.id === budget ? "✓" : ""}
                </button>
              ))}
            </div>
          )}

          {/* Icon picker */}
          <Row label="Icon" stack>
            <div className="cc-hscroll" style={{ display: "flex", gap: 10, overflowX: "auto", padding: "2px 0 4px" }}>
              <span style={S.iconAdd}>+</span>
              {curBudget.icons.map((ic) => (
                <button key={ic} onClick={() => setIcon(ic)} style={{ ...S.iconCircle,
                  border: icon === ic ? "2px solid #0a84ff" : "1px solid #e3e3e8" }}>
                  {ic}
                </button>
              ))}
            </div>
          </Row>

          {editing && (
            <button onClick={() => onDelete(editing.id)} style={S.deleteBtn}>
              Delete {noun.toLowerCase()}
            </button>
          )}
        </div>

        {/* Save button */}
        <button onClick={submit} style={S.saveBtn}>{saveLabel}</button>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

// map a budget category id to the calendar tint category
function budgetCategoryToCat(type, budgetId) {
  if (type === "income") return "hourly";
  if (type === "goal") return "goal";
  const map = { housing: "rent", transport: "car", food: "food", utilities: "bills", fun: "subs", health: "bills", other: "other-out" };
  return map[budgetId] || "other-out";
}

// label-left / value-right row used throughout the detail sheet
function Row({ label, children, stack, align }) {
  return (
    <div style={{
      display: "flex", flexDirection: stack ? "column" : "row",
      alignItems: stack ? "stretch" : align === "center" ? "center" : "flex-start",
      gap: stack ? 6 : 12, padding: "8px 0", borderBottom: "0.5px solid #f0f0f0",
    }}>
      <div style={{ width: stack ? "auto" : 98, flexShrink: 0, fontSize: 15, fontWeight: 800, color: "#1c1c1e", lineHeight: 1.15 }}>
        {label}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Toggle({ on, onChange }) {
  return (
    <button onClick={() => onChange(!on)} style={{
      width: 52, height: 31, borderRadius: 31, border: "none", cursor: "pointer",
      background: on ? "var(--ac, #0a84ff)" : "#c7c7cc", position: "relative", transition: "background .2s", padding: 0, flexShrink: 0,
    }}>
      <span style={{ position: "absolute", top: 2, left: on ? 23 : 2, width: 27, height: 27,
        borderRadius: "50%", background: "#fff", transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.3)" }} />
    </button>
  );
}

// ============================================================================
const IconBtn = ({ children, onClick }) => (
  <button onClick={onClick} style={S.iconBtn} className="cc-icon-btn">{children}</button>
);
const TBtn = ({ children, active, onClick }) => (
  <button onClick={onClick} style={{ ...S.tbtn, color: active ? "var(--ac,#0a84ff)" : "#3a3a3c", opacity: active ? 1 : 0.55 }}>{children}</button>
);

// ── Toolbar SVG icons ─────────────────────────────────────────────────────────
const IcoCalendar = () => (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="17" rx="2.5"/>
    <path d="M8 2v4M16 2v4M3 9h18"/>
    <circle cx="8"  cy="14" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="16" cy="14" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="8"  cy="18" r="1.1" fill="currentColor" stroke="none"/>
    <circle cx="12" cy="18" r="1.1" fill="currentColor" stroke="none"/>
  </svg>
);
const IcoPie = () => (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v10h10a10 10 0 1 1-10-10z"/>
    <path d="M12 2a10 10 0 0 1 10 10" strokeDasharray="none"/>
  </svg>
);
const IcoGrid = () => (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="currentColor">
    {[5,12,19].flatMap(x => [5,12,19].map(y =>
      <circle key={`${x}${y}`} cx={x} cy={y} r="1.8"/>
    ))}
  </svg>
);
const IcoCard = () => (
  <svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="6" width="20" height="14" rx="2.5"/>
    <path d="M2 11h20"/>
    <rect x="5" y="15" width="6" height="2" rx="1" fill="currentColor" stroke="none"/>
  </svg>
);

function buildForecastSentence(accTxns, balance, dayMap, thresholds) {
  const th = thresholds || { clear: 500, partly: 300, rain: 100, storm: 0 };
  const tier = (bal) => {
    if (bal >= th.clear) return { icon: "☀️", color: "#1a8a4a", bg: "#e3f7e8", accent: "#30d158", title: "Clear Skies" };
    if (bal >= th.partly) return { icon: "⛅", color: "#0a64d6", bg: "#e3f0ff", accent: "#0a84ff", title: "Partly Cloudy" };
    if (bal >= th.rain) return { icon: "🌧️", color: "#8a5a00", bg: "#fff3d6", accent: "#ff9f0a", title: "Rain Expected" };
    return { icon: "⛈️", color: "#9b1c1c", bg: "#fde8e8", accent: "#ff453a", title: "Storm Warning" };
  };
  const keys = Object.keys(dayMap).filter((k) => k > todayISO() && dayMap[k].changed).sort();
  if (!keys.length)
    return { ...tier(balance), body: "No upcoming activity. Tap + to add income or bills." };

  const k = keys.find((kk) => dayMap[kk].txs.some((t) => t.type === "expense")) || keys[0];
  const day = new Date(k + "T00:00:00");
  const dayTxs = dayMap[k].txs;
  const exp = dayTxs.filter((t) => t.type === "expense");
  const bal = dayMap[k].balance;
  const lead = exp[0];
  const m = lead ? catMeta(lead.category) : null;
  const dateStr = day.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const extra = dayTxs.length - 1;
  const desc = lead
    ? `After ${m.icon} ${lead.name}${extra > 0 ? ` + ${extra} more` : ""} on ${dateStr}, you'll have ${fmtK(bal)} left`
    : `On ${dateStr} you'll have ${fmtK(bal)}`;

  return { ...tier(bal), body: desc };
}

function seed() {
  const today = new Date();
  const first = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const soon = (days) => { const d = new Date(today); d.setDate(d.getDate() + days); return fmt(d); };
  return [
    { id: uid(), account: "acc1", type: "income", name: "Hourly", amount: 1600, category: "hourly", frequency: "biweekly", date: soon(0) },
    { id: uid(), account: "acc1", type: "expense", name: "Car Pay", amount: 400, category: "car", frequency: "monthly", date: soon(5) },
    { id: uid(), account: "acc1", type: "expense", name: "Rent", amount: 1000, category: "rent", frequency: "monthly", date: fmt(first) },
    { id: uid(), account: "acc1", type: "expense", name: "Phone", amount: 80, category: "phone", frequency: "monthly", date: soon(12) },
    { id: uid(), account: "acc1", type: "expense", name: "Lights", amount: 90, category: "bills", frequency: "monthly", date: soon(24) },
  ];
}

// ============================================================================
const S = {
  root: {
    width: "100%", height: "100dvh", position: "relative", overflow: "hidden",
    display: "flex", flexDirection: "column", background: "#fff", color: "#1c1c1e",
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  },
  statusBar: { display: "none" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 16px 10px", paddingTop: "max(16px, env(safe-area-inset-top))" },
  iconBtn: { width: 40, height: 40, borderRadius: 20, border: "none", background: "#f2f2f7", fontSize: 17, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  bannerWrap: { padding: "0 12px 8px" },
  banner: { display: "flex", gap: 12, alignItems: "flex-start", borderRadius: 14, padding: "12px 14px" },
  editPill: { fontSize: 13, fontWeight: 700, color: "#1a8a4a", background: "#fff", borderRadius: 12, padding: "4px 12px", alignSelf: "flex-start" },
  dowRow: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", padding: "0 4px" },
  dowCell: { textAlign: "center", fontSize: 13, fontWeight: 600, color: "#8e8e93", padding: "2px 0" },
  monthChip: { position: "absolute", left: "50%", transform: "translateX(-50%)", top: 4, zIndex: 5, background: "#fff", boxShadow: "0 2px 10px rgba(0,0,0,.12)", borderRadius: 18, padding: "7px 16px", fontWeight: 700, fontSize: 15 },
  calScroll: { flex: 1, overflowY: "auto", padding: "0 2px" },
  weekRow: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", borderTop: "0.5px solid #eee", minHeight: 110 },
  dayCell: { borderRight: "0.5px solid #f0f0f0", padding: "4px 2px", display: "flex", flexDirection: "column", gap: 3, minHeight: 110 },
  dateNumWrap: { display: "flex", justifyContent: "center", marginBottom: 2 },
  todayCircle: { background: "#0a84ff", color: "#fff", width: 26, height: 26, borderRadius: 13, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14 },
  balPill: { alignSelf: "center", background: "#eaeaef", borderRadius: 9, padding: "2px 7px", fontSize: 12, fontWeight: 700, color: "#3a3a3c" },
  txBlock: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, borderRadius: 8, padding: "4px 5px", border: "none", cursor: "pointer", width: "100%", boxSizing: "border-box" },
  toolbarWrap: { position: "absolute", bottom: "max(22px, env(safe-area-inset-bottom))", left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 40, pointerEvents: "none" },
  addOverlay: { position: "absolute", inset: 0, bottom: 0, background: "rgba(0,0,0,.04)", zIndex: 45, display: "flex", alignItems: "flex-end", justifyContent: "center", paddingBottom: 92, pointerEvents: "auto" },
  addMenu: { display: "flex", flexDirection: "column", gap: 14, width: "78%", maxWidth: 300 },
  addOpt: { display: "flex", alignItems: "center", gap: 18, background: "#fbfbfd", border: "none", borderRadius: 40, padding: "16px 26px", cursor: "pointer", boxShadow: "0 6px 20px rgba(0,0,0,.14)" },
  toolbar: { display: "flex", alignItems: "center", gap: 6, background: "rgba(245,245,247,.92)", backdropFilter: "blur(20px)", WebkitBackdropFilter: "blur(20px)", borderRadius: 34, padding: "8px 14px", boxShadow: "0 8px 30px rgba(0,0,0,.18)", pointerEvents: "auto" },
  tbtn: { width: 44, height: 44, borderRadius: 22, border: "none", background: "transparent", fontSize: 20, cursor: "pointer" },
  plus: { width: 54, height: 54, borderRadius: 27, border: "none", background: "#0a84ff", color: "#fff", fontSize: 30, fontWeight: 300, cursor: "pointer", margin: "0 2px", boxShadow: "0 6px 18px rgba(10,132,255,.45)", transition: "transform .22s cubic-bezier(.2,.8,.2,1)", lineHeight: 1 },
  statusBtn: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, borderRadius: 12, padding: "12px", cursor: "pointer" },
  bodyScroll: { flex: 1, overflowY: "auto", padding: "4px 16px" },
  periodRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, margin: "6px 0 4px" },
  periodArrow: { flex: 1, border: "none", background: "transparent", fontSize: 15, fontWeight: 800, color: "#1c1c1e", cursor: "pointer", whiteSpace: "nowrap" },
  periodPill: { border: "1px solid #e3e3e8", background: "#fff", borderRadius: 22, padding: "8px 14px", fontSize: 15, fontWeight: 800, cursor: "pointer", color: "#1c1c1e", whiteSpace: "nowrap" },
  sumCard: { flex: 1, border: "none", borderRadius: 16, padding: "12px 10px", textAlign: "center", cursor: "pointer" },
  budgetPrompt: { display: "flex", alignItems: "center", gap: 12, width: "100%", background: "#e8f0fe", border: "1px solid #bcd6fb", borderRadius: 16, padding: "14px 16px", marginTop: 14, cursor: "pointer" },
  catRow: { display: "flex", alignItems: "center", gap: 14, padding: "14px 2px", borderBottom: "0.5px solid #f0f0f0" },
  catTile: { width: 52, height: 52, borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 26, flexShrink: 0 },
  assignPill: { border: "none", borderRadius: 18, padding: "8px 18px", fontSize: 16, fontWeight: 800, cursor: "pointer", flexShrink: 0 },
  ledgerTabs: { display: "flex", gap: 22, overflowX: "auto", padding: "8px 18px 0", borderBottom: "0.5px solid #eee", flexShrink: 0, cursor: "grab", userSelect: "none", touchAction: "pan-x" },
  ledgerTab: { position: "relative", border: "none", background: "transparent", fontSize: 19, fontWeight: 700, padding: "6px 0 12px", cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0 },
  ledgerUnderline: { position: "absolute", left: 0, right: 0, bottom: 0, height: 3, borderRadius: 2, background: "#0a84ff" },
  ledgerHead: { display: "flex", alignItems: "center", gap: 12, padding: "12px 18px", background: "#f7f7f8", fontSize: 14, fontWeight: 800, color: "#8e8e93", letterSpacing: 0.5 },
  ledgerRow: { display: "flex", alignItems: "center", gap: 12, padding: "16px 18px", borderBottom: "0.5px solid #f0f0f0" },
  ledgerBalInput: { width: 90, textAlign: "right", border: "none", background: "transparent", fontSize: 18, fontWeight: 800, outline: "none", color: "#1c1c1e", padding: 0 },
  debtSeg: { display: "flex", background: "#f2f2f7", borderRadius: 14, padding: 4, gap: 4 },
  debtSegBtn: { flex: 1, border: "none", borderRadius: 11, padding: "11px 6px", fontSize: 15, fontWeight: 800, cursor: "pointer" },
  debtCard: { background: "#fff", border: "0.5px solid #e3e3e8", borderRadius: 16, padding: 14, marginBottom: 12, boxShadow: "0 1px 4px rgba(0,0,0,.05)" },
  debtRemove: { marginTop: 10, border: "none", background: "transparent", color: "#ff453a", fontWeight: 700, fontSize: 13, cursor: "pointer", padding: 0 },
  btnGhostFull: { width: "100%", marginTop: 10, padding: 13, borderRadius: 14, border: "1px solid #e3e3e8", background: "#fff", color: "#1c1c1e", fontWeight: 700, fontSize: 15, cursor: "pointer" },
  warnSave: { border: "none", background: "#0a84ff", color: "#fff", borderRadius: 20, padding: "9px 22px", fontSize: 16, fontWeight: 800, cursor: "pointer" },
  suggestedPill: { display: "inline-block", background: "#e3f7e8", color: "#1a8a4a", borderRadius: 18, padding: "7px 16px", fontSize: 15, fontWeight: 800 },
  thresholdSlider: { width: "100%", height: 8, cursor: "pointer" },
  insightCard: { background: "#f7f7f8", borderRadius: 18, padding: 18, marginBottom: 16 },
  acctChip: { display: "flex", alignItems: "center", gap: 5, background: "#fff", borderRadius: 20, padding: "7px 12px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  calcSheet: { width: "100%", maxHeight: "94%", background: "#fff", borderRadius: "20px 20px 0 0", display: "flex", flexDirection: "column", overflow: "hidden" },
  calcHead: { display: "flex", alignItems: "center", gap: 10, padding: "16px 18px 12px", borderBottom: "0.5px solid #eee" },
  calcTip: { display: "flex", alignItems: "center", gap: 10, background: "#f7f7f8", padding: "12px 18px" },
  calcTotalRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", padding: "16px 18px", borderBottom: "0.5px solid #eee" },
  balChip: { alignSelf: "flex-start", background: "#f2f2f7", borderRadius: 20, padding: "8px 16px", margin: "14px 18px 4px", fontSize: 15, fontWeight: 700, color: "#3a3a3c" },
  keypad: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", padding: "4px 10px" },
  key: { border: "none", background: "transparent", fontSize: 28, fontWeight: 600, padding: "16px 0", cursor: "pointer" },
  calcFooter: { display: "flex", alignItems: "center", gap: 12, padding: "4px 18px 10px" },
  backKey: { border: "none", background: "transparent", color: "#0a84ff", fontSize: 24, cursor: "pointer", padding: "8px 10px" },
  doneBtn: { flex: 1, background: "#5e7cf5", border: "none", color: "#fff", borderRadius: 26, padding: "16px", fontSize: 19, fontWeight: 800, cursor: "pointer" },
  periodCard: { display: "flex", alignItems: "center", gap: 14, width: "100%", borderRadius: 16, padding: "14px 16px", marginBottom: 12, cursor: "pointer" },
  confirmCard: { width: "100%", maxWidth: 360, background: "#fff", borderRadius: 20, padding: "22px 22px 20px" },
  confirmCancel: { flex: 1, border: "1px solid #e3e3e8", background: "#fff", borderRadius: 14, padding: "14px", fontSize: 16, fontWeight: 700, color: "#6a6a6e", cursor: "pointer" },
  confirmGo: { flex: 2, border: "none", background: "#5e7cf5", color: "#fff", borderRadius: 14, padding: "14px", fontSize: 16, fontWeight: 800, cursor: "pointer" },
  h2: { fontSize: 22, fontWeight: 800, margin: "10px 4px 10px" },
  statCard: { background: "#f7f7fa", borderRadius: 16, padding: 14 },
  inlineInput: { width: 90, textAlign: "right", border: "1px solid #e3e3e8", borderRadius: 8, padding: "5px 8px", fontWeight: 700, outline: "none" },
  fullInput: { width: "100%", border: "1px solid #e3e3e8", borderRadius: 10, padding: "11px 12px", fontSize: 16, outline: "none", boxSizing: "border-box" },
  primaryBtn: { width: "100%", marginTop: 10, padding: 12, borderRadius: 12, border: "none", background: "#0a84ff", color: "#fff", fontWeight: 700, fontSize: 15, cursor: "pointer" },
  overlay: { position: "absolute", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 60, display: "flex", alignItems: "flex-end" },
  detailSheet: { width: "100%", maxHeight: "96%", background: "#f7f7f8", borderRadius: "24px 24px 0 0", padding: "6px 18px 0", display: "flex", flexDirection: "column", overflow: "hidden" },
  detailHead: { display: "flex", alignItems: "center", gap: 10, padding: "4px 0 6px" },
  avatar: { width: 38, height: 38, borderRadius: 19, background: "#d8c4b0", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 19, flexShrink: 0 },
  closeX: { width: 30, height: 30, border: "none", background: "transparent", fontSize: 19, color: "#1c1c1e", cursor: "pointer" },
  detailBody: { flex: 1, overflowY: "auto", paddingBottom: 4 },
  rowInput: { width: "100%", border: "none", background: "transparent", fontSize: 15, fontWeight: 600, outline: "none", textAlign: "left", color: "#1c1c1e" },
  amountRowInput: { border: "none", background: "transparent", fontSize: 16, fontWeight: 700, outline: "none", width: 110, color: "#1c1c1e" },
  hiddenDate: { position: "absolute", inset: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" },
  pillSelect: { border: "1px solid #e3e3e8", background: "#fff", borderRadius: 10, padding: "6px 12px", fontSize: 14, fontWeight: 600, outline: "none", cursor: "pointer", color: "#1c1c1e" },
  notifChip: { minWidth: 34, padding: "5px 8px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" },
  selectorBtn: { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "transparent", padding: 0, cursor: "pointer", color: "#1c1c1e" },
  budgetBtn: { display: "flex", alignItems: "center", gap: 10, width: "100%", border: "none", background: "#fff", borderRadius: 12, padding: "8px 12px", cursor: "pointer", boxShadow: "0 1px 3px rgba(0,0,0,.06)", color: "#1c1c1e" },
  budgetIconCircle: { width: 30, height: 30, borderRadius: 15, background: "#ece3da", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, flexShrink: 0 },
  dropdown: { background: "#fff", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,.12)", overflow: "hidden", marginBottom: 4 },
  dropItem: { display: "block", width: "100%", textAlign: "left", border: "none", background: "transparent", padding: "10px 14px", fontSize: 14, cursor: "pointer", borderBottom: "0.5px solid #f0f0f0", color: "#1c1c1e" },
  iconAdd: { width: 38, height: 38, borderRadius: 19, border: "2px dashed #0a84ff", color: "#0a84ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 },
  iconCircle: { width: 38, height: 38, borderRadius: 19, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, cursor: "pointer", flexShrink: 0 },
  saveBtn: { width: "100%", padding: 13, borderRadius: 14, border: "none", background: "#1c1c1e", color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer", margin: "4px 0 10px" },
  boxInput: { width: "100%", border: "1px solid #e3e3e8", background: "#fff", borderRadius: 12, padding: "12px 14px", fontSize: 15, fontWeight: 600, outline: "none", boxSizing: "border-box", color: "#1c1c1e" },
  boxInputBtn: { width: "100%", border: "1px solid #e3e3e8", background: "#fff", borderRadius: 12, padding: "10px 14px", fontSize: 15, fontWeight: 600, outline: "none", boxSizing: "border-box", color: "#1c1c1e", textAlign: "left", cursor: "pointer" },
  sourcePill: { display: "flex", alignItems: "center", gap: 10, width: "100%", border: "1px solid #e3e3e8", background: "#fff", borderRadius: 30, padding: "8px 12px", cursor: "pointer", color: "#1c1c1e" },
  amountBox: { display: "flex", alignItems: "center", gap: 8, border: "1px solid #e3e3e8", background: "#fff", borderRadius: 12, padding: "8px 14px" },
  miniPill: { border: "1px solid #e3e3e8", background: "#fff", borderRadius: 10, padding: "7px 12px", fontSize: 14, fontWeight: 700, color: "#1c1c1e" },
  endsBtn: { flex: 1, border: "1px solid #e3e3e8", borderRadius: 10, padding: "9px", fontSize: 14, fontWeight: 800, cursor: "pointer" },
  sheet: { width: "100%", maxHeight: "92%", background: "#fff", borderRadius: "20px 20px 0 0", padding: "8px 18px 0", overflowY: "auto" },
  grabber: { width: 36, height: 5, borderRadius: 3, background: "#d1d1d6", margin: "6px auto 10px" },
  sheetHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  sheetCancel: { border: "none", background: "none", color: "#0a84ff", fontSize: 16, cursor: "pointer" },
  sheetSave: { border: "none", background: "none", color: "#0a84ff", fontSize: 16, fontWeight: 700, cursor: "pointer" },
  segment: { display: "flex", background: "#f2f2f7", borderRadius: 10, padding: 3, gap: 3 },
  segBtn: { flex: 1, border: "none", padding: 9, borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: "pointer" },
  amountInput: { fontSize: 42, fontWeight: 700, border: "none", outline: "none", width: 170, textAlign: "center", background: "transparent", color: "#1c1c1e" },
  sheetInput: { width: "100%", border: "none", background: "#f2f2f7", borderRadius: 10, padding: 12, fontSize: 16, outline: "none", boxSizing: "border-box" },
  chip: { display: "flex", alignItems: "center", gap: 4, border: "none", borderRadius: 18, padding: "8px 13px", fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", cursor: "pointer", flexShrink: 0 },
  deleteBtn: { width: "100%", marginTop: 14, padding: 13, borderRadius: 12, border: "none", background: "#ffeaea", color: "#ff453a", fontWeight: 700, fontSize: 15, cursor: "pointer" },
};

const CSS = `
  .cc-cal::-webkit-scrollbar, .cc-hscroll::-webkit-scrollbar { display:none; }
  .cc-cal, .cc-hscroll { scrollbar-width:none; }
  .cc-sheet { animation: up .28s cubic-bezier(.2,.8,.2,1); }
  .cc-addopt { animation: pop .26s cubic-bezier(.2,.9,.3,1.2) both; }
  @keyframes pop { from { opacity:0; transform: translateY(16px) scale(.94);} to { opacity:1; transform: translateY(0) scale(1);} }
  .cc-overlay { animation: fade .2s ease; }
  @keyframes up { from { transform:translateY(100%);} to { transform:translateY(0);} }
  @keyframes fade { from { opacity:0;} to { opacity:1;} }
  @keyframes slideIn { from { transform:translateX(-100%); } to { transform:translateX(0); } }
  .cc-menu-drawer { animation: slideIn .25s cubic-bezier(.2,.8,.2,1); }
  input::placeholder { color:#b0b0b5; }
  .cc-drag:active { cursor: grabbing; }
  select { -webkit-appearance:none; appearance:none; }
  button:active { transform: scale(.97); }

  /* ── Dark mode ── */
  .dm { background: #111 !important; color: #f2f2f7 !important; }
  .dm .cc-cal { background: #111 !important; }
  .dm .cc-sheet { background: #1c1c1e !important; }
  .dm .cc-overlay { background: rgba(0,0,0,.65) !important; }
  .dm input, .dm select, .dm textarea {
    background: #2c2c2e !important;
    color: #f2f2f7 !important;
    border-color: #3a3a3c !important;
  }
  .dm input::placeholder { color: #636366 !important; }
  .dm .cc-icon-btn { background: #2c2c2e !important; color: #f2f2f7 !important; }
  .dm .cc-toolbar-pill { background: rgba(28,28,30,.95) !important; }
  .dm .cc-bal-pill { background: #2c2c2e !important; color: #aeaeb2 !important; }
  .dm .cc-month-chip { background: #1c1c1e !important; color: #f2f2f7 !important; box-shadow: 0 2px 10px rgba(0,0,0,.5) !important; }
  .dm .cc-dow-cell { color: #636366 !important; }
  /* Neutral / uncolored buttons only — never override buttons with explicit accent/danger colors */
  .dm .cc-btn-neutral { background: #2c2c2e !important; color: #f2f2f7 !important; }
  .dm .cc-btn-ghost { background: transparent !important; color: #f2f2f7 !important; border-color: #3a3a3c !important; }
  /* View/sheet backgrounds in dark mode */
  .dm .cc-view-bg { background: #111 !important; }
  .dm .cc-card-bg { background: #1c1c1e !important; }
  .dm .cc-card2-bg { background: #2c2c2e !important; }
  /* Text colors in dark mode */
  .dm .cc-text-primary { color: #f2f2f7 !important; }
  .dm .cc-text-muted { color: #aeaeb2 !important; }
  /* Borders */
  .dm .cc-border { border-color: #3a3a3c !important; }
  /* Dropdown / list items */
  .dm .cc-drop-item { background: #1c1c1e !important; color: #f2f2f7 !important; border-bottom-color: #3a3a3c !important; }
  /* Add-menu options */
  .dm .cc-addopt { background: #1c1c1e !important; color: #f2f2f7 !important; }
  /* Grabber */
  .dm .cc-grabber { background: #3a3a3c !important; }
`;

// ── helpers ──────────────────────────────────────────────────────────────────
const th = (dm) => ({
  bg:     dm ? "#111"     : "#fff",
  bg2:    dm ? "#1c1c1e"  : "#f7f7f8",
  bg3:    dm ? "#2c2c2e"  : "#f2f2f7",
  text:   dm ? "#f2f2f7"  : "#1c1c1e",
  text2:  dm ? "#aeaeb2"  : "#8e8e93",
  border: dm ? "#3a3a3c"  : "#e3e3e8",
  div:    dm ? "#3a3a3c"  : "#f0f0f0",
});

// ── SideMenu ─────────────────────────────────────────────────────────────────
function SideMenu({ dm, darkMode, setDarkMode, onClose, onNavigate }) {
  const t = th(dm);
  const items = [
    { icon: "📅", label: "Forecast",  key: "calendar"  },
    { icon: "👤", label: "Profile",   key: "profile"   },
    { icon: "⚙️", label: "Settings", key: "settings"  },
  ];
  return (
    <div style={{ position:"absolute", inset:0, zIndex:80, background:"rgba(0,0,0,.45)" }}
         onClick={onClose}>
      <div className="cc-menu-drawer"
           style={{ position:"absolute", top:0, left:0, bottom:0, width:"82%", maxWidth:320,
                    background: t.bg, display:"flex", flexDirection:"column",
                    boxShadow:"6px 0 30px rgba(0,0,0,.25)" }}
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ paddingTop:"max(54px, env(safe-area-inset-top))",
                      padding:"max(54px, env(safe-area-inset-top)) 24px 18px" }}>
          <div style={{ fontSize:34, fontWeight:800, color: t.text }}>Menu</div>
        </div>

        <div style={{ flex:1, overflowY:"auto", padding:"0 0 40px" }}>
          {/* Dark Mode row */}
          <div style={{ display:"flex", alignItems:"center", padding:"16px 24px",
                        borderBottom:`0.5px solid ${t.border}` }}>
            <span style={{ fontSize:22, marginRight:14 }}>{dm ? "🌙" : "☀️"}</span>
            <span style={{ flex:1, fontSize:17, fontWeight:600, color: t.text }}>Dark Mode</span>
            <Toggle on={darkMode} onChange={setDarkMode} />
          </div>

          {/* Nav items */}
          {items.map(item => (
            <div key={item.key} style={{ borderBottom:`0.5px solid ${t.border}` }}>
              <button
                onClick={() => onNavigate(item.key)}
                style={{ display:"flex", alignItems:"center", gap:16, width:"100%",
                         padding:"18px 24px", background:"transparent",
                         border:"none", cursor:"pointer", color: t.text, textAlign:"left" }}>
                <span style={{ fontSize:22 }}>{item.icon}</span>
                <span style={{ fontSize:17, fontWeight:600, flex:1 }}>{item.label}</span>
                <span style={{ color: t.text2, fontSize:22 }}>›</span>
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── BalancePanel ──────────────────────────────────────────────────────────────
function BalancePanel({ accounts, txns, forecast, totalBalance, includedIds, excludedAccounts, setExcludedAccounts, dm, onClose }) {
  const t = th(dm);
  const [tab, setTab] = useState("accounts");

  function toggleAccount(id) {
    setExcludedAccounts(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id); // re-include
      } else {
        // only exclude if at least one account stays included
        const wouldRemain = accounts.filter(a => a.id !== id && !next.has(a.id)).length;
        if (wouldRemain > 0) next.add(id);
      }
      return next;
    });
  }

  const recentTxns = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);

  return (
    <div style={{ position:"absolute", inset:0, zIndex:75, background:"rgba(0,0,0,.35)", display:"flex", flexDirection:"column", alignItems:"center", padding:"12px 12px 0" }}
         onClick={onClose}>
      <div style={{ width:"100%", maxWidth:430, background:t.bg, borderRadius:24, overflow:"hidden",
                    maxHeight:"90vh", display:"flex", flexDirection:"column",
                    boxShadow:"0 20px 60px rgba(0,0,0,.25)" }}
           onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding:"22px 20px 16px", textAlign:"center", position:"relative", borderBottom:`0.5px solid ${t.border}` }}>
          <button onClick={onClose}
            style={{ position:"absolute", top:16, right:16, width:34, height:34, borderRadius:17,
                     background:t.bg3, border:"none", cursor:"pointer", fontSize:17,
                     display:"flex", alignItems:"center", justifyContent:"center", color:t.text }}>
            ✕
          </button>
          <div style={{ fontSize:11, fontWeight:800, color:t.text2, letterSpacing:1.1, marginBottom:8 }}>CASH BALANCE</div>
          <div style={{ fontSize:40, fontWeight:800, color:t.text, lineHeight:1 }}>{fmtFull(totalBalance)}</div>
          {/* forecast pill */}
          <div style={{ display:"inline-flex", alignItems:"center", gap:7, marginTop:12,
                        background: dm ? "#1a3a1a" : "#e8f5e9", borderRadius:22,
                        padding:"7px 16px", fontSize:14, fontWeight:600,
                        color: dm ? "#6fcf6f" : "#2e7d32" }}>
            <span>{forecast.icon}</span>
            <span>{forecast.title} — {forecast.body.split(",").slice(-1)[0]?.trim() || forecast.body}</span>
          </div>
        </div>

        {/* Tabs */}
        <div style={{ display:"flex", margin:"14px 16px 8px", background:t.bg3, borderRadius:14, padding:3, gap:3 }}>
          {[
            { id:"accounts", label:"Accounts", icon:<IcoCard /> },
            { id:"transactions", label:"Transactions", icon:<IcoGrid /> },
          ].map(tb => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", gap:6,
                       padding:"10px", border:"none", borderRadius:11, cursor:"pointer",
                       background: tab===tb.id ? (dm ? "#2c2c2e" : "#fff") : "transparent",
                       color: tab===tb.id ? t.text : t.text2, fontWeight:700, fontSize:15,
                       boxShadow: tab===tb.id ? "0 1px 4px rgba(0,0,0,.12)" : "none" }}>
              <span style={{ width:18, height:18, display:"flex", alignItems:"center", justifyContent:"center" }}>{tb.icon}</span>
              {tb.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex:1, overflowY:"auto", padding:"4px 16px 32px" }} className="cc-cal">
          {tab === "accounts" ? (
            <>
              <div style={{ fontSize:11, fontWeight:800, color:t.text2, letterSpacing:0.9, margin:"10px 0 12px" }}>
                INCLUDED IN PROJECTIONS
              </div>
              {accounts.map(a => {
                const isOn = !excludedAccounts.has(a.id);
                return (
                  <div key={a.id} onClick={() => toggleAccount(a.id)}
                    style={{ display:"flex", alignItems:"center", gap:14, padding:"16px 14px",
                             border:`1.5px solid ${isOn ? "var(--ac,#0a84ff)" : t.border}`,
                             borderRadius:16, marginBottom:10, cursor:"pointer",
                             background: isOn ? (dm ? "#0a1e3a" : "#f0f6ff") : t.bg,
                             transition:"all .15s" }}>
                    <div style={{ width:24, height:24, borderRadius:7, flexShrink:0,
                                  background: isOn ? "var(--ac,#0a84ff)" : "transparent",
                                  border:`2px solid ${isOn ? "var(--ac,#0a84ff)" : "#c7c7cc"}`,
                                  display:"flex", alignItems:"center", justifyContent:"center" }}>
                      {isOn && <span style={{ color:"#fff", fontSize:13, fontWeight:900, lineHeight:1 }}>✓</span>}
                    </div>
                    <span style={{ flex:1, fontSize:17, fontWeight:600, color:t.text }}>{a.name}</span>
                    <span style={{ fontSize:17, fontWeight:800, color:"var(--ac,#0a84ff)" }}>{fmtFull(a.balance)}</span>
                  </div>
                );
              })}
              {accounts.length === 0 && (
                <div style={{ textAlign:"center", padding:"30px 0", color:t.text2 }}>No accounts yet. Add one from the 💳 tab.</div>
              )}
            </>
          ) : (
            <>
              <div style={{ fontSize:11, fontWeight:800, color:t.text2, letterSpacing:0.9, margin:"10px 0 12px" }}>
                RECENT TRANSACTIONS
              </div>
              {recentTxns.length === 0 ? (
                <div style={{ textAlign:"center", padding:"40px 0", color:t.text2 }}>No transactions yet.</div>
              ) : recentTxns.map(tx => {
                const meta = catMeta(tx.category);
                const tint = tintFor(tx);
                const acct = accounts.find(a => a.id === tx.account);
                return (
                  <div key={tx.id} style={{ display:"flex", alignItems:"center", gap:12,
                                            padding:"12px 0", borderBottom:`0.5px solid ${t.div}` }}>
                    <div style={{ width:40, height:40, borderRadius:11, background:tint.bg,
                                  display:"flex", alignItems:"center", justifyContent:"center",
                                  fontSize:19, flexShrink:0 }}>
                      {meta.icon}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:15, fontWeight:700, color:t.text,
                                    whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{tx.name}</div>
                      <div style={{ fontSize:12, color:t.text2 }}>
                        {tx.date}{acct ? ` · ${acct.name}` : ""} · {FREQ_LABEL[tx.frequency] || "One-time"}
                      </div>
                    </div>
                    <div style={{ fontSize:15, fontWeight:800, flexShrink:0,
                                  color: tx.type==="income" ? "#30d158" : t.text }}>
                      {tx.type==="income" ? "+" : "-"}{fmtFull(tx.amount)}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── ForecastView ──────────────────────────────────────────────────────────────
function ForecastView({ accounts, accTxns, dayMap, balance, onBack, dm }) {
  const t = th(dm);
  const [months, setMonths] = useState(6);
  const [selected, setSelected] = useState(accounts.map(a => a.id));
  const toggle = id => setSelected(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const keys = Object.keys(dayMap).sort();
  const slice = keys.slice(0, months * 30);
  const step = Math.max(1, Math.floor(slice.length / 40));
  const series = slice.filter((_, i) => i % step === 0).map(k => dayMap[k].balance);
  const endBal = series[series.length - 1] ?? balance;
  const pct = balance > 0 ? ((endBal - balance) / balance) * 100 : 0;
  const startLabel = keys[0] ? new Date(keys[0]+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
  const endKey = slice[slice.length - 1];
  const endLabel = endKey ? new Date(endKey+"T00:00:00").toLocaleDateString("en-US",{month:"short",day:"numeric"}) : "";
  const perMonth = { daily:30, weekly:52/12, biweekly:26/12, monthly:1, yearly:1/12, once:0 };
  const mIn  = accTxns.filter(x => x.type==="income" ).reduce((s,x)=>s+x.amount*(perMonth[x.frequency]||0),0);
  const mOut = accTxns.filter(x => x.type==="expense").reduce((s,x)=>s+x.amount*(perMonth[x.frequency]||0),0);
  const net  = mIn - mOut;
  const savingsRate = mIn > 0 ? Math.round((net/mIn)*100) : 0;
  const ratio = mOut > 0 ? mIn/mOut : 0;
  const runwayMonths = mOut > 0 ? Math.floor(balance/mOut) : 99;
  const savingsLabel = savingsRate>=30?"EXCELLENT":savingsRate>=15?"GOOD":savingsRate>=0?"FAIR":"OVERSPENDING";
  const totalSelBal = accounts.filter(a=>selected.includes(a.id)).reduce((s,a)=>s+a.balance,0);
  const w=320,h=130,pad=6;
  const _vals=series.length?[...series,balance]:[balance];
  const mn=Math.min(..._vals), mx=Math.max(..._vals), rng=mx-mn||1;
  const X=i=>pad+(i/Math.max(1,series.length-1))*(w-pad*2);
  const Y=v=>pad+(1-(v-mn)/rng)*(h-pad*2);
  const line=series.map((v,i)=>`${i===0?"M":"L"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const card = { background:t.bg2, borderRadius:18, padding:18, marginBottom:16 };

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:t.bg }}>
      <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 6px" }}>
        <button onClick={onBack} style={{ ...S.iconBtn, background:t.bg3, color:t.text }}>‹</button>
        <div style={{ flex:1, textAlign:"center", fontSize:22, fontWeight:800, color:t.text }}>Forecast</div>
        <div style={{ width:40 }} />
      </div>
      <div style={{ ...S.bodyScroll, background:t.bg }} className="cc-cal">
        <div style={card}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:18 }}>📈</span>
            <span style={{ fontSize:19, fontWeight:800, flex:1, color:t.text }}>Projected Balance</span>
          </div>
          <div style={{ fontSize:40, fontWeight:800, color:"var(--ac,#0a84ff)", marginTop:8 }}>{fmtK(endBal)}</div>
          <div style={{ fontSize:14, color:t.text2 }}>in {months} months</div>
          <div style={{ fontSize:15, fontWeight:700, color:pct>=0?"var(--ac,#0a84ff)":"#ff453a", marginTop:2 }}>
            {pct>=0?"↑":"↓"} {Math.abs(pct).toFixed(1)}% <span style={{ color:t.text2, fontWeight:500 }}>from {fmtK(balance)}</span>
          </div>
          <svg viewBox={`0 0 ${w} ${h}`} style={{ width:"100%", height:110, marginTop:10 }}>
            <path d={line} fill="none" stroke="var(--ac,#0a84ff)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:4 }}>
            <span style={{ fontSize:14, color:t.text2, fontWeight:600 }}>{startLabel}</span>
            <select value={months} onChange={e=>setMonths(Number(e.target.value))}
              style={{ ...S.pillSelect, background:t.bg3, color:t.text, borderColor:t.border }}>
              {[3,6,12].map(m=><option key={m} value={m}>{m} Months</option>)}
            </select>
            <span style={{ fontSize:14, color:t.text2, fontWeight:600 }}>{endLabel}</span>
          </div>
        </div>

        <div style={{ display:"flex", gap:12 }}>
          {[
            { label:"Runway", val: runwayMonths>=99?"∞":runwayMonths+"m", sub:"Months of coverage" },
            { label:"Savings Rate", val: savingsRate+"%", sub: savingsLabel },
          ].map(({label,val,sub})=>(
            <div key={label} style={{ ...card, flex:1, marginBottom:12 }}>
              <div style={{ fontSize:18, fontWeight:800, color:t.text }}>{label}</div>
              <div style={{ fontSize:38, fontWeight:800, margin:"10px 0 6px", color:"var(--ac,#0a84ff)" }}>{val}</div>
              <div style={{ fontSize:13, color:t.text2 }}>{sub}</div>
            </div>
          ))}
        </div>

        <div style={card}>
          <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:18 }}>⇄</span>
            <span style={{ fontSize:19, fontWeight:800, flex:1, color:t.text }}>Income vs Expenses</span>
            <span style={{ background:"#d6f5e3", color:"#1a8a4a", borderRadius:12, padding:"4px 10px", fontSize:13, fontWeight:800 }}>↗ {ratio.toFixed(1)}:1</span>
          </div>
          {[["↗ Income", mIn, "#30a85f"],["↘ Expenses", mOut, "#ff6b6b"],["✅ Net", net, "#7a3fb0"]].map(([lbl,val,col])=>(
            <div key={lbl} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:12 }}>
              <span style={{ fontSize:16, fontWeight:700, color:t.text }}>{lbl}</span>
              <span style={{ fontSize:18, fontWeight:800, color:col }}>{fmtFull(val).replace(".00","")}</span>
            </div>
          ))}
        </div>
        <div style={{ height:120 }} />
      </div>
    </div>
  );
}

// ── ProfileView ───────────────────────────────────────────────────────────────
const PROFILE_ID = "cc_" + Math.random().toString(36).slice(2, 10).toUpperCase();

function ProfileView({ accounts, txns, onBack, dm, onResetData, authUser, authLoading, onSignIn, onSignOut }) {
  const t = th(dm);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [logoutConfirm, setLogoutConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState("");

  const PRow = ({ icon, label, right, last, onClick, red }) => (
    <div onClick={onClick} style={{ display:"flex", alignItems:"center", gap:14, padding:"16px 18px",
                borderBottom: last ? "none" : `0.5px solid ${t.border}`,
                cursor: onClick ? "pointer" : "default", background:t.bg2 }}>
      <span style={{ fontSize:20, width:24, textAlign:"center", color: red ? "#ff453a" : t.text2 }}>{icon}</span>
      <span style={{ flex:1, fontSize:16, fontWeight:600, color: red ? "#ff453a" : t.text }}>{label}</span>
      {right && <span style={{ color:t.text2 }}>{right}</span>}
    </div>
  );

  async function trySignIn() {
    setSigningIn(true);
    setSignInError("");
    const err = await onSignIn?.();
    if (err) setSignInError(err);
    setSigningIn(false);
  }

  if (showTerms) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:t.bg }}>
      <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 6px" }}>
        <button onClick={()=>setShowTerms(false)} style={{ ...S.iconBtn, background:t.bg3, color:t.text }}>‹</button>
        <div style={{ flex:1, textAlign:"center", fontSize:20, fontWeight:800, color:t.text }}>Terms of Use</div>
        <div style={{ width:40 }} />
      </div>
      <div style={{ ...S.bodyScroll, background:t.bg }} className="cc-cal">
        <div style={{ padding:"16px 4px", color:t.text2, fontSize:15, lineHeight:1.7 }}>
          <p><b style={{ color:t.text }}>1. Acceptance</b><br/>By using Cash Cycle, you agree to these terms. If you do not agree, please do not use the app.</p>
          <p><b style={{ color:t.text }}>2. Use of the App</b><br/>Cash Cycle is provided for personal financial tracking. You agree not to misuse the service or access it in an unauthorized manner.</p>
          <p><b style={{ color:t.text }}>3. Data</b><br/>All financial data is stored locally on your device. We do not collect or sell your personal financial information.</p>
          <p><b style={{ color:t.text }}>4. Disclaimer</b><br/>Cash Cycle is a budgeting tool and does not provide financial advice. Always consult a qualified financial advisor for investment decisions.</p>
          <p><b style={{ color:t.text }}>5. Changes</b><br/>We may update these terms at any time. Continued use of the app constitutes acceptance of the updated terms.</p>
        </div>
        <div style={{ height:80 }} />
      </div>
    </div>
  );

  if (showPrivacy) return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:t.bg }}>
      <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 6px" }}>
        <button onClick={()=>setShowPrivacy(false)} style={{ ...S.iconBtn, background:t.bg3, color:t.text }}>‹</button>
        <div style={{ flex:1, textAlign:"center", fontSize:20, fontWeight:800, color:t.text }}>Privacy Policy</div>
        <div style={{ width:40 }} />
      </div>
      <div style={{ ...S.bodyScroll, background:t.bg }} className="cc-cal">
        <div style={{ padding:"16px 4px", color:t.text2, fontSize:15, lineHeight:1.7 }}>
          <p><b style={{ color:t.text }}>Data Storage</b><br/>All your financial data is stored locally on your device using browser storage. We do not transmit your data to any servers.</p>
          <p><b style={{ color:t.text }}>No Tracking</b><br/>We do not use analytics, tracking pixels, or third-party cookies. Your usage patterns are never monitored or sold.</p>
          <p><b style={{ color:t.text }}>Permissions</b><br/>The app may request notification permissions to send you reminders about bills and forecasts. These are optional.</p>
          <p><b style={{ color:t.text }}>Data Deletion</b><br/>You can delete all your data at any time using the "Reset & Start Fresh" option in Settings, or "Delete Account" in Profile.</p>
          <p><b style={{ color:t.text }}>Contact</b><br/>For privacy questions, contact us at support@cashcycle.app</p>
        </div>
        <div style={{ height:80 }} />
      </div>
    </div>
  );

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:t.bg }}>
      <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 6px" }}>
        <button onClick={onBack} style={{ ...S.iconBtn, background:t.bg3, color:t.text }}>‹</button>
        <div style={{ flex:1, textAlign:"center", fontSize:22, fontWeight:800, color:t.text }}>Profile</div>
        <div style={{ width:40 }} />
      </div>

      <div style={{ ...S.bodyScroll, background:t.bg }} className="cc-cal">
        {/* Avatar + name */}
        <div style={{ display:"flex", flexDirection:"column", alignItems:"center", padding:"20px 0 22px" }}>
          {authUser?.photoURL ? (
            <img src={authUser.photoURL} alt="" style={{ width:72, height:72, borderRadius:36, objectFit:"cover", marginBottom:12 }} />
          ) : (
            <div style={{ width:72, height:72, borderRadius:36, background:"var(--ac,#0a84ff)",
                          display:"flex", alignItems:"center", justifyContent:"center",
                          fontSize:32, fontWeight:800, color:"#fff", marginBottom:12 }}>
              {authUser ? (authUser.displayName?.[0]?.toUpperCase() || "G") : "G"}
            </div>
          )}
          <div style={{ fontSize:20, fontWeight:700, color:t.text }}>
            {authUser ? authUser.displayName : "Guest User"}
          </div>
          {authUser ? (
            <div style={{ fontSize:13, color:t.text2, marginTop:4 }}>{authUser.email}</div>
          ) : (
            <div style={{ fontSize:13, color:t.text2, marginTop:4, display:"flex", alignItems:"center", gap:6 }}>
              <span>ID: {PROFILE_ID}...</span>
              <button onClick={()=>navigator.clipboard?.writeText(PROFILE_ID)}
                style={{ border:"none", background:"transparent", cursor:"pointer", fontSize:14, color:t.text2, padding:0 }}>📋</button>
            </div>
          )}
          {authUser && (
            <div style={{ marginTop:8, display:"flex", alignItems:"center", gap:6,
                          background:"#d6f5e3", borderRadius:20, padding:"4px 14px", fontSize:13, fontWeight:700, color:"#1a6e2e" }}>
              ☁️ Cloud sync on
            </div>
          )}
        </div>

        {/* Stats row */}
        <div style={{ display:"flex", gap:8, marginBottom:16 }}>
          {[["Status","Free",t.text],["Trial","30d\nsubscribed","var(--ac,#0a84ff)"],["Plan","From\n$6.7/mo",t.text]].map(([lbl,val,col])=>(
            <div key={lbl} style={{ flex:1, background:t.bg2, borderRadius:14, padding:"14px 8px", textAlign:"center" }}>
              <div style={{ fontSize:12, color:t.text2, fontWeight:600, marginBottom:6 }}>{lbl}</div>
              {val.split("\n").map((v,i)=>(
                <div key={i} style={{ fontSize: i===0 ? 18 : 12, fontWeight: i===0 ? 800 : 500, color: i===0 ? col : t.text2, lineHeight:1.2 }}>{v}</div>
              ))}
            </div>
          ))}
        </div>

        {/* Premium Features — Coming Soon */}
        <div style={{ background:t.bg2, borderRadius:16, padding:"20px 18px", marginBottom:16, textAlign:"center" }}>
          <div style={{ fontSize:32, marginBottom:8 }}>🚀</div>
          <div style={{ fontSize:17, fontWeight:800, color:t.text, marginBottom:6 }}>Premium Features</div>
          <div style={{ display:"inline-block", background:"var(--ac,#0a84ff)", color:"#fff",
                        borderRadius:20, padding:"4px 14px", fontSize:13, fontWeight:700, marginBottom:12 }}>
            Coming Soon
          </div>
          <div style={{ fontSize:14, color:t.text2, lineHeight:1.6 }}>
            Subscriptions are on their way. Stay tuned for unlimited tracking, smart reminders, and full financial visibility.
          </div>
        </div>

        {/* Google Sign-in / account section */}
        {signInError && (
          <div style={{ background:"#fde7e7", borderRadius:12, padding:"10px 14px", marginBottom:12, fontSize:13, color:"#c0392b", fontWeight:600, textAlign:"center" }}>
            {signInError}
          </div>
        )}
        {!authUser ? (
          <button onClick={trySignIn} disabled={signingIn || authLoading || !FIREBASE_READY}
            style={{ width:"100%", padding:"14px", borderRadius:14, border:`1.5px solid ${t.border}`,
                     background:t.bg2, color:t.text, fontSize:16, fontWeight:700,
                     cursor: FIREBASE_READY ? "pointer" : "default",
                     marginBottom:20, display:"flex", alignItems:"center", justifyContent:"center", gap:10,
                     opacity: (signingIn || authLoading) ? 0.6 : 1 }}>
            {signingIn || authLoading ? (
              <span style={{ fontSize:14 }}>Connecting…</span>
            ) : FIREBASE_READY ? (
              <>
                <svg width="20" height="20" viewBox="0 0 48 48">
                  <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                  <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                  <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
                </svg>
                Sign in with Google
              </>
            ) : (
              <>👤 Create an Account</>
            )}
          </button>
        ) : (
          <div style={{ background:t.bg2, borderRadius:14, padding:"14px 18px", marginBottom:20,
                        display:"flex", alignItems:"center", gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, color:t.text2, fontWeight:600 }}>Signed in</div>
              <div style={{ fontSize:15, fontWeight:700, color:t.text }}>{authUser.email}</div>
            </div>
            <div style={{ fontSize:22 }}>☁️</div>
          </div>
        )}

        {/* Info rows */}
        <div style={{ borderRadius:16, overflow:"hidden", marginBottom:16 }}>
          <PRow icon="📄" label="Terms of Use" right="›" onClick={()=>setShowTerms(true)} />
          <PRow icon="🛡️" label="Privacy Policy" right="›" onClick={()=>setShowPrivacy(true)} />
          <PRow icon="ℹ️" label="Version" right="1.0.0" />
          <PRow icon="☁️" label="Last update" right="today" last />
        </div>

        {/* Log Out */}
        {authUser && (!logoutConfirm ? (
          <div style={{ background:t.bg2, borderRadius:16, padding:"16px", textAlign:"center",
                        cursor:"pointer", marginBottom:10, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}
               onClick={()=>setLogoutConfirm(true)}>
            <span style={{ fontSize:18 }}>↪</span>
            <span style={{ fontSize:16, fontWeight:700, color:t.text }}>Log Out</span>
          </div>
        ) : (
          <div style={{ background:t.bg2, borderRadius:16, padding:16, marginBottom:10 }}>
            <div style={{ fontSize:14, color:t.text2, textAlign:"center", marginBottom:12 }}>Log out of your Google account?</div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setLogoutConfirm(false)}
                style={{ flex:1, padding:12, borderRadius:12, border:`1px solid ${t.border}`,
                         background:"transparent", color:t.text, fontWeight:700, cursor:"pointer" }}>Cancel</button>
              <button onClick={()=>{ onSignOut?.(); setLogoutConfirm(false); onBack(); }}
                style={{ flex:1, padding:12, borderRadius:12, border:"none",
                         background:"var(--ac,#0a84ff)", color:"#fff", fontWeight:800, cursor:"pointer" }}>Log Out</button>
            </div>
          </div>
        ))}

        {/* Delete Account */}
        {!deleteConfirm ? (
          <div style={{ background:t.bg2, borderRadius:16, padding:"16px", textAlign:"center",
                        cursor:"pointer", marginBottom:20, display:"flex", alignItems:"center", justifyContent:"center", gap:10 }}
               onClick={()=>setDeleteConfirm(true)}>
            <span style={{ fontSize:18, color:"#ff453a" }}>🗑️</span>
            <span style={{ fontSize:16, fontWeight:700, color:"#ff453a" }}>Delete Account</span>
          </div>
        ) : (
          <div style={{ background:t.bg2, borderRadius:16, padding:16, marginBottom:20 }}>
            <div style={{ fontSize:14, color:t.text2, textAlign:"center", marginBottom:12, lineHeight:1.5 }}>
              This will permanently delete all your data. This cannot be undone.
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button onClick={()=>setDeleteConfirm(false)}
                style={{ flex:1, padding:12, borderRadius:12, border:`1px solid ${t.border}`,
                         background:"transparent", color:t.text, fontWeight:700, cursor:"pointer" }}>Cancel</button>
              <button onClick={()=>{ onResetData?.(); onSignOut?.(); setDeleteConfirm(false); onBack(); }}
                style={{ flex:1, padding:12, borderRadius:12, border:"none",
                         background:"#ff453a", color:"#fff", fontWeight:800, cursor:"pointer" }}>Delete</button>
            </div>
          </div>
        )}
        <div style={{ height:100 }} />
      </div>
    </div>
  );
}

// ── SettingsView ──────────────────────────────────────────────────────────────
const ACCENT_COLORS = ["#0a84ff","#30d158","#ff6b6b","#bf5af2","#ff9f0a","#5ac8fa","#ff375f","#636366"];

function SettingsView({
  dm, setDarkMode, accentColor, setAccentColor,
  simplifiedDisplay, setSimplifiedDisplay,
  showProjectedBalances, setShowProjectedBalances,
  morningForecast, setMorningForecast, morningTime, setMorningTime,
  eveningForecast, setEveningForecast, eveningTime, setEveningTime,
  paymentReminders, setPaymentReminders, reminderTime, setReminderTime,
  autoMarkPaid, setAutoMarkPaid, onResetData, onManageCategories, onBack,
}) {
  const t = th(dm);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [currency, setCurrency] = useState("US Dollar (USD)");

  const SH = ({ title }) => (
    <div style={{ fontSize:22, fontWeight:800, color:t.text, margin:"24px 0 12px" }}>{title}</div>
  );
  const Card = ({ children }) => (
    <div style={{ background:t.bg2, borderRadius:16, overflow:"hidden" }}>{children}</div>
  );
  const Row = ({ icon, label, sub, right, last, onClick }) => (
    <div onClick={onClick} style={{ display:"flex", alignItems:"center", gap:14, padding:"14px 16px",
                  borderBottom: last ? "none" : `0.5px solid ${t.border}`,
                  cursor: onClick ? "pointer" : "default" }}>
      {icon && <span style={{ fontSize:20, width:24, textAlign:"center" }}>{icon}</span>}
      <div style={{ flex:1 }}>
        <div style={{ fontSize:16, fontWeight:600, color:t.text }}>{label}</div>
        {sub && <div style={{ fontSize:13, color:t.text2, marginTop:2, lineHeight:1.3 }}>{sub}</div>}
      </div>
      {right}
    </div>
  );
  const TimeRow = ({ label, value, onChange, last }) => (
    <div style={{ display:"flex", alignItems:"center", gap:14, padding:"12px 16px",
                  borderBottom: last ? "none" : `0.5px solid ${t.border}` }}>
      <span style={{ fontSize:20, width:24, textAlign:"center" }}>🕐</span>
      <span style={{ flex:1, fontSize:15, fontWeight:600, color:t.text }}>{label || "Schedule"}</span>
      <input type="time" value={value} onChange={e=>onChange(e.target.value)}
        style={{ border:"none", background:"transparent", color:"var(--ac,#0a84ff)",
                 fontSize:15, fontWeight:700, outline:"none", cursor:"pointer" }} />
    </div>
  );

  return (
    <div style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", background:t.bg }}>
      <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 6px" }}>
        <button onClick={onBack} style={{ ...S.iconBtn, background:t.bg3, color:t.text }}>‹</button>
        <div style={{ flex:1, textAlign:"center", fontSize:22, fontWeight:800, color:t.text }}>Settings</div>
        <div style={{ width:40 }} />
      </div>

      <div style={{ ...S.bodyScroll, background:t.bg }} className="cc-cal">

        {/* ── Appearance ── */}
        <SH title="Appearance" />
        <div style={{ background:t.bg2, borderRadius:16, overflow:"hidden" }}>
          {[["☀️","Light",false],[" 🌙","Dark",true]].map(([icon,label,val],i)=>(
            <div key={label} onClick={()=>setDarkMode(val)} style={{
              display:"flex", alignItems:"center", gap:14, padding:"14px 16px", cursor:"pointer",
              borderBottom: i===0 ? `0.5px solid ${t.border}` : "none" }}>
              <span style={{ fontSize:20, width:24, textAlign:"center" }}>{icon}</span>
              <span style={{ flex:1, fontSize:16, fontWeight:600, color:t.text }}>{label}</span>
              {dm===val && <span style={{ color:"var(--ac,#0a84ff)", fontSize:20, fontWeight:800 }}>✓</span>}
            </div>
          ))}
        </div>

        <div style={{ fontSize:13, color:t.text2, margin:"14px 4px 8px", fontWeight:600 }}>Accent Color</div>
        <div style={{ display:"flex", gap:10, flexWrap:"wrap", padding:"2px 0 4px" }}>
          {ACCENT_COLORS.map(c=>(
            <button key={c} onClick={()=>setAccentColor(c)}
              style={{ width:36, height:36, borderRadius:18, background:c, border:"none",
                       cursor:"pointer", outline: c===accentColor ? `3px solid ${c}` : "none",
                       outlineOffset:2, boxShadow: c===accentColor ? "0 0 0 2px #fff, 0 0 0 4px "+c : "none" }} />
          ))}
        </div>

        {/* ── General ── */}
        <SH title="General" />
        <Card>
          <Row icon="🌐" label="Language" sub="English (EN)"
            right={<span style={{ color:t.text2, fontSize:20 }}>›</span>} />
          <Row icon="$" label="Currency" sub={currency}
            right={
              <select value={currency} onChange={e=>setCurrency(e.target.value)}
                style={{ border:"none", background:"transparent", color:"var(--ac,#0a84ff)",
                         fontSize:15, fontWeight:700, outline:"none", cursor:"pointer" }}>
                {["US Dollar (USD)","Euro (EUR)","British Pound (GBP)","Canadian Dollar (CAD)","Australian Dollar (AUD)"].map(c=>(
                  <option key={c}>{c}</option>
                ))}
              </select>
            } />
          <Row icon="≈" label="Simplified Display"
            sub="Round amounts to whole numbers ($125.50 → $126)"
            right={<Toggle on={simplifiedDisplay} onChange={setSimplifiedDisplay} />} />
          <Row icon="〜" label="Projected Balances" last
            sub="Show projected balance on each calendar day. The forecast banner will still reflect your financial outlook."
            right={<Toggle on={showProjectedBalances} onChange={setShowProjectedBalances} />} />
        </Card>

        {/* ── Notifications ── */}
        <SH title="Notifications" />
        <Card>
          <Row icon="🌅" label="Morning Forecast"
            sub="Get your daily balance forecast each morning"
            right={<Toggle on={morningForecast} onChange={setMorningForecast} />} />
          <TimeRow label="Morning Time" value={morningTime} onChange={setMorningTime} />
          <Row icon="🌆" label="Evening Forecast"
            sub="Review your financial outlook each evening"
            right={<Toggle on={eveningForecast} onChange={setEveningForecast} />} />
          <TimeRow label="Evening Time" value={eveningTime} onChange={setEveningTime} />
          <Row icon="💸" label="Payment Reminders"
            sub="Get notified about upcoming bills and payments"
            right={<Toggle on={paymentReminders} onChange={setPaymentReminders} />} />
          <TimeRow label="Reminder Time" value={reminderTime} onChange={setReminderTime} last />
        </Card>

        {/* ── Budget Categories ── */}
        <SH title="Budget Categories" />
        <Card>
          <Row icon="✏️" label="Manage Categories"
            sub="Customize budget categories, emojis, and colors"
            onClick={onManageCategories}
            right={<span style={{ color:"var(--ac,#0a84ff)", fontSize:20 }}>›</span>} />
          <Row icon="⊞" label="Widget Quick Add" last
            sub="Pick 3 categories to pin on your home screen widget"
            right={<span style={{ color:t.text2, fontSize:20 }}>›</span>} />
        </Card>

        {/* ── Expense Tracking ── */}
        <SH title="Expense Tracking" />
        <Card>
          <Row icon="✅" label="Auto-Mark as Paid" last
            sub="Automatically mark past-due items as paid"
            right={<Toggle on={autoMarkPaid} onChange={setAutoMarkPaid} />} />
        </Card>

        {/* ── Data Management ── */}
        <SH title="Data Management" />
        <Card>
          {!resetConfirm ? (
            <Row icon="↺" label="Reset & Start Fresh"
              sub="Clear all financial data and bank connections. Your account and preferences will be preserved."
              onClick={() => setResetConfirm(true)}
              last right={<span style={{ color:"#ff453a", fontSize:20 }}>›</span>} />
          ) : (
            <div style={{ padding:16 }}>
              <div style={{ fontSize:15, color:t.text2, lineHeight:1.5, marginBottom:14 }}>
                This will clear all transactions, budgets, and accounts. Display preferences will be preserved. This action cannot be undone.
              </div>
              <div style={{ display:"flex", gap:10 }}>
                <button onClick={()=>setResetConfirm(false)}
                  style={{ flex:1, padding:12, borderRadius:12, border:`1px solid ${t.border}`,
                           background:"transparent", color:t.text, fontWeight:700, fontSize:15, cursor:"pointer" }}>
                  Cancel
                </button>
                <button onClick={()=>{ onResetData(); setResetConfirm(false); }}
                  style={{ flex:1, padding:12, borderRadius:12, border:"none",
                           background:"#ff453a", color:"#fff", fontWeight:800, fontSize:15, cursor:"pointer" }}>
                  Reset
                </button>
              </div>
            </div>
          )}
        </Card>

        <div style={{ height:120 }} />
      </div>
    </div>
  );
}

// ============================================================================
// STATEMENT IMPORTER — PDF + CSV bank statement parser
// ============================================================================

// ── merchant → category lookup ───────────────────────────────────────────────
const MERCHANT_CATS = [
  [["rent","apartment","landlord","leasing","realty","hoa","homeowner"], "rent"],
  [["shell","chevron","bp","exxon","mobil","mobil","marathon","circle k","speedway","wawa","gas station","fuel","76 ","arco","sunoco","pilot flying","love's travel","ta travel"], "car"],
  [["car payment","auto loan","toyota financial","honda financial","ford motor credit","bmw financial","ally financial","gm financial","carmax","carvana"], "car"],
  [["at&t","verizon","t-mobile","sprint","boost mobile","metro pcs","cricket wireless","us cellular","straight talk","mint mobile"], "phone"],
  [["comcast","xfinity","spectrum","cox","optimum","wow!","internet","cable","dish network","directv","frontier communications"], "bills"],
  [["electric","water bill","utility","pg&e","national grid","con ed","duke energy","southern company","dominion energy","centerpoint","aps","pse&g","sewage"], "bills"],
  [["mcdonald","burger king","wendy","taco bell","chipotle","subway","kfc","chick-fil","popeyes","sonic drive","jack in the box","dairy queen","five guys","whataburger","in-n-out","shake shack","domino","pizza hut","little caesar","papa john","panda express","applebee","denny","ihop","olive garden","red lobster","outback","chili's","buffalo wild"], "food"],
  [["starbucks","dunkin","peet","coffee","donut","dutch bros","caribou coffee","tim horton"], "food"],
  [["uber eats","doordash","grubhub","postmates","instacart","gopuff","drizly","caviar","seamless"], "food"],
  [["walmart","target","costco","kroger","safeway","whole foods","trader joe","aldi","publix","heb","food lion","stop & shop","giant food","meijer","winco","sprouts","fresh market","wegmans","winn-dixie","bi-lo","harris teeter"], "food"],
  [["netflix","spotify","hulu","disney+","apple.com/bill","amazon prime","youtube premium","hbo max","peacock","paramount+","sling tv","fubo tv","crunchyroll","audible","pandora","tidal","deezer"], "subs"],
  [["payroll","salary","direct deposit","ach credit","employer","paycheck","gusto","adp pay","paychex","workday pay","intuit payroll"], "salary"],
  [["zelle","venmo","paypal","cash app","square cash","apple pay","google pay"], "other-out"],
  [["amazon","ebay","etsy","shopify","wayfair","chewy","overstock","wish ","shein","aliexpress","home depot","lowes","best buy","apple store","microsoft store"], "other-out"],
  [["cvs","walgreens","rite aid","pharmacy","drug store","rx "], "other-out"],
  [["planet fitness","la fitness","24 hour fitness","anytime fitness","equinox","crunch fitness","gold's gym","lifetime fitness","ymca"], "bills"],
  [["geico","progressive","state farm","allstate","farmers","liberty mutual","nationwide","usaa insurance","travelers insurance","health insurance","dental insurance","life insurance"], "bills"],
  [["student loan","sallie mae","navient","fedloan","great lakes","mohela"], "bills"],
  [["uber ","lyft","bird ","lime ","taxi","cab "], "car"],
  [["airline","delta","american air","united air","southwest air","spirit air","frontier air","jetblue","air ticket","flight "], "other-out"],
  [["hotel","marriott","hilton","hyatt","holiday inn","best western","airbnb","vrbo","expedia","booking.com"], "other-out"],
  [["freelance","consulting","contract pay","1099","invoice paid","client payment"], "freelance"],
  [["interest earned","dividend","investment","robinhood","coinbase","crypto","stock"], "other-in"],
  [["refund","return credit","reversal","chargeback"], "other-in"],
];

function guessCat(desc) {
  const d = desc.toLowerCase();
  for (const [kws, cat] of MERCHANT_CATS) {
    if (kws.some((k) => d.includes(k))) return cat;
  }
  return "other-out";
}

function parseCSVRow(line) {
  const out = [];
  let field = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ",") { out.push(field.trim()); field = ""; }
      else field += ch;
    }
  }
  out.push(field.trim());
  return out;
}

let _pdfjs = null;
async function getPdfJS() {
  if (_pdfjs) return _pdfjs;
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      _pdfjs = window.pdfjsLib;
      resolve(_pdfjs);
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function extractPDFText(arrayBuffer) {
  const pdfjsLib = await getPdfJS();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const allLines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    // Group items by rounded Y, preserving X order within each row
    const byY = {};
    for (const item of content.items) {
      if (!item.str) continue;
      const y = Math.round(item.transform[5] / 3) * 3; // 3pt bucket tolerates minor misalignment
      const x = item.transform[4];
      if (!byY[y]) byY[y] = [];
      byY[y].push({ t: item.str, x });
    }
    Object.keys(byY)
      .sort((a, b) => Number(b) - Number(a))
      .forEach((y) => {
        const row = byY[y].sort((a, b) => a.x - b.x).map(i => i.t).join(" ").trim();
        if (row) allLines.push(row);
      });
  }
  return allLines;
}

function normalizeDate(s) {
  if (!s) return null;
  s = s.trim().replace(/['"]/g, "");
  // MM/DD/YY or MM/DD/YYYY or MM-DD-YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let yr = m[3]; if (yr.length === 2) yr = (Number(yr) > 50 ? "19" : "20") + yr;
    return `${yr}-${m[1].padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  }
  // YYYY-MM-DD
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  // Jan 15, 2024  or  January 15 2024
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const mo = months[m[1].slice(0,3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,"0")}-${m[2].padStart(2,"0")}`;
  }
  // 15 Jan 2024
  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
  if (m) {
    const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const mo = months[m[2].slice(0,3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return dISO(d);
  return null;
}

// Parse a raw amount string to a number (handles $1,234.56, (1,234.56), 1,234.56-)
function parseAmt(s) {
  if (!s) return null;
  const neg = s.includes("(") || s.trim().endsWith("-");
  const n = parseFloat(s.replace(/[$,()\-\s]/g, "").replace(/,/g, ""));
  if (isNaN(n) || n <= 0) return null;
  return neg ? -n : n;
}

// Skip lines that are clearly headers/footers/summaries
const SKIP_RE = /^(page\s|statement\s|account\s|period\s|beginning balance|ending balance|opening balance|closing balance|total\s|subtotal|transactions for|date\s+description|posting date|transaction date|available balance|rewards|member since|routing|account number)/i;

function parsePDFLines(lines) {
  // Full date: MM/DD/YY(YY) or MM-DD-YY(YY). Partial: MM/DD or MM-DD at start of line.
  const DATE_FULL_RE    = /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\b/;
  const DATE_PARTIAL_RE = /^(\d{1,2}[\/\-]\d{1,2})\b/;
  const AMT_RE  = /\(?\$?([\d,]+\.\d{2})\)?-?/g;
  const CREDIT_WORDS = /\b(deposit|credit|payroll|direct dep|refund|cashback|reversal|interest paid|transfer from|payment received|dividend|atm deposit|mobile deposit)\b/i;
  const DEBIT_WORDS  = /\b(purchase|debit|payment|withdrawal|charge|fee|transfer to|atm withdrawal|pos |check #|zelle sent|overdraft)\b/i;

  // Infer statement year: find the most-recent full year referenced in any line
  let stmtYear = new Date().getFullYear();
  for (const line of lines) {
    const m = line.match(/\b(20\d{2})\b/);
    if (m) { stmtYear = parseInt(m[1], 10); break; }
  }

  const seen = new Set();
  const results = [];

  for (const line of lines) {
    if (!line || line.length < 8) continue;
    if (SKIP_RE.test(line.trim())) continue;

    // Must have a date — prefer full date, fall back to MM/DD at line start
    let dateISO = null;
    let dateMatchEnd = 0;
    const fullM = line.match(DATE_FULL_RE);
    if (fullM) {
      dateISO = normalizeDate(fullM[1]);
      dateMatchEnd = fullM.index + fullM[0].length;
    } else {
      const partM = line.match(DATE_PARTIAL_RE);
      if (partM) {
        const [mo, dy] = partM[1].split(/[\/\-]/).map(Number);
        if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
          dateISO = `${stmtYear}-${String(mo).padStart(2,"0")}-${String(dy).padStart(2,"0")}`;
          dateMatchEnd = partM[0].length;
        }
      }
    }
    if (!dateISO) continue;

    // Collect all numeric amounts on the line
    const rawAmounts = [];
    let am;
    const amtRe = /\(?\$?([\d,]+\.\d{2})\)?-?/g;
    while ((am = amtRe.exec(line)) !== null) {
      const v = parseAmt(am[0]);
      if (v !== null && Math.abs(v) < 1_000_000) rawAmounts.push({ v: Math.abs(v), raw: am[0] });
    }
    if (!rawAmounts.length) continue;

    // The transaction amount is the SECOND-TO-LAST number when multiple exist
    // (last is typically the running balance). When only one, use it.
    const txAmtObj = rawAmounts.length > 1 ? rawAmounts[rawAmounts.length - 2] : rawAmounts[0];
    const amount = txAmtObj.v;
    if (!amount || amount <= 0) continue;

    // Extract description: text between the date and the first dollar amount, cleaned up
    const dateEnd = dateMatchEnd;
    const firstAmtIdx = line.search(/\(?\$?[\d,]+\.\d{2}/);
    let desc = (firstAmtIdx > dateEnd
      ? line.slice(dateEnd, firstAmtIdx)
      : line.slice(dateEnd).replace(/\(?\$?[\d,]+\.\d{2}\)?-?/g, "")
    ).replace(/\s+/g, " ").trim();

    // Clean up common PDF artifacts
    desc = desc.replace(/\b(debit|credit|purchase|pos|ach|dda)\b/gi, "").replace(/\s{2,}/g, " ").trim();
    desc = desc.replace(/^[\-\s*#+]+|[\-\s*#+]+$/g, "").trim();
    if (!desc || desc.length < 2) desc = "Bank Transaction";
    if (desc.length > 70) desc = desc.slice(0, 70).trim();

    // Determine income vs expense
    const lo = line.toLowerCase();
    const isCredit = CREDIT_WORDS.test(lo) && !DEBIT_WORDS.test(lo);
    const type = isCredit ? "income" : "expense";
    const category = type === "income" ? (guessCat(desc) === "salary" || /payroll|direct dep|employer/i.test(lo) ? "salary" : "other-in") : guessCat(desc);

    // Deduplicate: same date + rounded amount + first 8 chars of description
    const key = `${dateISO}|${Math.round(amount * 100)}|${desc.slice(0,8).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      id: uid(), date: dateISO, name: desc, merchant: desc,
      amount: Math.round(amount * 100) / 100,
      type, category, status: "paid", frequency: "once"
    });
  }

  // Sort by date descending
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

// Detect opening/closing balance from statement for optional account sync
function detectStatementBalance(lines) {
  for (const line of lines) {
    const lo = line.toLowerCase();
    if (/(ending|closing|new)\s+balance/.test(lo)) {
      const m = line.match(/\$?([\d,]+\.\d{2})/);
      if (m) return parseFloat(m[1].replace(/,/g,""));
    }
  }
  return null;
}

function parseBankCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  let headerIdx = 0;
  let cols = null;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const row = parseCSVRow(lines[i]).map((c) => c.toLowerCase());
    if (row.some((c) => c.includes("date") || c.includes("amount") || c.includes("description"))) {
      headerIdx = i; cols = row; break;
    }
  }
  if (!cols) { cols = parseCSVRow(lines[0]).map((c) => c.toLowerCase()); headerIdx = 0; }

  const dateIdx   = cols.findIndex((c) => c.includes("date"));
  const descIdx   = cols.findIndex((c) => c.includes("description") || c.includes("merchant") || c.includes("memo") || c.includes("payee") || c.includes("detail"));
  const amtIdx    = cols.findIndex((c) => c === "amount" || c === "transaction amount" || c.includes("amount"));
  const debitIdx  = cols.findIndex((c) => c.includes("debit") || c.includes("withdrawal") || c.includes("charge"));
  const creditIdx = cols.findIndex((c) => c.includes("credit") || c.includes("deposit") || c.includes("payment"));

  const results = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const row = parseCSVRow(lines[i]);
    if (!row.length || row.every((c) => !c)) continue;

    const rawDate  = dateIdx >= 0 ? row[dateIdx] : "";
    const rawDesc  = descIdx >= 0 ? row[descIdx] : row[1] || "";
    const rawAmt   = amtIdx >= 0 ? row[amtIdx] : "";
    const rawDebit = debitIdx >= 0 ? row[debitIdx] : "";
    const rawCred  = creditIdx >= 0 ? row[creditIdx] : "";

    const dateStr = rawDate.replace(/['"]/g, "").trim();
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) continue;
    const dateISO = dISO(d);

    const clean = (s) => parseFloat(s.replace(/['"$, ]/g, "")) || 0;
    let amount = 0;
    let type = "expense";
    if (rawDebit || rawCred) {
      const cv = clean(rawCred);
      const dv = clean(rawDebit);
      if (cv > 0) { amount = cv; type = "income"; }
      else { amount = dv; type = "expense"; }
    } else {
      const v = clean(rawAmt);
      if (v < 0) { amount = Math.abs(v); type = "expense"; }
      else if (v > 0) { amount = v; type = "income"; }
    }
    if (amount <= 0) continue;

    const merchant = rawDesc.replace(/['"]/g, "").trim() || "Unknown";
    const category = type === "income" ? "salary" : guessCat(merchant);
    results.push({ id: uid(), date: dateISO, merchant, amount: Math.round(amount * 100) / 100, type, category, name: merchant, status: "paid", frequency: "once" });
  }
  return results;
}

function StatementImporter({ accounts, activeAccount, existingTxns, onClose, onImport, dm }) {
  const [parsed, setParsed] = useState([]);
  const [importStep, setImportStep] = useState("upload");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadMsg, setLoadMsg] = useState("");
  const [selAcct, setSelAcct] = useState(activeAccount);
  const [selected, setSelected] = useState({});
  const [detectedBalance, setDetectedBalance] = useState(null);
  const [applyBalance, setApplyBalance] = useState(true);
  const fileRef = useRef(null);

  const bg  = dm ? "#1c1c1e" : "#fff";
  const bg2 = dm ? "#2c2c2e" : "#f2f2f7";
  const tx2 = dm ? "#aeaeb2" : "#8e8e93";
  const txc = dm ? "#f2f2f7" : "#1c1c1e";
  const brd = dm ? "#3a3a3c" : "#e3e3e8";

  function finalize(txns, closingBalance) {
    if (!txns.length) { setError("No transactions found in this file."); setLoading(false); return; }
    const existIds = new Set(existingTxns.map((x) => x.date + "|" + x.amount + "|" + x.name));
    const fresh = txns.filter((t) => !existIds.has(t.date + "|" + t.amount + "|" + t.name));
    const sel = {};
    fresh.forEach((t) => { sel[t.id] = true; });
    setParsed(fresh);
    setSelected(sel);
    setDetectedBalance(closingBalance ?? null);
    setApplyBalance(closingBalance != null);
    setImportStep("review");
    setError("");
    setLoading(false);
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setError("");
    const isPDF = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";

    if (isPDF) {
      setLoading(true);
      setLoadMsg("Loading PDF engine…");
      try {
        const buf = await file.arrayBuffer();
        setLoadMsg("Reading pages…");
        const lines = await extractPDFText(buf);
        setLoadMsg("Extracting transactions…");
        const txns = parsePDFLines(lines);
        const closingBalance = detectStatementBalance(lines);
        finalize(txns, closingBalance);
      } catch (err) {
        setError("Could not read this PDF. Try exporting as CSV instead.");
        setLoading(false);
      }
    } else {
      setLoading(true);
      setLoadMsg("Parsing…");
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const txns = parseBankCSV(ev.target.result);
          finalize(txns, null);
        } catch { setError("Could not parse this file."); setLoading(false); }
      };
      reader.readAsText(file);
    }
  }

  function doImport() {
    const toAdd = parsed.filter((t) => selected[t.id]).map((t) => ({ ...t, account: selAcct }));
    const balanceUpdate = (applyBalance && detectedBalance != null) ? { acctId: selAcct, balance: detectedBalance } : null;
    onImport(toAdd, balanceUpdate);
  }

  const selCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="cc-overlay" style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", display:"flex", flexDirection:"column", justifyContent:"flex-end", zIndex:200 }} onClick={onClose}>
      <div className="cc-sheet" style={{ background:bg, borderRadius:"20px 20px 0 0", maxHeight:"88vh", display:"flex", flexDirection:"column" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ width:40, height:5, borderRadius:3, background:"#d1d1d6", margin:"10px auto 4px", flexShrink:0 }} />
        <div style={{ display:"flex", alignItems:"center", padding:"8px 16px 12px", flexShrink:0 }}>
          <button onClick={importStep === "review" ? () => { setImportStep("upload"); setParsed([]); } : onClose}
            style={{ background:"none", border:"none", fontSize:22, cursor:"pointer", color:tx2, padding:"4px 8px 4px 0" }}>
            {importStep === "review" ? "‹" : "✕"}
          </button>
          <div style={{ flex:1, fontSize:20, fontWeight:800, textAlign:"center", color:txc }}>Import Statement</div>
          {importStep === "review" && (
            <button onClick={doImport} disabled={selCount === 0}
              style={{ background:"#0a84ff", color:"#fff", border:"none", borderRadius:12, padding:"8px 16px", fontWeight:700, fontSize:15, cursor:selCount>0?"pointer":"not-allowed", opacity:selCount>0?1:0.5 }}>
              Add {selCount}
            </button>
          )}
          {importStep === "upload" && <div style={{ width:60 }} />}
        </div>

        {loading ? (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:40 }}>
            <div style={{ width:44, height:44, border:`4px solid ${brd}`, borderTopColor:"#0a84ff", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
            <div style={{ color:tx2, fontSize:15, fontWeight:600 }}>{loadMsg}</div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        ) : importStep === "upload" ? (
          <div style={{ flex:1, overflowY:"auto", padding:"0 16px 40px" }}>
            <div style={{ fontSize:14, color:tx2, lineHeight:1.6, marginBottom:20, textAlign:"center" }}>
              Import your bank statement as a PDF or CSV — transactions are matched automatically.
            </div>
            {accounts.length > 1 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:13, fontWeight:700, marginBottom:8, color:tx2 }}>Import into account</div>
                <select value={selAcct} onChange={(e) => setSelAcct(e.target.value)}
                  style={{ width:"100%", padding:"10px 14px", borderRadius:12, border:`1px solid ${brd}`, fontSize:15, background:bg2, color:txc }}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
            )}
            <button onClick={() => fileRef.current?.click()}
              style={{ width:"100%", background:bg2, border:`2px dashed ${brd}`, borderRadius:16, padding:"32px 16px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
              <svg viewBox="0 0 48 48" width="52" height="52" fill="none">
                <rect x="6" y="4" width="28" height="36" rx="4" fill="#0a84ff" opacity=".15"/>
                <rect x="6" y="4" width="28" height="36" rx="4" stroke="#0a84ff" strokeWidth="2.2"/>
                <path d="M28 4v10h10" stroke="#0a84ff" strokeWidth="2.2" strokeLinecap="round"/>
                <path d="M16 22h16M16 28h10" stroke="#0a84ff" strokeWidth="2" strokeLinecap="round"/>
                <circle cx="38" cy="36" r="9" fill="#30d158"/>
                <path d="M34 36l3 3 5-5" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span style={{ fontSize:17, fontWeight:700, color:txc }}>Select PDF or CSV</span>
              <span style={{ fontSize:13, color:tx2 }}>Chase · BofA · Wells Fargo · Citi · Capital One · Any bank</span>
            </button>
            <input ref={fileRef} type="file" accept=".pdf,.csv,application/pdf,text/csv" style={{ display:"none" }} onChange={handleFile} />
            {error && <div style={{ marginTop:16, padding:14, background:"#fde7e7", borderRadius:12, color:"#c0392b", fontWeight:600, fontSize:14, textAlign:"center" }}>{error}</div>}
            <div style={{ marginTop:20, padding:14, background:bg2, borderRadius:12 }}>
              <div style={{ fontSize:13, fontWeight:700, color:tx2, marginBottom:8 }}>How to get your statement:</div>
              <div style={{ fontSize:13, color:tx2, lineHeight:1.9 }}>
                <b style={{color:txc}}>PDF:</b> Download your monthly PDF statement from your bank app<br/>
                <b style={{color:txc}}>CSV:</b> Go to Transactions → Export / Download → Choose CSV<br/>
                Works with Chase, BofA, Wells Fargo, Citi, Capital One and more
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex:1, overflowY:"auto", padding:"0 16px 40px" }}>
            {detectedBalance != null && (
              <div onClick={() => setApplyBalance((v) => !v)}
                style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 14px", background:applyBalance?(dm?"#1a3a1a":"#e8faf0"):bg2, borderRadius:14, marginBottom:14, cursor:"pointer", border:`1px solid ${applyBalance?"#30d158":brd}` }}>
                <div style={{ fontSize:22 }}>🏦</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:700, color:txc }}>Set account balance to {fmtFull(detectedBalance)}</div>
                  <div style={{ fontSize:12, color:tx2 }}>Closing balance from your statement</div>
                </div>
                <div style={{ width:28, height:28, borderRadius:14, border:`2px solid ${applyBalance?"#30d158":brd}`, background:applyBalance?"#30d158":"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
                  {applyBalance && <span style={{ color:"#fff", fontSize:14, fontWeight:900 }}>✓</span>}
                </div>
              </div>
            )}
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
              <div style={{ fontSize:14, color:tx2 }}>{parsed.length} transaction{parsed.length !== 1 ? "s" : ""} found</div>
              <button onClick={() => {
                const allSel = selCount === parsed.length;
                const next = {};
                parsed.forEach((t) => { next[t.id] = !allSel; });
                setSelected(next);
              }} style={{ background:"none", border:"none", color:"#0a84ff", fontWeight:700, fontSize:15, cursor:"pointer" }}>
                {selCount === parsed.length ? "Deselect All" : "Select All"}
              </button>
            </div>
            {parsed.length === 0 ? (
              <div style={{ textAlign:"center", padding:"40px 16px", color:tx2 }}>
                <div style={{ fontSize:36, marginBottom:12 }}>✅</div>
                <div style={{ fontWeight:700, color:txc }}>All caught up!</div>
                <div style={{ fontSize:14, marginTop:4 }}>All transactions in this file are already imported.</div>
              </div>
            ) : parsed.map((tx) => {
              const on = !!selected[tx.id];
              const meta = catMeta(tx.category);
              const tint = tintFor(tx);
              return (
                <div key={tx.id} onClick={() => setSelected((p) => ({ ...p, [tx.id]: !p[tx.id] }))}
                  style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 4px", borderBottom:`1px solid ${brd}`, cursor:"pointer", opacity:on?1:0.4 }}>
                  <div style={{ width:24, height:24, borderRadius:12, border:`2px solid ${on?"#0a84ff":brd}`, background:on?"#0a84ff":"transparent", display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, transition:"all .15s" }}>
                    {on && <span style={{ color:"#fff", fontSize:13, fontWeight:900, lineHeight:1 }}>✓</span>}
                  </div>
                  <div style={{ width:38, height:38, borderRadius:10, background:tint.bg, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18, flexShrink:0 }}>
                    {meta.icon}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:700, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", color:txc }}>{tx.name}</div>
                    <div style={{ fontSize:12, color:tx2 }}>{tx.date} · {meta.label}</div>
                  </div>
                  <div style={{ fontSize:15, fontWeight:800, color:tx.type==="income"?"#30d158":txc, flexShrink:0 }}>
                    {tx.type==="income"?"+":"-"}{fmtFull(tx.amount)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
