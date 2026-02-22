/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `src/index.html`.
 */

import {createRoot} from 'react-dom/client';
import {App} from './App';

function start() {
  console.log('Starting frontend...');
  // biome-ignore lint/style/noNonNullAssertion: root element is guaranteed to exist in index.html
  const root = createRoot(document.getElementById('root')!);
  console.log('Root created');
  root.render(<App />);
  console.log('Frontend started');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
