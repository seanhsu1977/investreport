import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { usePostMaterials } from "../hooks/usePostMaterials";

/**
 * 全域浮動列：當有貼文素材已被選取時顯示，admin 限定。
 * 點「前往發布」會帶 selectedIds 跳轉到 /admin。
 */
export default function PostMaterialsBar() {
  const { user } = useAuth();
  const { ids, count, clear } = usePostMaterials();
  const navigate = useNavigate();
  const location = useLocation();

  if (!user?.is_admin || count === 0) return null;
  // 已經在 admin 頁就不再顯示（避免重複）
  if (location.pathname.startsWith("/admin")) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-white rounded-full shadow-lg border border-gray-200 pl-4 pr-2 py-2 flex items-center gap-3"
    >
      <span className="text-sm text-gray-600">
        貼文素材 <span className="font-bold text-blue-600">{count}</span> 篇
      </span>
      <button
        onClick={clear}
        className="text-xs text-gray-400 hover:text-gray-600 px-2"
      >
        清除
      </button>
      <button
        onClick={() => navigate("/admin", { state: { tab: "publish", selectedIds: ids } })}
        className="px-4 py-1.5 rounded-full bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition"
      >
        前往發布 →
      </button>
    </div>
  );
}
