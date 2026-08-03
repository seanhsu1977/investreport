import { Routes, Route } from "react-router-dom";
import SectorRotationPage from "./pages/SectorRotationPage";
import StockStub from "./pages/StockStub";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<SectorRotationPage />} />
      <Route path="/stocks/:code" element={<StockStub />} />
    </Routes>
  );
}
