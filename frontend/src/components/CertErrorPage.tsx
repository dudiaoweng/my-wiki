import { useState } from 'react';
import { checkAuthStatus } from '../api/auth';
import styles from './CertErrorPage.module.css';

interface Props {
  reason?: 'denied' | 'logged-out';
}

const isProduction = !import.meta.env.DEV;

export function CertErrorPage({ reason = 'denied' }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);

  const handleLogin = async () => {
    if (isProduction) {
      // Page navigation triggers the browser's native TLS certificate
      // selection dialog, then redirects back with ?auth=1 on success.
      setRetrying(true);
      window.location.href = '/api/auth/login';
      return;
    }

    // Dev mode: the Vite proxy handles mTLS automatically.  If we reach
    // here the backend is probably down or the proxy cert is misconfigured.
    setRetrying(true);
    setRetryFailed(false);
    try {
      const result = await checkAuthStatus();
      if (result) {
        window.location.reload();
      } else {
        setRetryFailed(true);
      }
    } catch {
      setRetryFailed(true);
    } finally {
      setRetrying(false);
    }
  };

  const isLoggedOut = reason === 'logged-out';

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <span className={styles.icon}>{isLoggedOut ? '👋' : '🔒'}</span>
        <h1 className={styles.title}>
          {isLoggedOut ? '已注销' : '需要证书认证'}
        </h1>
        <p className={styles.message}>
          {isLoggedOut
            ? '您已退出登录。请关闭浏览器标签页后重新打开，在证书选择框中选择您的身份证书。'
            : '此应用使用客户端证书进行身份验证。'}
        </p>

        {!isLoggedOut && (
          <div className={styles.instructions}>
            <h2>首次使用 — 导入证书：</h2>
            <ol>
              <li>
                双击 <code>certs/client_zh.p12</code>（或 <code>client_xl.p12</code>），按向导导入（密码 <code>123456</code>）。
              </li>
              <li>
                访问 <code>https://localhost:8000</code>
              </li>
              <li>浏览器弹出证书选择框 → 选择对应证书 → 确认登录。</li>
            </ol>
            <p style={{ marginTop: 12, fontSize: 12, color: 'var(--c-text-muted)' }}>
              提示：首次访问会提示"不安全"，点击"高级 → 继续访问"即可。
            </p>
          </div>
        )}

        <button
          className={styles.retryBtn}
          onClick={handleLogin}
          disabled={retrying}
        >
          {retrying ? (isProduction ? '跳转中…' : '重试中…') : (isProduction ? '证书登录' : '重试')}
        </button>
        {retryFailed && (
          <p className={styles.error}>
            {isProduction
              ? '仍然无法验证。请确认已正确导入客户端证书后重试。'
              : '无法连接后端。请确认后端已启动（python -m app.main）且代理证书配置正确。'}
          </p>
        )}
      </div>
    </div>
  );
}
