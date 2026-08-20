import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { StoreProvider } from './state/store';
import { UpdateProvider } from './state/update';
import './styles/theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <UpdateProvider>
        <App />
      </UpdateProvider>
    </StoreProvider>
  </StrictMode>,
);
