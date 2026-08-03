import { useParams, Link } from "react-router-dom";

// 主專案的個股頁（K線 + KDJ 等）沒有包含在這個 standalone 版裡，
// 這裡只是接住輪動圖點擊個股時的導轉，不然會變成 404。
export default function StockStub() {
  const { code } = useParams();
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center", fontFamily: "sans-serif" }}>
      <p style={{ fontSize: 14, color: "#666" }}>個股頁未包含在此 standalone 版本</p>
      <p style={{ fontSize: 20, fontWeight: 700, margin: "8px 0" }}>{code}</p>
      <Link to="/" style={{ color: "#1D4ED8" }}>← 回輪動圖</Link>
    </div>
  );
}
