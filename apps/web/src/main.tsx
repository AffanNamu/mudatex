import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);

// Offline selling needs the app itself to load without a connection (see public/sw.js).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then((reg) => {
        const files = performance.getEntriesByType('resource').map((r) => r.name).filter((n) => new URL(n).origin === location.origin);
        reg.active?.postMessage({ type: 'precache', urls: ['/', '/config.js', ...files] });
      })
      .catch(() => undefined);
  });
}
