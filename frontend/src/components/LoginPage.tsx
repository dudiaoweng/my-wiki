import { useState } from 'react';
import { setStoredDevUser, type DevUser } from '../api/auth';
import styles from './LoginPage.module.css';

const isDev = import.meta.env.DEV;

const DEV_USERS: DevUser[] = [
  { key: 'zh', displayName: '周衡' },
  { key: 'xl', displayName: '谢林' },
];

interface Props {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: Props) {
  const [selected, setSelected] = useState<string>(DEV_USERS[0]?.key ?? '');

  const handleDevLogin = () => {
    if (!selected) return;
    const user = DEV_USERS.find((u) => u.key === selected);
    if (!user) return;
    setStoredDevUser(user.key, user.displayName);
    onLogin();
  };

  const handleProdLogin = () => {
    // Port 8000 (CERT_NONE) shows this page without triggering a cert dialog.
    // Navigate to port 8443 (CERT_REQUIRED) — the TLS handshake there
    // triggers the browser's native certificate selection dialog.
    if (window.location.port === '8000') {
      window.location.href = 'https://localhost:8443/api/auth/login';
    } else {
      window.location.href = '/api/auth/login';
    }
  };

  if (!isDev) {
    // Production: just a centered button — no card, no icon, no title.
    return (
      <div className={styles.container}>
        <button className={`${styles.loginBtn} ${styles.prodBtn}`} onClick={handleProdLogin}>
          🔒 证书登录
        </button>
      </div>
    );
  }

  // Dev mode: full user selection UI
  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <span className={styles.icon}>👤</span>
        <h1 className={styles.title}>选择登录用户</h1>
        <p className={styles.subtitle}>
          开发模式 — Vite 代理将使用对应客户端证书连接后端
        </p>
        <div className={styles.userList}>
          {DEV_USERS.map((user) => (
            <label
              key={user.key}
              className={`${styles.userOption} ${selected === user.key ? styles.selected : ''}`}
            >
              <input
                type="radio"
                name="devUser"
                value={user.key}
                checked={selected === user.key}
                onChange={() => setSelected(user.key)}
              />
              <span className={styles.userIcon}>
                {user.displayName.slice(0, 1)}
              </span>
              <span className={styles.userName}>{user.displayName}</span>
            </label>
          ))}
        </div>
        <button
          className={styles.loginBtn}
          onClick={handleDevLogin}
          disabled={!selected}
        >
          登录
        </button>
      </div>
    </div>
  );
}
