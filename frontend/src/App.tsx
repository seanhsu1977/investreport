import { useState, useRef, useEffect, useCallback } from "react";
import { Routes, Route, NavLink, useLocation } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import WatchlistPage from "./pages/WatchlistPage";
import StockPage from "./pages/StockPage";
import RecentPage from "./pages/RecentPage";
import SearchPage from "./pages/SearchPage";
import AdminPage from "./pages/AdminPage";
import RankingPage from "./pages/RankingPage";
import ChipsPage from "./pages/ChipsPage";
import SyncStatus from "./components/SyncStatus";
import LoginButton from "./components/LoginButton";
import PostMaterialsBar from "./components/PostMaterialsBar";
import { AuthProvider } from "./contexts/AuthContext";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

function ScrollToTop() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 300);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  if (!visible) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className="fixed bottom-20 right-6 z-50 w-10 h-10 rounded-full bg-white border border-gray-200 shadow-md text-gray-500 hover:text-blue-600 hover:border-blue-300 flex items-center justify-center transition"
      title="回到頂端"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
        <path d="M5 15l7-7 7 7" />
      </svg>
    </button>
  );
}

const NAV_ITEMS = [
  { to: "/",        label: "自選股",   end: true  },
  { to: "/recent",  label: "近期消息", end: false },
  { to: "/ranking", label: "排行",     end: false },
  { to: "/chips",   label: "籌碼面",   end: false },
  { to: "/search",  label: "搜尋",     end: false },
];

function HamburgerMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();

  // 路由切換時關閉
  useEffect(() => { setOpen(false); }, [location]);

  // 點外部關閉
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const activeCls = "block px-4 py-2.5 text-sm font-medium text-blue-600 bg-blue-50 rounded-lg";
  const inactiveCls = "block px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 rounded-lg";

  return (
    <div ref={ref} className="relative sm:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition"
        aria-label="選單"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          {open
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-white rounded-xl border border-gray-200 shadow-lg py-1.5 z-50">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => isActive ? activeCls : inactiveCls}
            >
              {item.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function App() {
  const navCls = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition ${
      isActive ? "bg-blue-100 text-blue-700" : "text-gray-500 hover:text-gray-800"
    }`;

  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white border-b border-gray-200 sticky top-0 z-20">
            <div className="max-w-4xl mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
              {/* 品牌名稱：始終顯示 */}
              <span className="font-bold text-gray-800 text-base shrink-0">投顧報告系統</span>

              {/* 桌面導覽列 */}
              <nav className="hidden sm:flex gap-0.5 flex-1">
                {NAV_ITEMS.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} className={navCls}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>

              <div className="flex items-center gap-2 shrink-0">
                <SyncStatus />
                <LoginButton />
                {/* 手機漢堡選單 */}
                <HamburgerMenu />
              </div>
            </div>
          </header>

          <main>
            <Routes>
              <Route path="/" element={<WatchlistPage />} />
              <Route path="/recent" element={<RecentPage />} />
              <Route path="/search" element={<SearchPage />} />
              <Route path="/stocks/:code" element={<StockPage />} />
              <Route path="/ranking" element={<RankingPage />} />
              <Route path="/chips" element={<ChipsPage />} />
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </main>
          <PostMaterialsBar />
          <ScrollToTop />
        </div>
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
