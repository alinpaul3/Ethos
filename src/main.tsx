import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Suppress Vite's benign WebSocket connection failures from triggering the unhandled rejection screen
if (typeof window !== "undefined") {
  window.addEventListener("unhandledrejection", (event) => {
    if (event.reason && (
      event.reason.message?.includes("WebSocket") || 
      event.reason.message?.includes("failed to connect to websocket") ||
      String(event.reason).includes("WebSocket")
    )) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
  window.addEventListener("error", (event) => {
    if (event.message && (
      event.message.includes("WebSocket") ||
      event.message.includes("failed to connect to websocket")
    )) {
      event.preventDefault();
      event.stopPropagation();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
