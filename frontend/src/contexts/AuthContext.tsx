import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import axios from "axios";

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  picture: string;
  is_admin: boolean;
}

interface AuthContextType {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (credential: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  user: null, token: null, loading: true,
  login: async () => {}, logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("auth_token"));
  const [loading, setLoading] = useState(() => !!localStorage.getItem("auth_token"));

  // 啟動時用已存的 token 驗證
  useEffect(() => {
    if (!token) { setLoading(false); return; }
    axios.get("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => setUser(r.data))
      .catch(() => { localStorage.removeItem("auth_token"); setToken(null); })
      .finally(() => setLoading(false));
  }, []);

  const login = async (credential: string) => {
    const { data } = await axios.post("/api/auth/google", { credential });
    localStorage.setItem("auth_token", data.token);
    setToken(data.token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem("auth_token");
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
