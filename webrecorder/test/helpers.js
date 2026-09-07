const fs = require('fs');
const http = require('http');
const path = require('path');

function launchOptions() {
  const opts = {};
  if (process.env.WEBRECORDER_CHROMIUM_PATH) opts.executablePath = process.env.WEBRECORDER_CHROMIUM_PATH;
  return opts;
}

// Static file server for a fixture directory. Resolves to { server, baseUrl }.
function serveDir(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]);
      const file = path.join(dir, rel === '/' ? '/index.html' : rel);
      if (!file.startsWith(dir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      fs.readFile(file, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        res.writeHead(200);
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${label}`))
    .catch((err) => {
      console.error(`FAIL - ${label}`);
      throw err;
    });
}

module.exports = { launchOptions, serveDir, check };
