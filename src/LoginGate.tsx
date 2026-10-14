import { useEffect, useState } from 'react';
import App from './App';

function LoginForm() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('login');
  const message = code === 'lock'
    ? '시도가 너무 많습니다. 15분 뒤에 다시 입력하세요.'
    : code === 'fail'
      ? '비밀번호가 올바르지 않습니다.'
      : '';

  return (
    <div className="min-h-screen bg-ink-950 text-ink-300 flex items-center justify-center p-6">
      <form
        action="/api/login"
        method="POST"
        className="panel w-full max-w-sm p-6 flex flex-col gap-4"
        autoComplete="on"
      >
        <div>
          <h1 className="text-lg font-semibold text-white">Binance Lite</h1>
          <p className="mt-1 text-xs text-ink-400 leading-relaxed">
            조회와 주문은 로그인 후에만 열립니다. 이 브라우저는 30일간 유지됩니다.
          </p>
        </div>
        {message ? <p className="text-sm text-danger">{message}</p> : null}
        <label className="flex flex-col gap-1 text-[11px] text-ink-400">
          아이디
          <input
            name="username"
            autoComplete="username"
            defaultValue="lite"
            className="bg-ink-950 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/40"
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-ink-400">
          비밀번호
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="bg-ink-950 border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent/40"
          />
        </label>
        <button type="submit" className="py-2.5 rounded-lg bg-accent text-ink-950 text-sm font-semibold">
          로그인
        </button>
      </form>
    </div>
  );
}

export default function LoginGate() {
  const [phase, setPhase] = useState<'check' | 'in' | 'out'>('check');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session')
      .then((res) => {
        if (!cancelled) setPhase(res.ok ? 'in' : 'out');
      })
      .catch(() => {
        if (!cancelled) setPhase('out');
      });
    const onNeed = () => setPhase('out');
    window.addEventListener('binance-lite-auth-required', onNeed);
    return () => {
      cancelled = true;
      window.removeEventListener('binance-lite-auth-required', onNeed);
    };
  }, []);

  if (phase === 'check') {
    return <div className="min-h-screen bg-ink-950" />;
  }
  if (phase === 'out') return <LoginForm />;
  return <App />;
}
