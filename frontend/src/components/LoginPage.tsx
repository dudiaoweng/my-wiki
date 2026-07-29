import { useState } from 'react';
import { setStoredDevUser, type DevUser } from '../api/auth';
import styles from './LoginPage.module.css';

const DEV_USERS: DevUser[] = [
  { key: 'zh', displayName: '周衡' },
  { key: 'xl', displayName: '谢林' },
];

interface Props {
  onLogin: () => void;
}

export function LoginPage({ onLogin }: Props) {
  const [selected, setSelected] = useState<string>(DEV_USERS[0]?.key ?? '');

  const handleLogin = () => {
    if (!selected) return;
    const user = DEV_USERS.find((u) => u.key === selected);
    if (!user) return;
    setStoredDevUser(user.key, user.displayName);
    onLogin();
  };

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <span className={styles.icon}>👤</span>
        <h1 className={styles.title}>选择登录用户</h1>
        <p className={styles.subtitle}>开发模式 — Vite 代理将使用对应客户端证书连接后端</p>

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
          onClick={handleLogin}
          disabled={!selected}
        >
          登录
        </button>
      </div>
    </div>
  );
}
