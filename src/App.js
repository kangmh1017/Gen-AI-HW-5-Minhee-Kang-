import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import './App.css';

function App() {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem('chatapp_user');
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return typeof parsed === 'string' ? { username: parsed, firstName: '', lastName: '' } : parsed;
    } catch {
      return null;
    }
  });

  const handleLogin = (userData) => {
    const u = typeof userData === 'string' ? { username: userData, firstName: '', lastName: '' } : userData;
    localStorage.setItem('chatapp_user', JSON.stringify(u));
    setUser(u);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (user) {
    return <Chat user={user} onLogout={handleLogout} />;
  }
  return <Auth onLogin={handleLogin} />;
}

export default App;
