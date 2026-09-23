import type { PreviewFiles } from '../core/types.ts';

export function createReactTemplate(): PreviewFiles {
  return {
    '/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gor React Preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`,
    '/src/main.tsx': `import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);`,
    '/src/App.tsx': `export default function App() {
  return (
    <main>
      <h1>Gor Preview</h1>
      <p>Virtual FS is ready.</p>
    </main>
  );
}`,
    '/src/style.css': `body {
  margin: 0;
  font-family: system-ui, sans-serif;
  background: #f7f7fb;
  color: #20202a;
}

main {
  max-width: 720px;
  margin: 80px auto;
  padding: 32px;
}`,
  };
}
