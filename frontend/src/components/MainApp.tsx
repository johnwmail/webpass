import { useState, useEffect, useCallback } from 'preact/hooks';
import { session } from '../lib/session';
import { TreeView } from './TreeView';
import { EntryDetail } from './EntryDetail';
import { EntryForm } from './EntryForm';
import { GeneratorModal } from './GeneratorModal';
import { EncryptModal } from './EncryptModal';
import { SettingsModal } from './SettingsModal';
import { SessionTimer } from './SessionTimer';
import type { EntryMeta } from '../types';

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

  // Modal state
  const [showGenerator, setShowGenerator] = useState(false);
  const [showEncrypt, setShowEncrypt] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Rename state
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

  // Close context menu on click anywhere
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
    // Get folder from selected path
    let folderPrefix = '';
    if (selectedPath) {
      const parts = selectedPath.split('/');
      // Check if selected is a folder (exists as prefix of other entries)
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
    // Create a new entry with a folder prompt
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
      // For entries, rename just the last part
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
          >
            ☰
          </button>
          <div class="logo">🔐 WebPass</div>
        </div>
        <div class="app-header-right">
          <button class="btn btn-ghost btn-sm" onClick={() => setShowEncrypt(true)} title="Encrypt/Decrypt">
            🔒<span> Encrypt</span>
          </button>
          <button class="btn btn-ghost btn-sm" onClick={() => setShowGenerator(true)} title="Password Generator">
            🎲<span> Generate</span>
          </button>
          <button class="btn btn-ghost btn-icon" onClick={() => setShowSettings(true)} title="Settings">
            ⚙️
          </button>
          <button class="btn btn-ghost btn-icon" onClick={onLock} title="Lock Session">
            🚪
          </button>
        </div>
      </header>

      {/* Body */}
      <div class="app-body">
        {/* Sidebar overlay for mobile */}
        {sidebarOpen && (
          <div class="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside class={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div class="sidebar-search">
            <input
              class="input"
              type="text"
              value={searchQuery}
              onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
              placeholder="🔍 Search entries..."
            />
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
            <button class="btn btn-sm" onClick={handleNewEntry}>+ Entry</button>
            <button class="btn btn-sm" onClick={handleNewFolder}>+ Folder</button>
          </div>
        </aside>

        {/* Content */}
        <main class="content-area">
          {rightPanel.type === 'empty' && (
            <div class="content-empty">
              <span class="icon">🔐</span>
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

      {/* Footer */}
      <footer class="app-footer">
        <SessionTimer onExpired={onLock} />
      </footer>

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
                👁️ View
              </button>
              <button
                class="context-menu-item"
                onClick={() => {
                  setRightPanel({ type: 'edit', path: contextMenu.path });
                  setContextMenu(null);
                }}
              >
                ✏️ Edit
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
                ✐ Rename
              </button>
              <div class="context-menu-separator" />
              <button
                class="context-menu-item danger"
                onClick={() => {
                  handleDeleteEntry(contextMenu.path);
                  setContextMenu(null);
                }}
              >
                🗑️ Delete
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
              + New Entry Here
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
              <button class="btn btn-ghost btn-icon" onClick={() => setRenameTarget(null)}>✕</button>
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
