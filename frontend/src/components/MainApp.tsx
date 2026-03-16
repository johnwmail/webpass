import { useState, useEffect, useCallback } from 'preact/hooks';
import { session } from '../lib/session';
import { TreeView } from './TreeView';
import { EntryDetail } from './EntryDetail';
import { EntryForm } from './EntryForm';
import { GeneratorModal } from './GeneratorModal';
import { EncryptModal } from './EncryptModal';
import { SettingsModal } from './SettingsModal';
import { SessionTimer } from './SessionTimer';
import { Footer } from './Footer';
import type { EntryMeta } from '../types';
import { Search, Plus, FolderPlus, Settings, LogOut, Lock, Sparkles, Shield } from 'lucide-preact';

interface Props {
  onLock: () => void;
}

type RightPanel =
  | { type: 'empty' }
  | { type: 'detail'; path: string }
  | { type: 'new'; folderPrefix: string }
  | { type: 'edit'; path: string };

interface ContextMenu {
  x: number;
  y: number;
  path: string;
  isFolder: boolean;
}

export function MainApp({ onLock }: Props) {
  const [entries, setEntries] = useState<EntryMeta[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [rightPanel, setRightPanel] = useState<RightPanel>({ type: 'empty' });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);

  const [showGenerator, setShowGenerator] = useState(false);
  const [showEncrypt, setShowEncrypt] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState('');
  const [renameError, setRenameError] = useState('');

  const loadEntries = useCallback(async () => {
    if (!session.api) return;
    try {
      const list = await session.api.listEntries();
      setEntries(list);
    } catch {
      // ignore
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  useEffect(() => {
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, []);

  const handleSelectEntry = (path: string) => {
    setSelectedPath(path);
    setRightPanel({ type: 'detail', path });
    setSidebarOpen(false);
  };

  const handleNewEntry = () => {
    let folderPrefix = '';
    if (selectedPath) {
      const parts = selectedPath.split('/');
      const isFolder = entries.some((e) => e.path.startsWith(selectedPath + '/'));
      if (isFolder) {
        folderPrefix = selectedPath;
      } else {
        folderPrefix = parts.slice(0, -1).join('/');
      }
    }
    setRightPanel({ type: 'new', folderPrefix });
    setSidebarOpen(false);
  };

  const handleNewFolder = () => {
    const folderName = prompt('Enter folder name:');
    if (!folderName) return;
    let prefix = '';
    if (selectedPath) {
      const isFolder = entries.some((e) => e.path.startsWith(selectedPath + '/'));
      if (isFolder) {
        prefix = selectedPath + '/';
      } else {
        const parts = selectedPath.split('/');
        prefix = parts.slice(0, -1).join('/');
        if (prefix) prefix += '/';
      }
    }
    setRightPanel({ type: 'new', folderPrefix: prefix + folderName });
    setSidebarOpen(false);
  };

  const handleContextMenu = (e: MouseEvent, path: string, isFolder: boolean) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, path, isFolder });
  };

  const handleRename = async () => {
    if (!renameTarget || !renameTo.trim() || !session.api) return;
    setRenameError('');
    try {
      const parts = renameTarget.split('/');
      parts[parts.length - 1] = renameTo.trim();
      const newPath = parts.join('/');

      if (renameTarget === newPath) {
        setRenameTarget(null);
        return;
      }

      await session.api.moveEntry(renameTarget, newPath);
      setRenameTarget(null);
      setRenameTo('');
      if (selectedPath === renameTarget) {
        setSelectedPath(newPath);
        setRightPanel({ type: 'detail', path: newPath });
      }
      await loadEntries();
    } catch (e: any) {
      setRenameError(e.message || 'Rename failed');
    }
  };

  const handleDeleteEntry = async (path: string) => {
    if (!session.api) return;
    if (!confirm(`Delete "${path}"?`)) return;
    try {
      await session.api.deleteEntry(path);
      if (selectedPath === path) {
        setSelectedPath(null);
        setRightPanel({ type: 'empty' });
      }
      await loadEntries();
    } catch {
      // ignore
    }
  };

  const handleEntrySaved = async () => {
    setRightPanel({ type: 'empty' });
    setSelectedPath(null);
    await loadEntries();
  };

  const handleEntryDeleted = async () => {
    setSelectedPath(null);
    setRightPanel({ type: 'empty' });
    await loadEntries();
  };

  return (
    <div class="app-layout">
      {/* Header */}
      <header class="app-header">
        <div class="app-header-left">
          <button
            class="btn btn-ghost btn-icon menu-toggle"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            title="Toggle sidebar"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <div class="logo">
            <Shield size={20} />
            WebPass
          </div>
        </div>
        <div class="app-header-right">
          <button class="btn btn-ghost btn-sm" onClick={() => setShowEncrypt(true)} title="Encrypt/Decrypt">
            <Lock size={16} />
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => setShowGenerator(true)} title="Password Generator">
            <Sparkles size={16} />
          </button>
          <button class="btn btn-ghost btn-icon" onClick={() => setShowSettings(true)} title="Settings">
            <Settings size={18} />
          </button>
          <button class="btn btn-ghost btn-icon" onClick={onLock} title="Lock Session">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      {/* Body */}
      <div class="app-body">
        {sidebarOpen && (
          <div class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside class={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div class="sidebar-search">
            <div class="input-with-icon">
              <Search size={16} class="icon-prefix" />
              <input
                class="input"
                type="text"
                value={searchQuery}
                onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
                placeholder="Search entries..."
              />
            </div>
          </div>
          <div class="sidebar-tree">
            {loading ? (
              <div class="loading">
                <span class="spinner" /> Loading...
              </div>
            ) : (
              <TreeView
                entries={entries}
                selectedPath={selectedPath}
                searchQuery={searchQuery}
                onSelect={handleSelectEntry}
                onContextMenu={handleContextMenu}
              />
            )}
          </div>
          <div class="sidebar-actions">
            <button class="btn btn-sm" onClick={handleNewEntry}>
              <Plus size={14} /> Entry
            </button>
            <button class="btn btn-sm" onClick={handleNewFolder}>
              <FolderPlus size={14} /> Folder
            </button>
          </div>
        </aside>

        {/* Content */}
        <main class="content-area">
          {rightPanel.type === 'empty' && (
            <div class="content-empty">
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.3, marginBottom: '16px' }}>
                <rect x="3" y="11" width="18" height="11" rx="2" />
                <circle cx="12" cy="16" r="1" />
                <path d="M7 11V7a5 5 0 0110 0v4" />
              </svg>
              <p>Select an entry or create a new one</p>
            </div>
          )}
          {rightPanel.type === 'detail' && (
            <EntryDetail
              key={rightPanel.path}
              path={rightPanel.path}
              onEdit={() => setRightPanel({ type: 'edit', path: rightPanel.path })}
              onDelete={handleEntryDeleted}
            />
          )}
          {rightPanel.type === 'new' && (
            <EntryForm
              editPath={null}
              folderPrefix={rightPanel.folderPrefix}
              onSave={handleEntrySaved}
              onCancel={() => setRightPanel({ type: 'empty' })}
            />
          )}
          {rightPanel.type === 'edit' && (
            <EntryForm
              key={rightPanel.path}
              editPath={rightPanel.path}
              folderPrefix=""
              onSave={handleEntrySaved}
              onCancel={() => setRightPanel({ type: 'detail', path: rightPanel.path })}
            />
          )}
        </main>
      </div>

      <Footer onSessionExpired={onLock} />

      {/* Context menu */}
      {contextMenu && (
        <div
          class="context-menu"
          style={{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }}
        >
          {!contextMenu.isFolder && (
            <>
              <button
                class="context-menu-item"
                onClick={() => {
                  handleSelectEntry(contextMenu.path);
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                View
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  setRightPanel({ type: 'edit', path: contextMenu.path });
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                Edit
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  const parts = contextMenu.path.split('/');
                  setRenameTo(parts[parts.length - 1]);
                  setRenameTarget(contextMenu.path);
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" /></svg>
                Rename
              </button>
              <div class="context-menu-separator" />
              <button
                class="context-menu-item danger"
                onClick={() => {
                  handleDeleteEntry(contextMenu.path);
                  setContextMenu(null);
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" /></svg>
                Delete
              </button>
            </>
          )}
          {contextMenu.isFolder && (
            <button
              class="context-menu-item"
              onClick={() => {
                setRightPanel({ type: 'new', folderPrefix: contextMenu.path });
                setSidebarOpen(false);
                setContextMenu(null);
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '8px' }}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
              New Entry Here
            </button>
          )}
        </div>
      )}

      {/* Rename dialog */}
      {renameTarget && (
        <div class="modal-overlay" onClick={() => setRenameTarget(null)}>
          <div class="modal" style="max-width: 400px;" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h2>Rename Entry</h2>
              <button class="btn btn-ghost btn-icon" onClick={() => setRenameTarget(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div class="modal-body">
              <div class="field">
                <label class="label">New Name</label>
                <input
                  class="input"
                  type="text"
                  value={renameTo}
                  onInput={(e) => setRenameTo((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRename(); }}
                  autofocus
                />
              </div>
              {renameError && <p class="error-msg">{renameError}</p>}
            </div>
            <div class="modal-footer">
              <button class="btn" onClick={() => setRenameTarget(null)}>Cancel</button>
              <button class="btn btn-primary" onClick={handleRename} disabled={!renameTo.trim()}>Rename</button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {showGenerator && (
        <GeneratorModal onClose={() => setShowGenerator(false)} />
      )}
      {showEncrypt && (
        <EncryptModal onClose={() => setShowEncrypt(false)} />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} onLock={onLock} />
      )}
    </div>
  );
}
