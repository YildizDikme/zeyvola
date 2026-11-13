import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import { App } from './App';
import { initI18n } from './i18n';
import { runSmokeTests } from './smoke';
import './styles/tokens.css';
import './styles/app.css';

document.documentElement.dataset.platform = window.zeyvola.platform;

void api.appInfo().then(async (info) => {
  if (!info.smoke) return;
  document.documentElement.dataset.smoke = '1';
  // Test suites (shared/test-suite.ts). They are loaded on demand, so normal starts never run them.
  const run = info.suite === 'perf' ? (await import('./testing/perf')).runPerfTests
    : info.suite === 'ui' ? (await import('./testing/uitest')).runUiTest
      : info.suite === 'docs' ? (await import('./testing/docshots')).runDocShots
        : runSmokeTests;
  let report: unknown;
  try { report = await run(); } catch (e) { report = { ok: false, error: (e as Error).stack ?? String(e) }; }
  void api.smokeReport(report);
});

void initI18n().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
