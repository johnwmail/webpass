import { useState, useMemo } from 'preact/hooks';
import type { EntryMeta, TreeNode } from '../types';
import { Folder, FolderOpen, Key } from 'lucide-preact';

interface Props {
  entries: EntryMeta[];
  selectedPath: string | null;
  searchQuery: string;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, isFolder: boolean) => void;
}

function buildTree(entries: EntryMeta[]): TreeNode[] {
  const root: TreeNode[] = [];

  for (const entry of entries) {
    const parts = entry.path.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const pathSoFar = parts.slice(0, i + 1).join('/');
      const isLast = i === parts.length - 1;

      let existing = current.find((n) => n.name === name && n.isFolder === !isLast);
      if (!existing) {
        if (!isLast) {
          existing = current.find((n) => n.name === name && n.isFolder);
        }
      }

      if (!existing) {
        existing = {
          name,
          path: pathSoFar,
          isFolder: !isLast,
          children: [],
        };
        current.push(existing);
      }

      current = existing.children;
    }
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root);
  return root;
}

function filterTree(nodes: TreeNode[], query: string): TreeNode[] {
  if (!query) return nodes;
  const q = query.toLowerCase();

  const filter = (ns: TreeNode[]): TreeNode[] => {
    const result: TreeNode[] = [];
    for (const n of ns) {
      if (n.isFolder) {
        const filteredChildren = filter(n.children);
        if (filteredChildren.length > 0) {
          result.push({ ...n, children: filteredChildren });
        }
      } else {
        if (n.path.toLowerCase().includes(q)) {
          result.push(n);
        }
      }
    }
    return result;
  };

  return filter(nodes);
}

function TreeNodeView({
  node,
  selectedPath,
  expandedFolders,
  toggleFolder,
  onSelect,
  onContextMenu,
  depth,
}: {
  node: TreeNode;
  selectedPath: string | null;
  expandedFolders: Set<string>;
  toggleFolder: (path: string) => void;
  onSelect: (path: string) => void;
  onContextMenu: (e: MouseEvent, path: string, isFolder: boolean) => void;
  depth: number;
}) {
  const isExpanded = expandedFolders.has(node.path);
  const isSelected = !node.isFolder && selectedPath === node.path;

  const handleClick = () => {
    if (node.isFolder) {
      toggleFolder(node.path);
    } else {
      onSelect(node.path);
    }
  };

  const handleContext = (e: MouseEvent) => {
    e.preventDefault();
    onContextMenu(e, node.path, node.isFolder);
  };

  return (
    <div class="tree-node">
      <div
        class={`tree-item ${isSelected ? 'selected' : ''} ${node.isFolder && isExpanded ? 'expanded' : ''}`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
        onClick={handleClick}
        onContextMenu={handleContext}
      >
        {node.isFolder ? (
          <span class="toggle">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </span>
        ) : (
          <span class="toggle" />
        )}
        <span class="icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {node.isFolder ? (
            isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />
          ) : (
            <Key size={14} />
          )}
        </span>
        <span class="name">{node.name}</span>
      </div>
      {node.isFolder && isExpanded && (
        <div class="tree-children">
          {node.children.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function TreeView({ entries, selectedPath, searchQuery, onSelect, onContextMenu }: Props) {
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(entries), [entries]);
  const filtered = useMemo(() => filterTree(tree, searchQuery), [tree, searchQuery]);

  const effectiveExpanded = useMemo(() => {
    if (searchQuery) {
      const all = new Set<string>();
      const collect = (nodes: TreeNode[]) => {
        nodes.forEach((n) => {
          if (n.isFolder) {
            all.add(n.path);
            collect(n.children);
          }
        });
      };
      collect(filtered);
      return all;
    }
    return expandedFolders;
  }, [searchQuery, filtered, expandedFolders]);

  const toggleFolder = (path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  if (filtered.length === 0) {
    return (
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 13px; line-height: 1.6;">
        {entries.length === 0
          ? 'No entries yet.\nCreate one to get started.'
          : 'No entries match your search.'}
      </div>
    );
  }

  return (
    <div>
      {filtered.map((node) => (
        <TreeNodeView
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          expandedFolders={effectiveExpanded}
          toggleFolder={toggleFolder}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          depth={0}
        />
      ))}
    </div>
  );
}
