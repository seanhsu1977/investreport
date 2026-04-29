import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "post_materials_v1";

function read(): number[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function write(ids: number[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  // 廣播給同一分頁的其他 hook 實例
  window.dispatchEvent(new CustomEvent("post_materials_change", { detail: ids }));
}

/**
 * 全域貼文素材選取狀態（localStorage 持久化、跨個股頁累積）。
 * 多個元件呼叫此 hook 會共用同一份 list，任一處修改都會同步更新。
 */
export function usePostMaterials() {
  const [ids, setIds] = useState<number[]>(() => read());

  useEffect(() => {
    const onCustom = (e: Event) => {
      const detail = (e as CustomEvent<number[]>).detail;
      if (Array.isArray(detail)) setIds(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setIds(read());
    };
    window.addEventListener("post_materials_change", onCustom);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("post_materials_change", onCustom);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const has = useCallback((id: number) => ids.includes(id), [ids]);

  const toggle = useCallback((id: number) => {
    const cur = read();
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    write(next);
  }, []);

  const remove = useCallback((id: number) => {
    write(read().filter((x) => x !== id));
  }, []);

  const clear = useCallback(() => {
    write([]);
  }, []);

  return { ids, count: ids.length, has, toggle, remove, clear };
}
