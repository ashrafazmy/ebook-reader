import { useEffect, useState } from 'react';
export function useOnline() {
  const [online, setOnline] = useState(navigator.onLine !== false);
  useEffect(() => { const update = () => setOnline(navigator.onLine !== false); window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); }; }, []);
  return online;
}
