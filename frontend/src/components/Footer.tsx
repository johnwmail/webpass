import { useState, useEffect } from 'preact/hooks';
import { VERSION } from '../lib/version';
import { SessionTimer } from './SessionTimer';

interface Props {
  onSessionExpired?: () => void;
}

type ThemeMode = 'auto' | 'ocean' | 'daylight';

// Get theme based on time of day (8:00-22:00 = daylight, else ocean)
function getAutoTheme(): 'ocean' | 'daylight' {
  const hour = new Date().getHours();
  return (hour >= 8 && hour < 22) ? 'daylight' : 'ocean';
}

export function Footer({ onSessionExpired }: Props) {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    // Load saved mode or default to auto
    const saved = localStorage.getItem('webpass-theme-mode') as ThemeMode;
    return saved || 'auto';
  });

  const [currentTheme, setCurrentTheme] = useState<'ocean' | 'daylight'>(() => {
    // Load saved manual theme or get auto theme
    const saved = localStorage.getItem('webpass-theme');
    if (saved === 'ocean' || saved === 'daylight') return saved;
    return getAutoTheme();
  });

  // Apply theme when mode or auto theme changes
  useEffect(() => {
    let theme: 'ocean' | 'daylight';
    
    if (themeMode === 'auto') {
      theme = getAutoTheme();
    } else {
      theme = themeMode;
    }
    
    setCurrentTheme(theme);
    document.documentElement.setAttribute('data-theme', theme);
    
    if (themeMode !== 'auto') {
      localStorage.setItem('webpass-theme', theme);
    }
    localStorage.setItem('webpass-theme-mode', themeMode);
  }, [themeMode]);

  const toggleTheme = () => {
    setThemeMode(prev => {
      if (prev === 'auto') return 'ocean';
      if (prev === 'ocean') return 'daylight';
      return 'auto';
    });
  };

  return (
    <footer class="app-footer">
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1 }}>
        {onSessionExpired ? <SessionTimer onExpired={onSessionExpired} /> : null}
        <span class="footer-version" title="Frontend version">WebPass {VERSION}</span>
      </div>

      {/* Theme Toggle Button */}
      <button
        class="theme-toggle-btn"
        data-mode={themeMode}
        onClick={toggleTheme}
        title={
          themeMode === 'auto' 
            ? 'Auto theme (Daylight 8AM-10PM, Ocean night) - Click to switch manually' 
            : `Switch to ${themeMode === 'ocean' ? 'Daylight' : 'Auto'} theme`
        }
      >
        {themeMode === 'auto' ? (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42"/>
            </svg>
            <span class="theme-toggle-text">Auto</span>
          </>
        ) : themeMode === 'ocean' ? (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
            <span class="theme-toggle-text">Ocean</span>
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="5"/>
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
            <span class="theme-toggle-text">Daylight</span>
          </>
        )}
      </button>
    </footer>
  );
}
