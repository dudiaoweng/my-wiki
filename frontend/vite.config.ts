import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';

// ─── Cert paths ──────────────────────────────────────
const certDir = path.resolve(__dirname, '..', 'certs');
const serverKey = fs.readFileSync(path.join(certDir, 'server.key'));
const serverCert = fs.readFileSync(path.join(certDir, 'server.crt'));
const caCert = fs.readFileSync(path.join(certDir, 'ca.crt'));

function readAgent(certFile: string, keyFile: string): https.Agent {
  return new https.Agent({
    cert: fs.readFileSync(path.join(certDir, certFile)),
    key: fs.readFileSync(path.join(certDir, keyFile)),
    ca: caCert,
    rejectUnauthorized: false,
  });
}

// ─── Dev user registry ───────────────────────────────
const DEV_USERS: Record<string, { agent: https.Agent; displayName: string }> = {
  zh: {
    agent: readAgent('client_zh.crt', 'client.key'),
    displayName: '周衡',
  },
  xl: {
    agent: readAgent('client_xl.crt', 'client.key'),
    displayName: '谢林',
  },
};
const DEFAULT_USER = 'zh';

// ─── Custom proxy middleware (dynamic cert per request) ──
function mtlsProxyMiddleware(): Plugin {
  return {
    name: 'mtls-proxy',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';

        // Only proxy API & uploads
        if (!url.startsWith('/api/') && !url.startsWith('/uploads/')) {
          return next();
        }

        // Determine which client cert to use
        const userKey = (req.headers['x-dev-user'] as string || DEFAULT_USER).trim();
        const user = DEV_USERS[userKey] || DEV_USERS[DEFAULT_USER];

        // Build forwarding headers — skip HTTP/2 pseudo-headers
        // (:method, :path, …), the internal X-Dev-User marker, and the
        // original host (we set our own below).
        const fwdHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.startsWith(':') || k === 'x-dev-user' || k === 'host') continue;
          if (v === undefined) continue;
          fwdHeaders[k] = Array.isArray(v) ? v.join(', ') : v;
        }
        fwdHeaders['host'] = 'localhost:8000';

        const opts: https.RequestOptions = {
          hostname: 'localhost',
          port: 8000,
          path: url,
          method: req.method,
          headers: fwdHeaders,
          agent: user.agent,
          rejectUnauthorized: false,
        };

        const proxyReq = https.request(opts, (proxyRes) => {
          // Forward status & headers
          res.writeHead(
            proxyRes.statusCode || 200,
            proxyRes.headers,
          );
          proxyRes.pipe(res);
        });

        proxyReq.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ECONNREFUSED') {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('后端服务未启动。请先运行: cd backend && python -m app.main');
          } else {
            res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`代理错误: ${err.message}`);
          }
        });

        req.pipe(proxyReq);
      });
    },
  };
}

// ─── Vite config ─────────────────────────────────────
export default defineConfig({
  plugins: [react(), mtlsProxyMiddleware()],
  build: {
    outDir: path.resolve(__dirname, '..', 'backend', 'static'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-d3': ['d3'],
          'vendor-markdown': ['react-markdown', 'remark-gfm', 'rehype-raw'],
        },
      },
    },
  },
  server: {
    port: 5173,
    https: {
      key: serverKey,
      cert: serverCert,
    },
    // No built-in proxy — mtlsProxyMiddleware handles all /api/* forwarding
  },
});
