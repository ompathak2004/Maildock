import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from '../../ui/App';
import '../../ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
