import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { pairDevice, takePairingTokenFromUrl } from './api/client';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/pages.css';
import './styles/reader.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found.');
}
const container: HTMLElement = rootElement;

/**
 * Device pairing runs BEFORE the app renders: a LAN link carries
 * `?token=<pairing secret|code>`, which is exchanged for this device's own
 * HttpOnly cookie. Rendering first would fire data queries that the server
 * refuses for an unpaired device, so the trade happens here and the token is
 * stripped from the address bar in the same step.
 *
 * A rejected pairing renders nothing at all — the blank page an unpaired
 * device gets from the server, kept consistent even in dev/host setups where
 * the server did serve the shell (e.g. an expired Share-dialog code).
 */
async function boot(): Promise<void> {
  const pairingToken = takePairingTokenFromUrl();
  if (pairingToken) {
    try {
      await pairDevice(pairingToken);
    } catch {
      return;
    }
  }

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
