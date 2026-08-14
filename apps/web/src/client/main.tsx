import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './app';
import { CatalogProvider } from './state/catalog';
import { RealtimeProvider } from './state/realtime';
import { SelectionProvider } from './state/selection';
import { ToastProvider } from './state/toasts';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <RealtimeProvider>
          <CatalogProvider>
            <SelectionProvider>
              <App />
            </SelectionProvider>
          </CatalogProvider>
        </RealtimeProvider>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
);
