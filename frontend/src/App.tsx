import { useState, useRef, useEffect, useCallback } from "react";
import { Routes, Route, NavLink, Navigate, useLocation } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import WatchlistPage from "./pages/WatchlistPage";
import StockPage from "./pages/StockPage";
import RecentPage from "./pages/RecentPage";
import SearchPage from "./pages/SearchPage";
import AdminPage from "./pages/AdminPage";
import RankingPage from "./pages/RankingPage";
import RecommendationsPage from "./pages/RecommendationsPage";
import ChipsPage from "./pages/ChipsPage";
import EtfTrackerPage from "./pages/EtfTrackerPage";
import LoginButton from "./components/LoginButton";
import PostMaterialsBar from "./components/PostMaterialsBar";
import { AuthProvider, useAuth } from "./contexts/AuthContext";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "";

// ルート切替時に自動でページ先頭へ戻る
function RouteScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

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
  { to: "/",          label: "投顧精選", end: true,  auth: true  },
  { to: "/watchlist", label: "自選股",   end: false, auth: false },
  { to: "/recent",    label: "近期消息", end: false, auth: true  },
  { to: "/ranking",   label: "排行",     end: false, auth: true  },
  { to: "/chips",       label: "籌碼面",   end: false, auth: true  },
  { to: "/etf-tracker", label: "ETF追蹤",  end: false, auth: true  },
  { to: "/search",      label: "搜尋",     end: false, auth: true  },
];

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/watchlist" replace />;
  return <>{children}</>;
}

function HamburgerMenu() {
  const { user } = useAuth();
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

  const activeCls = "block px-4 py-2.5 text-sm font-semibold text-white bg-white/10 rounded-lg";
  const inactiveCls = "block px-4 py-2.5 text-sm font-medium text-white/70 hover:text-white hover:bg-white/7 rounded-lg";

  return (
    <div ref={ref} className="relative sm:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition"
        aria-label="選單"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          {open
            ? <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            : <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-44 bg-[#122548] rounded-xl border border-white/10 shadow-lg py-1.5 z-50">
          {NAV_ITEMS.filter((item) => !item.auth || user).map((item) => (
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

function AppInner() {
  const { user } = useAuth();
  const navCls = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-lg text-sm font-medium transition ${
      isActive
        ? "text-white bg-white/10 font-semibold"
        : "text-white/55 hover:text-white hover:bg-white/[0.07]"
    }`;

  return (
    <div className="min-h-screen bg-[#F0F2F6]">
      <header className="bg-[#0B1E3D] border-b border-white/[0.06] sticky top-0 z-20 h-14">
        <div className="max-w-5xl mx-auto px-4 h-full flex items-center justify-between gap-4">
          {/* Logo */}
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-7 h-7 rounded-[6px] flex items-center justify-center text-[#0B1E3D] text-xs font-black"
              style={{ background: "linear-gradient(135deg, #C9A84C 0%, #E8C36A 100%)" }}>
              投
            </div>
            <span className="font-bold text-white text-[15px] tracking-[0.3px]">InvestAlpha</span>
          </div>

          {/* 桌面導覽列 */}
          <nav className="hidden sm:flex gap-0.5 flex-1">
            {NAV_ITEMS.filter((item) => !item.auth || user).map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={navCls}>
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            <LoginButton />
            <HamburgerMenu />
          </div>
        </div>
      </header>

      <RouteScrollToTop />
      <main>
        <Routes>
          <Route path="/"             element={<RequireAuth><RecommendationsPage /></RequireAuth>} />
          <Route path="/watchlist"    element={<WatchlistPage />} />
          <Route path="/recent"       element={<RequireAuth><RecentPage /></RequireAuth>} />
          <Route path="/search"       element={<RequireAuth><SearchPage /></RequireAuth>} />
          <Route path="/stocks/:code" element={<RequireAuth><StockPage /></RequireAuth>} />
          <Route path="/ranking"      element={<RequireAuth><RankingPage /></RequireAuth>} />
          <Route path="/chips"        element={<RequireAuth><ChipsPage /></RequireAuth>} />
          <Route path="/etf-tracker" element={<RequireAuth><EtfTrackerPage /></RequireAuth>} />
          <Route path="/admin"        element={<RequireAuth><AdminPage /></RequireAuth>} />
        </Routes>
      </main>
      <PostMaterialsBar />
      <ScrollToTop />
    </div>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <AuthProvider>
        <AppInner />
      </AuthProvider>
    </GoogleOAuthProvider>
  );
}
