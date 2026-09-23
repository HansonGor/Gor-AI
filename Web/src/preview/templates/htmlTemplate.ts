import type { PreviewFiles } from '../core/types.ts';

export function createHtmlTemplate(): PreviewFiles {
  return {
    '/index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Gor Preview</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main>
      <h1>Gor Preview</h1>
      <p>Virtual FS is ready.</p>
    </main>
    <script src="./main.js"></script>
  </body>
</html>`,
    '/main.js': `document.documentElement.dataset.preview = 'ready';`,
    '/style.css': `body {
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
