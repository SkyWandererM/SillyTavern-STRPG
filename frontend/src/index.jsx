import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';

function mount() {
    if (document.getElementById('strpg-react-root')) return;
    const host = document.createElement('div');
    host.id = 'strpg-react-root';
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(<App />);
    globalThis.__STRPG_UI__ = { root, version: '1.0.1' };
    console.log('[STRPG] Control Center UI mounted.');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
    mount();
}
