import { useEffect, useState } from 'react';

export function App() {
  const [status, setStatus] = useState('проверяю сервер…');

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((j: { status: string }) => setStatus(j.status === 'ok' ? 'сервер работает' : 'сервер ответил странно'))
      .catch(() => setStatus('сервер недоступен'));
  }, []);

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 480, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>DV Cloud</h1>
      <p>Домашнее облако. Ранняя разработка.</p>
      <p>Состояние: {status}</p>
    </main>
  );
}
