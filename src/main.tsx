import {createRoot} from 'react-dom/client';
import LoginGate from './LoginGate.tsx';
import './index.css';

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (
    res.status === 401
    && url.includes('/api/')
    && !url.includes('/api/session')
    && !url.includes('/api/login')
  ) {
    window.dispatchEvent(new Event('binance-lite-auth-required'));
  }
  return res;
};

createRoot(document.getElementById('root')!).render(
  <LoginGate />,
);
