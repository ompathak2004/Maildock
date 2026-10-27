import React from 'react';
import ReactDOM from 'react-dom/client';
import { Popup } from '../../ui/Popup';
import '../../ui/styles.css';
import '../../ui/popup.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
