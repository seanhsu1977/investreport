import { useEffect, useRef, useState } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { Navigate, useLocation } from "react-router-dom";
import { usePostMaterials } from "../hooks/usePostMaterials";

interface UserRecord {
  id: number;
  email: string;
  name: string;
  picture: string;
  is_admin: boolean;
  created_at: string;
  last_login: string;
  login_count: number;
}

interface Session {
  id: number;
  logged_in_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

interface ReportItem {
  id: number;
  stock_code: string;
  stock_name: string;
  recommendation: string;
  target_price: string;
  analyst: string;
  report_date: string;
  summary: string;
}

// ── 社群發布區塊 ─────────────────────────────────────────
function PublishSection({ token, initialIds }: { token: string; initialIds?: number[] }) {
  const headers = { Authorization: `Bearer ${token}` };
  const materials = usePostMaterials();
  const [reports, setReports] = useState<ReportItem[]>([]);
  // 從 location.state 進來（initialIds）為主，否則沿用全域素材（跨個股累積後直接導入）
  const [selected, setSelected] = useState<Set<number>>(() =>
    new Set(initialIds && initialIds.length > 0 ? initialIds : materials.ids)
  );
  const [hint, setHint] = useState("");
  const [draft, setDraft] = useState("");
  const [topicTag, setTopicTag] = useState("");
  const [nstockTitle, setNstockTitle] = useState("");
  const [alsoNstock, setAlsoNstock] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishResult, setPublishResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 篩選狀態
  const [search, setSearch] = useState("");
  const [recFilter, setRecFilter] = useState<string>("全部");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    axios.get("/api/publish/reports?limit=100", { headers }).then((r) => setReports(r.data));
  }, []);

  const REC_OPTIONS = ["全部", "買進", "增持", "持有", "中立", "減持", "賣出"];

  const filtered = reports.filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      if (!r.stock_code.includes(q) && !r.stock_name?.toLowerCase().includes(q) && !r.analyst?.toLowerCase().includes(q))
        return false;
    }
    if (recFilter !== "全部" && r.recommendation !== recFilter) return false;
    if (dateFrom && r.report_date < dateFrom) return false;
    if (dateTo && r.report_date > dateTo) return false;
    return true;
  });

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const generateDraft = async () => {
    if (selected.size === 0) return;
    setDraft("");
    setPublishResult(null);
    setGenerating(true);

    const resp = await fetch("/api/publish/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ report_ids: [...selected], hint }),
    });

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") break;
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) { content = `⚠️ ${parsed.error}`; break; }
          content += parsed.text ?? "";
          setDraft(content);
          bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        } catch {}
      }
    }
    setGenerating(false);
  };

  const publish = async () => {
    if (!draft.trim()) return;
    if (alsoNstock && !nstockTitle.trim()) {
      setPublishResult({ ok: false, msg: "請輸入 nStock 標題（或取消勾選同時發布）" });
      return;
    }
    setPublishing(true);
    setPublishResult(null);

    const messages: string[] = [];
    let anyFail = false;

    // 1. Threads
    try {
      const payload: { text: string; topic_tag?: string } = { text: draft };
      const tag = topicTag.trim();
      if (tag) payload.topic_tag = tag;
      const r = await axios.post("/api/publish/threads", payload, { headers });
      const segs = r.data.segments ?? 1;
      const chainHint = segs > 1 ? `（${segs} 段留言鏈）` : "";
      messages.push(`✅ Threads ${chainHint}：${r.data.post_id}`);
    } catch (e: any) {
      anyFail = true;
      const detail = e.response?.data?.detail ?? "發布失敗";
      messages.push(`❌ Threads：${detail}`);
    }

    // 2. nStock（同時發布）
    if (alsoNstock) {
      try {
        const r = await axios.post(
          "/api/publish/nstock",
          { title: nstockTitle.trim(), content: draft },
          { headers }
        );
        const aid = r.data.article_id;
        const sids = r.data.stock_ids;
        const stockHint = sids ? `（相關股號 ${sids}）` : "";
        if (aid) {
          messages.push(`✅ nStock：article_id ${aid}${stockHint}`);
        } else {
          const rawPreview = JSON.stringify(r.data.raw ?? r.data).slice(0, 120);
          messages.push(`⚠️ nStock 回 200 但抓不到 article_id${stockHint}（raw: ${rawPreview}…）`);
        }
      } catch (e: any) {
        anyFail = true;
        const detail = e.response?.data?.detail ?? "發布失敗";
        messages.push(`❌ nStock：${detail}`);
      }
    }

    setPublishResult({ ok: !anyFail, msg: messages.join("　|　") });
    // 全部成功才清空素材，部份失敗保留以便重試
    if (!anyFail) materials.clear();
    setPublishing(false);
  };

  const recColor: Record<string, string> = {
    買進: "bg-green-100 text-green-700",
    增持: "bg-green-100 text-green-700",
    持有: "bg-yellow-100 text-yellow-700",
    中立: "bg-yellow-100 text-yellow-700",
    賣出: "bg-red-100 text-red-700",
    減持: "bg-red-100 text-red-700",
  };

  return (
    <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-5 py-3 border-b border-gray-100">
        <h2 className="font-semibold text-gray-700">社群發布</h2>
        <p className="text-xs text-gray-400 mt-0.5">選擇報告 → 生成草稿 → 發布到 Threads</p>
      </div>

      <div className="p-5 grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* 左：報告選擇 */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-gray-600">選擇報告（可多選）</p>

          {/* 篩選列 */}
          <div className="space-y-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜尋股票代號、名稱、分析師…"
              className="w-full text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
            <div className="flex gap-1 flex-wrap">
              {REC_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setRecFilter(opt)}
                  className={`text-xs px-2 py-0.5 rounded-full border transition ${
                    recFilter === opt
                      ? "bg-blue-600 text-white border-blue-600"
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="flex gap-2 items-center text-xs text-gray-500">
              <span>日期</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="text-xs px-2 py-1 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-300" />
              <span>—</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="text-xs px-2 py-1 rounded border border-gray-200 focus:outline-none focus:ring-1 focus:ring-blue-300" />
              {(search || recFilter !== "全部" || dateFrom || dateTo) && (
                <button onClick={() => { setSearch(""); setRecFilter("全部"); setDateFrom(""); setDateTo(""); }}
                  className="text-blue-500 hover:underline ml-1">清除</button>
              )}
            </div>
            <p className="text-xs text-gray-400">共 {filtered.length} 筆</p>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {filtered.map((r) => {
              const active = selected.has(r.id);
              return (
                <div
                  key={r.id}
                  className={`flex items-start gap-3 p-2.5 rounded-lg border transition ${
                    active ? "border-blue-400 bg-blue-50" : "border-gray-100 hover:border-gray-300"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggle(r.id)}
                    className="mt-1 accent-blue-600 shrink-0 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1 cursor-pointer" onClick={() => toggle(r.id)}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800 text-sm">{r.stock_code} {r.stock_name}</span>
                      {r.recommendation && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${recColor[r.recommendation] ?? "bg-gray-100 text-gray-500"}`}>
                          {r.recommendation}
                        </span>
                      )}
                      {r.target_price && (
                        <span className="text-xs text-gray-400">目標 {r.target_price}</span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{r.analyst} · {r.report_date}</p>
                  </div>
                </div>
              );
            })}
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 block mb-1">補充方向（選填）</label>
            <input
              type="text"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="例：著重 AI 題材、適合保守型投資人…"
              className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          <button
            onClick={generateDraft}
            disabled={selected.size === 0 || generating}
            className="w-full py-2 bg-blue-600 text-white text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-40 transition"
          >
            {generating ? "生成中…" : `生成草稿（已選 ${selected.size} 篇）`}
          </button>
        </div>

        {/* 右：草稿編輯 + 發布 */}
        <div className="space-y-3 flex flex-col">
          <p className="text-sm font-medium text-gray-600">貼文草稿</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="草稿將在這裡顯示，可直接編輯…"
            rows={10}
            className="flex-1 w-full text-sm px-3 py-2 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none font-sans leading-relaxed"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 shrink-0 w-16">Threads 主題</span>
            <input
              type="text"
              value={topicTag}
              onChange={(e) => setTopicTag(e.target.value)}
              placeholder="例：投資、台股、ETF（可留空）"
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300"
            />
          </div>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 shrink-0 text-xs text-gray-600 select-none">
              <input
                type="checkbox"
                checked={alsoNstock}
                onChange={(e) => setAlsoNstock(e.target.checked)}
                className="accent-blue-500"
              />
              同步 nStock
            </label>
            <input
              type="text"
              value={nstockTitle}
              onChange={(e) => setNstockTitle(e.target.value)}
              disabled={!alsoNstock}
              placeholder={alsoNstock ? "nStock 文章標題（必填）" : "已停用"}
              className="flex-1 text-sm px-3 py-1.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:bg-gray-50 disabled:text-gray-400"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-medium ${draft.length > 500 ? "text-yellow-600" : "text-gray-400"}`}>
              {draft.length} 字元{draft.length > 500 ? `　• 將切成 ${Math.ceil(draft.length / 490)} 段串留言鏈` : ""}
            </span>
            <button
              onClick={publish}
              disabled={!draft.trim() || publishing}
              className="px-4 py-2 bg-black text-white text-sm rounded-lg font-medium hover:bg-gray-800 disabled:opacity-40 transition flex items-center gap-2"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm0 18c-4.418 0-8-3.582-8-8s3.582-8 8-8 8 3.582 8 8-3.582 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/>
              </svg>
              {publishing ? "發布中…" : "發布到 Threads"}
            </button>
          </div>

          {publishResult && (
            <div className={`text-sm px-3 py-2 rounded-lg ${publishResult.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
              {publishResult.msg}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

    </section>
  );
}

// ── 主頁面 ────────────────────────────────────────────────
export default function AdminPage() {
  const { user, token } = useAuth();
  const location = useLocation();
  const locState = location.state as { tab?: "publish" | "users"; selectedIds?: number[] } | null;
  const [tab, setTab] = useState<"publish" | "users">(locState?.tab ?? "publish");
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    if (tab !== "users") return;
    setLoading(true);
    axios.get("/api/admin/users", { headers })
      .then((r) => setUsers(r.data))
      .finally(() => setLoading(false));
  }, [tab]);

  const loadSessions = (u: UserRecord) => {
    setSelectedUser(u);
    axios.get(`/api/admin/users/${u.id}/sessions`, { headers })
      .then((r) => setSessions(r.data));
  };

  const toggleAdmin = async (u: UserRecord) => {
    await axios.patch(`/api/admin/users/${u.id}/admin?is_admin=${!u.is_admin}`, {}, { headers });
    setUsers((prev) => prev.map((x) => x.id === u.id ? { ...x, is_admin: !u.is_admin } : x));
  };

  if (!user) return <Navigate to="/" replace />;
  if (!user.is_admin) return (
    <div className="max-w-2xl mx-auto py-16 px-4 text-center text-gray-500">無管理員權限</div>
  );

  const tabs = [
    { id: "publish", label: "社群發布" },
    { id: "users",   label: "帳號管理" },
  ] as const;

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">後台管理</h1>
      </div>

      {/* Tab 列 */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition ${
              tab === t.id ? "bg-white text-gray-800 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "publish" && <PublishSection token={token ?? ""} initialIds={locState?.selectedIds} />}

      {tab === "users" && (
        <>{/* 使用者列表 */}
      <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <h2 className="font-semibold text-gray-700">使用者列表</h2>
          <span className="text-sm text-gray-400">{users.length} 位</span>
        </div>

        {loading ? (
          <p className="px-5 py-4 text-gray-400">載入中…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left">使用者</th>
                <th className="px-4 py-2 text-left">Email</th>
                <th className="px-4 py-2 text-center">登入次數</th>
                <th className="px-4 py-2 text-left">最後登入</th>
                <th className="px-4 py-2 text-left">加入時間</th>
                <th className="px-4 py-2 text-center">Admin</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-gray-50 transition">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {u.picture && <img src={u.picture} className="w-7 h-7 rounded-full" alt="" />}
                      <span className="font-medium text-gray-800">{u.name || "—"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.email}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="font-semibold text-gray-700">{u.login_count}</span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">{u.last_login?.slice(0, 16).replace("T", " ")}</td>
                  <td className="px-4 py-3 text-gray-500">{u.created_at?.slice(0, 10)}</td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => toggleAdmin(u)}
                      className={`text-xs px-2 py-0.5 rounded font-medium transition ${
                        u.is_admin ? "bg-purple-100 text-purple-700 hover:bg-purple-200" : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                      }`}>
                      {u.is_admin ? "✓ Admin" : "一般"}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={() => loadSessions(u)}
                      className="text-xs text-blue-500 hover:underline">
                      登入紀錄
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selectedUser && (
          <section className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-semibold text-gray-700">{selectedUser.name} 的登入紀錄</h2>
              <button onClick={() => setSelectedUser(null)} className="text-xs text-gray-400 hover:text-gray-600">關閉</button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-gray-500 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left">時間</th>
                  <th className="px-4 py-2 text-left">IP</th>
                  <th className="px-4 py-2 text-left">瀏覽器</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-700">{s.logged_in_at?.slice(0, 16).replace("T", " ")}</td>
                    <td className="px-4 py-2 text-gray-500">{s.ip_address || "—"}</td>
                    <td className="px-4 py-2 text-gray-400 text-xs max-w-xs truncate">{s.user_agent || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        </>
      )}
    </div>
  );
}
