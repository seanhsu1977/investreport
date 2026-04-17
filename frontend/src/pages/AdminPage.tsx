import { useEffect, useState } from "react";
import axios from "axios";
import { useAuth } from "../contexts/AuthContext";
import { Navigate } from "react-router-dom";

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

export default function AdminPage() {
  const { user, token } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    axios.get("/api/admin/users", { headers })
      .then((r) => setUsers(r.data))
      .finally(() => setLoading(false));
  }, []);

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

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">後台管理</h1>

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

      {/* 登入紀錄面板 */}
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
    </div>
  );
}
