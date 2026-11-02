import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import type { User } from './types';

export default function App() {
  // undefined = ещё проверяем сессию, null = не вошли
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    api.me().then(setUser).catch(() => setUser(null));
  }, []);
  if (user === undefined) return <div className="flex min-h-screen items-center justify-center text-gray-500"><Loader2 className="size-6 animate-spin" aria-label="Загрузка" /></div>;
  return user ? <Shell user={user} onLogout={() => setUser(null)} /> : <Login onLogin={setUser} />;
}
